# ADR-038 — Data Rights: Export Shape, Deletion Semantics, and the System User

**Status:** Accepted
**Date:** 2026-08-29
**Relates to:** [ADR-037 — Role-Set Model in PostgreSQL](ADR-037-role-model-migration.md),
[`../architecture/roles-and-permissions.md`](../architecture/roles-and-permissions.md) § 5

---

## Context

`roles-and-permissions.md` § 5 settled the *policy* in 2026-07-14: an export
covers profile, collections, exercise history and reading history; deletion
removes user-owned content but reassigns editorial contributions to a system
user. It settled that policy deliberately early — "designed at schema time, not
retrofitted" — because the reassignment rule constrains foreign keys, and a
foreign key is expensive to change once it has data behind it.

Component 12 Steps 8 and 9 implement it. Three things the policy left open had
to be decided before any code could be written, and one of them turned out not
to be a matter of policy at all but of what the schema already says.

**1. What "reassign editorial contributions" concretely means.** The policy
named fragments, reviews and blog posts. The live schema has five foreign keys
into `app_user` that are not user-owned state, and the two the plan did not
name behave differently from each other:

| Column | `ON DELETE` | If nothing is done |
|---|---|---|
| `fragment.created_by` | none (NO ACTION) | the delete is refused |
| `fragment_review.reviewer_id` | `RESTRICT` | the delete is refused |
| `concept_translation.translator_id` | `SET NULL` | the attribution is silently erased |
| `fragment_annotation_translation.translator_id` | `SET NULL` | as above |
| `user_role.granted_by` | none (NO ACTION) | the delete is refused |

**2. Whether the system user is seeded by a migration or a script.**

**3. In which order PostgreSQL and Supabase Auth are touched**, since there is
no transaction spanning them.

---

## Decision

### The export is a registry, not a function

`services/data_export.py` holds a registry of named sections; each is an async
loader `(db, user_id) -> JSON`. Component 12 registers `profile`,
`exercise_history` and `reading_history`. **Component 13 adds collections by
calling `register_section`, not by editing the exporter.**

Registering a name twice raises rather than overwriting: a silent overwrite
would drop a section from every future export, and nothing would fail.

The document carries an `export_version`, a `generated_at`, and the `user_id`.
The version describes the document's *shape* — bump it when a section is added,
removed or restructured; adding rows to an existing section is not a shape
change.

**Editorial content is excluded.** Fragments created and reviews given are the
platform's record, not the account's. This is the same asymmetry as the
deletion rule below, seen from the other side: what deletion refuses to remove
is exactly what export refuses to hand over.

### Deletion reassigns all five columns, not the three that would block it

Every column in the table above is reassigned to the system user before the
account row is deleted. The two `SET NULL` columns are included even though
they would not block anything — nulling them would anonymise an editorial
contribution, which is precisely what the reassignment rule exists to prevent.
Letting a foreign key's default action decide the policy would be an accident,
not a decision.

`user_role.granted_by` is reassigned for a different reason: it is an audit
trail on *other people's* grants. "Granted by an account that no longer exists"
is truer than the `NULL` that means "no known granter".

Everything else pointing at `app_user` is `ON DELETE CASCADE` and goes with the
account: role grants held, exercise sessions and their results, reading
history. Collections and reports filed join that list in Component 13.

### The system user is seeded by a migration

`deleted-user`, `00000000-0000-0000-0000-0000000000ff`,
`deleted-user@doppia.invalid`, seeded by migration `0013` and mirrored in
`models.user.SYSTEM_USER_ID`.

- **A migration, not a script**, because deletion *depends* on the row: an
  environment where an operator forgot to run a seeding script is an
  environment where the first account deletion fails on a foreign key.
- **That id**, because a real Supabase user id is a random v4 and can never
  collide with the all-zero block. It is deliberately **not** the nil UUID,
  which other code is entitled to read as "unset".
- **`.invalid`** (RFC 2606) can never be registered, so the address cannot
  collide with a real account either.
- The row holds **no role grants**. It is an attribution target, not an actor;
  nothing should ever authenticate as it. Deleting it is refused outright —
  removing the reassignment target would orphan every contribution already
  pointed at it.

### PostgreSQL commits first; Supabase Auth is deleted after

The two stores cannot share a transaction, so one of them is exposed. The
choice is asymmetric and it is not close:

- **Auth user survives, application data gone** (our order, on failure): the
  account can no longer sign in to anything meaningful, and an admin can remove
  it. Recoverable.
- **Application data survives, auth user gone** (the other order): a row nobody
  can reach, that its owner can no longer ask to have deleted. Not recoverable
  through any user-facing path.

The Supabase call treats a 404 as success, so a retry after a partial failure
completes rather than erroring. A missing `SUPABASE_SERVICE_ROLE_KEY` is a
visible 503, never a silent skip — a deletion that quietly left the auth user
alive would be worse than a failure the caller can see.

### Permissions

Deletion goes through `require_owner_or_role(caller, row, ADMIN,
owner_attr="id")` — the account is its own owner. `DELETE /api/v1/users/me`
passes the caller's own id, so the ownership branch is what admits it; the
admin branch is what will admit Component 12 Step 10's admin surface, reusing
the same service function rather than a parallel one.

Neither export nor deletion is verification-gated. They are data rights;
withholding someone's own data, or refusing to let them leave, because they
have not confirmed an email address would be a strange reading of them.

### For Component 13 to inherit

- `collection` / `collection_fragment` are created in Component 13, but their
  FK shape is settled here: user-owned, `ON DELETE CASCADE` from `app_user`.
- **A snapshot-imported collection belongs to the importer** and is unaffected
  by the source owner's deletion (`roles-and-permissions.md` § 5) — a
  consequence of the snapshot-copy decision, and the reason imports must copy
  rather than reference.
- Collections register an export section; they do not edit the exporter.

---

## Consequences

**Positive**

- The corpus's provenance and the review-integrity history survive people
  leaving, which is what makes `SelfReviewForbiddenError` meaningful over time.
- The export grows by registration, so Component 13 touches one call site
  instead of the exporter's body.
- The failure mode of a half-completed deletion is a state an admin can finish,
  not one nobody can.

**Negative / accepted**

- `deleted-user` accumulates contributions from every departed account, so
  "who wrote this" becomes unanswerable for them. That is the intended trade:
  the alternative is losing the contribution itself.
- A user who deletes their account and then signs in again before the Supabase
  deletion has landed will have a fresh, empty `app_user` row created by the
  JIT upsert. Their data is still gone; the account merely reappears empty.
  Acceptable, and only reachable in the failure window.
- The export is assembled in memory and returned in one response. Fine at
  per-user scale; if a user's history ever outgrows that, the fix is streaming,
  not a change of shape.

---

## Alternatives Considered

**Delete editorial contributions along with the account.** Rejected: it
rewrites the corpus's provenance and destroys the review record that fragment
approval depends on. The `RESTRICT` on `fragment_review.reviewer_id` was
already saying this; the reassignment path is what it was waiting for.

**Anonymise in place — set the columns to `NULL`.** Rejected: `NULL` means "no
attribution recorded", which is a different and less true statement than "the
account that made this no longer exists". Two of the five columns would have
done this by default, which is why they are reassigned explicitly.

**Soft-delete the account (a `deleted_at` flag).** Rejected: it is not
deletion. Keeping the row keeps the personal data, which is the thing the right
is about.

**Tombstone the user with a per-user placeholder row** rather than one shared
system user. Rejected as unnecessary: nothing needs to distinguish one departed
contributor from another, and a per-user tombstone retains an identifier the
deletion was supposed to remove.
