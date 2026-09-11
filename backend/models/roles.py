"""Canonical role names and the grantable role vocabulary.

Roles are stored as rows in ``user_role`` (one row per grant) and are compared
as strings throughout the application. This module is the single source of
those strings, mirroring the relationship-type-constants convention in
``backend/graph/queries/relationships.py``: no role literal appears anywhere
else in application code.

Two roles are deliberately *not* constants of the storable kind:

* ``registered`` is implicit in holding an account — every authenticated caller
  has it, and it is never written to ``user_role``. It exists here only so the
  permission matrix in ``docs/architecture/roles-and-permissions.md`` § 2 can be
  named in code and docs.
* ``anonymous`` is the absence of authentication: an empty role set. There is no
  constant for it — code tests ``if user is None`` or an empty set, never a
  magic string.

See ``docs/architecture/roles-and-permissions.md`` § 1 and ADR-037.
"""

from __future__ import annotations

from typing import Final

#: Fragment tagging, annotation, and peer review (the Phase 1 role, unchanged).
EDITOR: Final[str] = "editor"

#: Blog authoring — deliberately distinct from :data:`EDITOR` (Component 16).
AUTHOR: Final[str] = "author"

#: Corpus management, user/role management, moderation.
ADMIN: Final[str] = "admin"

#: Roles that can be granted by an admin and stored in ``user_role``.
#: ``registered`` is implicit and ``anonymous`` is the absence of a session, so
#: neither appears here. A future ``translator`` role (ADR-006) is added here.
GRANTABLE_ROLES: Final[frozenset[str]] = frozenset({EDITOR, AUTHOR, ADMIN})
