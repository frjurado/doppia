# ADR-037 — Role-Set Model in PostgreSQL (extends ADR-001)

**Status:** Accepted
**Date:** 2026-08-27
**Extends:** [ADR-001 — Authentication Provider](ADR-001-authentication-provider.md)

---

## Context

ADR-001 chose Supabase Auth and noted that the Phase 1 role model "maps
directly onto Supabase Auth's user metadata fields", expanding in Phase 2 "by
adding values to that metadata field". Phase 2's role design
(`../architecture/roles-and-permissions.md`, decided 2026-07-14) does not fit
that shape, for two reasons that only became visible once the full model was
written down:

1. **A user holds a *set* of roles, not one.** Editor (fragment tagging),
   author (blog prose), and admin are independent competencies and independent
   trust grants; one person can hold any combination. A single metadata string
   cannot express that, and an array in metadata carries no audit trail.
2. **Grants need provenance.** Who granted a role, and when, is
   moderation-relevant information that Component 12's user-management surface
   has to display and that a metadata blob does not record.

A third problem was latent in the Phase 1 implementation. `require_role()` was
a *hierarchy* (`_ROLE_HIERARCHY = {"editor": 1, "admin": 2}`), so
`require_role("editor")` admitted an admin implicitly. The Phase 2 permission
matrix does not work that way: it gives admin every editor capability
explicitly, and deliberately withholds the author-only ones (an admin edits any
post through its own matrix row, not by counting as an author). An implicit
superuser rule would silently grant more than the matrix does.

The Phase 1 mechanics that made metadata workable are also what made it fragile:
`api/middleware/auth.py` read `app_metadata.role` off the token, and
`api/dependencies.py` JIT-upserted that claim into `app_user.role` on every
authenticated request — so the authoritative value lived in Supabase, was
mirrored opportunistically into PostgreSQL, and could only be changed through
the Supabase dashboard.

---

## Decision

**Roles live in PostgreSQL, in a `user_role` join table. The JWT is not
consulted for authorisation.**

1. **Storage.** `user_role (user_id, role, granted_by, granted_at)` with
   composite primary key `(user_id, role)`, `ON DELETE CASCADE` from
   `app_user`. `app_user.role` is dropped (migration `0010`, which copies
   existing `editor`/`admin` values into rows first). RLS is enabled with no
   policies, matching migration 0005.

2. **`registered` is implicit; `anonymous` is the absence of a session.**
   Neither is ever stored. A new account gets no rows at all, so default-deny
   for every capability above reading is a property of the schema rather than a
   rule someone has to remember to apply.

3. **Role names are constants** in `backend/models/roles.py`, mirroring the
   relationship-type-constants convention in `graph/queries/relationships.py`.

4. **Resolution per request.** `get_current_user` loads the caller's role set
   from `user_role` (one indexed primary-key lookup) and attaches it to
   `AppUser.roles`. The auth middleware supplies identity — `sub`, `email`, and
   verification status — and nothing else. The login and refresh routes resolve
   roles the same way, so the SPA's view of its own permissions cannot drift
   from the API's.

5. **`require_role()` becomes any-of, with call sites enumerated.** Every route
   names each role the permission matrix admits: `require_role(EDITOR, ADMIN)`
   for the tagging surface, `require_role(ADMIN)` for corpus and admin
   operations. There is no implicit hierarchy.

6. **`require_owner_or_role()`** joins it as the second — and only other —
   permission mechanism, in the service layer (`services/permissions.py`)
   because an ownership check needs the loaded resource. `require_verified()`
   sits alongside them as a precondition, not a third mechanism.

7. **The dev bypass grants identity only.** `AUTH_MODE=local` resolves roles
   from `user_role` exactly as staging does; `scripts/seed_dev_users.py` grants
   the two dev identities their roles.

Existing `app_metadata.role` values in Supabase are migrated once by `0010`'s
data copy and then ignored. Supabase Auth remains the authentication provider,
unchanged: ADR-001 is extended on authorisation only.

---

## Consequences

**Positive**

- Multi-role users work, with an audit trail per grant.
- Role changes take effect on the next request — no token refresh, no
  re-issued JWT, no Supabase dashboard visit. Revoking a compromised editor is
  a `DELETE` that lands immediately.
- One source of truth. The JIT upsert that kept a mirror of the claim in
  `app_user.role` is gone, and with it the window where the two disagreed.
- The permission matrix is executable: reading `require_role(...)` at a route
  says exactly what the matrix says, with no hierarchy to apply mentally.

**Negative**

- One extra query per authenticated request. It is a primary-key lookup on a
  table with one row per grant; caching is deliberately *not* added until it
  measurably hurts, because a cache reintroduces the staleness this ADR removes.
- The local dev database now needs `seed_dev_users.py` for the dev tokens to be
  useful, not just for FK integrity. Without it the dev editor authenticates and
  is then refused by every role check — a loud failure, but a new one.
- Any-of is stricter than the hierarchy it replaces. A route that names only
  `EDITOR` refuses an admin. That is the intended reading of the matrix, and it
  means adding a capability for admins is an explicit edit at the call site.

**Neutral**

- `AppUser.role: str` becomes `AppUser.roles: frozenset[str]`, and the service
  functions that took `caller_role` / `reviewer_role` take `caller_roles` /
  `reviewer_roles`. Anonymous public reads pass an empty set instead of the
  string `"anonymous"`. The login response carries `roles: string[]` and
  `email_verified` in place of `role`.

---

## Alternatives rejected

**Keep roles in `app_metadata`, as an array.** Retains the dashboard as the only
grant mechanism, carries no `granted_by`/`granted_at`, and leaves role changes
waiting on a token refresh. The audit trail alone rules it out — Component 12
ships a user-management surface that has to show who granted what.

**An array column on `app_user`.** Cheaper to read, but a grant is then not a
row and cannot carry its own provenance; recording who granted which role would
mean a parallel audit table anyway.

**Keep the hierarchy and let admin pass everything.** Convenient, and wrong: the
matrix withholds the author-only capabilities from admin. An implicit superuser
rule would grant them silently, and would have to be reasoned about at every
future call site instead of read off the code.

**Cache the role set per request/session.** Premature. The lookup is a primary-key
hit, and caching would restore exactly the staleness that motivated the move.
Revisit only under measurement.
