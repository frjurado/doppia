# Roles & Permissions — Phase 2 Design Reference

**Status:** decisions agreed 2026-07-14 (Phase 2 planning); to be implemented
in Phase 2 Component 12 (see `../roadmap/phase-2.md`). This document is the
authoritative reference for the role model, permission patterns, registration
flow, moderation, and data rights. The Phase 1 auth mechanics (Supabase JWT
validation, dev bypass, RLS posture) remain documented in
`security-model.md`; this document extends, and does not replace, them.

---

## 1. Role Model

### Roles

| Role | Granted how | Summary |
|---|---|---|
| **anonymous** | — (no account) | Read-only public surface: approved fragments, corpus browsing, glossary, published blog posts, shared collection links |
| **registered** | Base role of every authenticated account | Everything anonymous can, plus: own collections, import shared collections, attempt exercises, progress dashboard, opt-in reading history, file moderation reports |
| **editor** | Admin grant | Fragment tagging, annotation, peer review (Phase 1 role, unchanged in meaning) |
| **author** | Admin grant | Blog authoring: create, edit own, publish own posts. **Distinct from editor** — writing publication prose and tagging fragments are different competencies and different trust grants |
| **admin** | Admin grant | Corpus management, user/role management, moderation queue, delete approved fragments, edit/unpublish any post |

A future `translator` role is anticipated by ADR-006 (second-language
editorial work); it slots into this model as another grantable role with no
structural change.

### Multi-role: users hold a *set* of roles

Decided: one person can hold several roles at once (e.g. editor + author +
admin). This replaces Phase 1's single `role` column on `app_user`.

- **Storage:** a `user_role` join table rather than an array column, so each
  grant carries an audit trail:

  ```sql
  CREATE TABLE user_role (
      user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,          -- 'editor' | 'author' | 'admin' | ...
      granted_by  UUID REFERENCES app_user(id),
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role)
  );
  ```

  `registered` is implicit in having an account and is **not** stored as a
  row; `anonymous` is the absence of authentication. Role names are constants
  in one module, mirroring the relationship-type-constants convention.

- **Migration:** at the start of Component 12, migrate `app_user.role` into
  `user_role` rows and drop the column. Record as an ADR (extending ADR-001)
  when implemented.

- **`require_role()` semantics become any-of:** `require_role("editor",
  "admin")` passes if the user holds *any* listed role. Existing call sites
  keep working (single-argument calls are unchanged in behaviour).

### Ownership: the second — and only other — permission mechanism

`require_role()` cannot express "the owner of this collection, or an admin".
Decided: one additional sanctioned helper, in the service layer:

```python
async def require_owner_or_role(user, resource, *roles) -> None:
    """Raise ForbiddenError unless user owns resource or holds any of roles."""
```

- `resource` is any ORM object exposing an owner column (`owner_id`,
  `created_by` — the helper takes the attribute name or a small protocol).
- Enforced in services, never inline in route handlers, matching the
  existing invariant's spirit.
- **Invariant update required at implementation time:** `CLAUDE.md` and
  `CONTRIBUTING.md` currently state that `require_role()` is the *only*
  permitted enforcement mechanism. The Phase 2 wording becomes:
  *"`require_role()` and `require_owner_or_role()` are the only permitted
  permission mechanisms — no inline role or ownership checks anywhere else."*

---

## 2. Permission Matrix

The authoritative map of action × role. "Owner" means via
`require_owner_or_role`.

| Action | anonymous | registered | editor | author | admin |
|---|---|---|---|---|---|
| Browse approved fragments (by concept) + fragment detail; glossary | ✓ | ✓ | ✓ | ✓ | ✓ |
| View shared collection (read-only link) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read published blog posts | ✓ | ✓ | ✓ | ✓ | ✓ |
| Register / hold a profile | — | ✓ | ✓ | ✓ | ✓ |
| Create/edit/delete **own** collections; import shared ones | — | ✓ | ✓ | ✓ | ✓ |
| Publish/unpublish share links on **own** collections | — | ✓ | ✓ | ✓ | ✓ |
| Attempt exercises; view own progress | — | ✓ | ✓ | ✓ | ✓ |
| File a moderation report | — | ✓ | ✓ | ✓ | ✓ |
| Export own data / delete own account | — | ✓ | ✓ | ✓ | ✓ |
| Corpus browse + whole-movement score viewer (the tagging surface) | — | — | ✓ | — | ✓ |
| Browse non-approved fragments (own drafts, review queue) | — | — | ✓ | — | ✓ |
| Tag fragments; edit own drafts; submit for review | — | — | ✓ | — | ✓ |
| Review fragments (approve/reject; not own) | — | — | ✓ | — | ✓ |
| Delete own **draft** fragments | — | — | ✓ | — | ✓ |
| Create/edit/publish **own** blog posts | — | — | — | ✓ | ✓ |
| Edit/unpublish **any** blog post | — | — | — | — | ✓ |
| Delete approved fragments | — | — | — | — | ✓ |
| Corpus upload / re-ingestion | — | — | — | — | ✓ |
| Moderation queue (dismiss / unpublish share) | — | — | — | — | ✓ |
| User management (invites, role grants) | — | — | — | — | ✓ |
| Unpublish any shared collection | — | — | — | — | ✓ |

Phase 1 rules preserved unchanged: **editors** cannot review their own
fragments (`SelfReviewForbiddenError`, service-layer check, not a role), but
**admins bypass both the self-review rule and the approval threshold** — a
single admin approval is unconditional. The admin bypass is a deliberate
Phase 1 allowance for the single-user reality; **revisit whether to tighten
it once a second editor is active** (the review-integrity argument for the
editor rule applies equally to admins on a multi-editor team). Status
filtering is enforced at the service layer and cannot be bypassed by direct
API calls; the exercise
distractor/authoring question ("who defines exercise types?") is open until
the Component 15 design session — provisionally admin.

---

## 3. Registration & Authentication Flow

Provider remains Supabase Auth (ADR-001); Phase 2 changes *who* can create
accounts and *how*.

### Decisions (2026-07-14)

- **Methods:** email + password with **mandatory email verification**, plus
  **Google OAuth**. No magic links (a second email-dependent path to support,
  confusing alongside passwords). No other OAuth providers at launch.
- **Default role:** every new account is `registered` only. Editor, author,
  and admin are always explicit admin grants.
- **Invite-only at launch:** registration opens in two stages —
  1. *Invite-only* (from Component 12): admin-issued invites (Supabase invite
     emails). The glossary is anonymous anyway, so the public product is not
     blocked; this gives a moderation-free early period.
  2. *Open registration*: switched on when Collections (Component 13) ship.
     The trigger is a config flag, not a code change.
- **Verification gate:** unverified accounts can log in but cannot create
  content (collections, reports) — verification is a precondition checked in
  the service layer alongside role checks.
- **Session/token storage:** the ADR-016 localStorage exception is scoped to
  Phase 1 and must be resolved (HttpOnly cookie vs full Supabase JS client
  with token refresh) in Component 10, *before* public registration exists.
  See `../roadmap/phase-2-entry-backlog.md` §2.

### Rejected alternatives (for the record)

- *Magic links:* nice UX, second support path, defers rather than removes
  password management. Revisit only on user demand.
- *GitHub/Apple OAuth:* wrong audience fit (students/instructors) for the
  added consent-screen maintenance.
- *Open registration from day one:* costs nothing to stage it; invite-only
  start eliminates the moderation risk window while the moderation tool is
  new.

---

## 4. Moderation (minimal by design)

Shared collections — titles, descriptions, per-entry annotations — are the
first user-generated content visible to strangers. Blog posts are
author-role-gated and need no moderation pipeline.

- **Report action:** any registered user can report a shared collection
  (reason enum + optional free text). One open report per user per resource.

  ```sql
  CREATE TABLE moderation_report (
      id           UUID PRIMARY KEY,
      resource_ref TEXT NOT NULL,          -- 'collection:{id}' (extensible)
      reporter_id  UUID NOT NULL REFERENCES app_user(id),
      reason       TEXT NOT NULL,          -- enum: spam | abuse | copyright | other
      detail       TEXT,
      status       TEXT NOT NULL DEFAULT 'open',  -- open | dismissed | actioned
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_by  UUID REFERENCES app_user(id),
      resolved_at  TIMESTAMPTZ
  );
  ```

- **Admin queue:** a list under the Editorial menu; actions are **dismiss**
  (report closed, no change) or **unpublish share** (collection reverts to
  private; owner keeps it and is notified with the reason). No deletion of
  user content by moderation; no bans in v1 — an admin can revoke
  verification/disable the account via Supabase in egregious cases.
- The `resource_ref` string keeps the table generic for future reportable
  surfaces without migration.

---

## 5. Data Rights (designed at schema time, not retrofitted)

- **Export:** a self-service endpoint producing one JSON document — profile,
  collections (with annotations), exercise history, reading history. No
  editorial content (fragments/reviews belong to the platform record).
- **Deletion:** account deletion
  - *deletes* user-owned content: collections, exercise history, reading
    history, profile, reports filed;
  - *reassigns* editorial contributions (fragments created, reviews given,
    blog posts authored) to a **system user** (`deleted-user`), preserving
    the platform's editorial record and review-integrity history. This rule
    shapes foreign keys — `fragment.created_by` and
    `fragment_review.reviewer_id` must tolerate reassignment, so it is
    decided now, before Component 12 writes the schema.
- **Reading history is opt-in, default off** (per
  `project-architecture.md` § User state).
- Imported (snapshot-copied) collections belong to the importer and are
  unaffected by the source owner's deletion — a side benefit of the
  snapshot-copy decision (see `../roadmap/phase-2.md` Component 13).

---

## 6. Enforcement Summary (implementation checklist)

1. All permission enforcement flows through exactly two service-layer
   helpers: `require_role(*roles)` (any-of) and
   `require_owner_or_role(user, resource, *roles)`.
2. Role names are constants in one module; no magic strings.
3. `registered` is implied by authentication; grants live in `user_role`
   with `granted_by`/`granted_at`.
4. Email-verification status is checked in the service layer for
   content-creating actions.
5. Status filters (`approved`-only for public reads) remain service-layer
   enforced — unchanged Phase 1 invariant.
6. Supabase RLS posture unchanged: default-deny on all tables; every access
   path goes through FastAPI (`security-model.md`).
7. Update `CLAUDE.md` and `CONTRIBUTING.md` invariant wording; record the
   role-model migration as an ADR when implemented.
