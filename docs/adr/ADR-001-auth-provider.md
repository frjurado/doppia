# ADR-001 — Authentication Provider

**Status:** Accepted
**Date:** 2026-03-27

---

## Context

Phase 1 requires authentication before any public users exist. The tagging tool must be restricted to authorised annotators (`editor` role) and administrators (`admin` role). Two roles are sufficient for Phase 1; the full role model (`anonymous visitor`, `registered user`, `editor`, `admin`) is deferred to Phase 2.

The requirements for Phase 1 auth are minimal but the implementation must be forward-compatible with Phase 2's full role model:

- JWT-based authentication validated in FastAPI middleware
- Email/password login; OAuth optional
- Account creation by admin only (no public registration in Phase 1)
- Role information carried in the JWT or resolvable from it at request time

The two realistic options are **Auth0** and **Supabase Auth**.

**Auth0** is a dedicated identity platform with a generous free tier, extensive documentation, and support for complex role and permission models. It is independent of any other infrastructure choice.

**Supabase Auth** is the authentication layer built into Supabase. It provides email/password and OAuth flows, issues JWTs, and stores user records in the same PostgreSQL instance used for application data. It is not an independent service — it is a feature of Supabase.

The prior decision (see `tech-stack-and-database-reference.md`) is to use **Supabase** as the managed PostgreSQL host for the fragment database and user infrastructure. Supabase Auth is therefore available at no additional cost or operational overhead if Supabase is already in the stack.

---

## Decision

Use **Supabase Auth**.

Supabase Auth is tightly integrated with the Supabase PostgreSQL instance already chosen for the relational database. Choosing it eliminates Auth0 as a third managed service to configure, credential, monitor, and reason about. The JWTs it issues can be validated in FastAPI middleware using the Supabase JWT secret, and user role information is stored in the same PostgreSQL instance alongside application data — no cross-service lookup is required to resolve a user's role.

The Phase 1 role model (`editor`, `admin`) maps directly onto Supabase Auth's user metadata fields. When Phase 2 adds `registered user` and `anonymous visitor`, the role model expands by adding values to that metadata field, not by migrating to a different auth system.

---

## Consequences

**Positive**

- No additional managed service. Supabase Auth is already present given the Supabase PostgreSQL decision.
- User records and role assignments live in the same PostgreSQL instance as the `app_user` table, making joins trivial and keeping the data model coherent.
- Supabase Auth's dashboard provides a UI for creating and managing users, which is the only user management interface needed in Phase 1 (no public registration, no self-service password reset UI to build).
- JWT validation in FastAPI is straightforward: verify the token signature using the Supabase JWT secret, extract the user id and role from claims.

**Negative**

- Supabase Auth is less feature-rich than Auth0 for complex enterprise identity scenarios (SAML, advanced MFA policies, organisation-level tenancy). None of these are needed now, but migrating away from Supabase Auth later would require re-issuing tokens to all users.
- The local development stack must replicate Supabase Auth behaviour. The solution is the `AUTH_MODE=local` bypass documented in the README: when `ENVIRONMENT=local`, the backend accepts a fixed development token. This is a small but real divergence from production behaviour that must be kept inert outside development.

**Neutral**

- The `app_user` table in PostgreSQL mirrors the subset of Supabase Auth user fields needed by the application (id, email, display name, role). Supabase Auth is the source of truth for authentication; the application table is the source of truth for application-level attributes. This is the standard Supabase pattern.

---

## Alternatives considered

**Auth0.** Rejected because it adds a third managed service to the production stack without providing capabilities that Supabase Auth lacks at this project's scale and requirements. The configurability advantage of Auth0 is not needed in Phase 1 or Phase 2 as currently scoped.

**Custom JWT implementation.** Rejected unconditionally. Building authentication from scratch is a security liability and an ongoing maintenance burden with no upside over a managed service. Not reconsidered.
