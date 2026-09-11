/**
 * Canonical role names — the frontend mirror of `backend/models/roles.py`.
 *
 * Roles are grants stored as `user_role` rows and compared as strings. This
 * module is the single source of those strings on this side of the wire, for
 * the same reason the backend module is on its side: no role literal should
 * appear anywhere else.
 *
 * `registered` is implicit in holding an account and is never stored, and
 * `anonymous` is the absence of a session — neither has a constant, here or on
 * the backend. See `docs/architecture/roles-and-permissions.md` § 1 / ADR-037.
 *
 * Nothing here is a permission boundary. Roles are enforced by the API on every
 * call; the frontend reads them only to decide what to *offer*.
 */

/** Fragment tagging, annotation, and peer review. */
export const EDITOR = 'editor';

/** Blog authoring — deliberately distinct from {@link EDITOR} (Component 16). */
export const AUTHOR = 'author';

/** Corpus management, user/role management, moderation. */
export const ADMIN = 'admin';

/** Roles an admin can grant, mirroring the backend's `GRANTABLE_ROLES`. */
export const GRANTABLE_ROLES = [EDITOR, AUTHOR, ADMIN] as const;

export type Role = (typeof GRANTABLE_ROLES)[number];

/**
 * The roles that reach the Editorial surfaces.
 *
 * Admin holds every editorial capability (the permission matrix, § 2), so it is
 * enumerated rather than implied: an admin-passes-everything rule would also
 * silently grant the author-only capabilities, which the matrix does not do.
 * This is the frontend counterpart of `require_role(EDITOR, ADMIN)`.
 */
export const EDITORIAL_ROLES: readonly string[] = [EDITOR, ADMIN];
