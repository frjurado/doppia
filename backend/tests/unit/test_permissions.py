"""Unit tests for the service-layer permission helpers (Component 12 Step 2).

``require_owner_or_role`` is the second — and only other — sanctioned permission
mechanism alongside ``require_role`` (``docs/architecture/roles-and-permissions.md``
§ 1). It is a pure function over a caller and a resource, so it needs no database.

Its first production consumers arrive with collections in Component 13; these
tests pin the semantics before anything depends on them.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from errors import AuthorizationError
from models.roles import ADMIN, EDITOR
from services.permissions import require_owner_or_role

_OWNER_ID = "11111111-1111-4111-8111-111111111111"
_OTHER_ID = "22222222-2222-4222-8222-222222222222"


@dataclass
class _Caller:
    """Stand-in for ``api.dependencies.AppUser`` (the helpers take a protocol)."""

    id: str
    roles: frozenset[str] = frozenset()
    email: str = "user@test.com"


@dataclass
class _Collection:
    """A user-owned resource, the shape Component 13 will pass."""

    owner_id: str | None


@dataclass
class _Fragment:
    """An editorial resource, whose owner column is named ``created_by``."""

    created_by: str | None


class TestRequireOwnerOrRole:
    def test_owner_passes_without_any_role(self) -> None:
        """A plain registered user reaches their own resource."""
        require_owner_or_role(_Caller(id=_OWNER_ID), _Collection(_OWNER_ID), ADMIN)

    def test_non_owner_with_listed_role_passes(self) -> None:
        """An admin reaches a resource owned by someone else."""
        require_owner_or_role(
            _Caller(id=_OTHER_ID, roles=frozenset({ADMIN})),
            _Collection(_OWNER_ID),
            ADMIN,
        )

    def test_non_owner_without_listed_role_is_refused(self) -> None:
        """Holding *a* role is not enough — it must be one of the listed ones."""
        with pytest.raises(AuthorizationError) as exc:
            require_owner_or_role(
                _Caller(id=_OTHER_ID, roles=frozenset({EDITOR})),
                _Collection(_OWNER_ID),
                ADMIN,
            )
        assert exc.value.detail["required_roles"] == [ADMIN]
        assert exc.value.detail["caller_roles"] == [EDITOR]

    def test_ownerless_resource_admits_only_the_listed_roles(self) -> None:
        """A NULL owner column is not a wildcard that matches every caller."""
        with pytest.raises(AuthorizationError):
            require_owner_or_role(_Caller(id=_OWNER_ID), _Collection(None), ADMIN)
        require_owner_or_role(
            _Caller(id=_OWNER_ID, roles=frozenset({ADMIN})), _Collection(None), ADMIN
        )

    def test_owner_attr_selects_the_column(self) -> None:
        """Editorial records name their owner ``created_by``, not ``owner_id``."""
        require_owner_or_role(
            _Caller(id=_OWNER_ID),
            _Fragment(created_by=_OWNER_ID),
            ADMIN,
            owner_attr="created_by",
        )

    def test_uuid_owner_compares_equal_to_the_string_sub(self) -> None:
        """The token's ``sub`` is a string; the ORM column is a UUID."""
        import uuid

        require_owner_or_role(
            _Caller(id=_OWNER_ID), _Collection(uuid.UUID(_OWNER_ID)), ADMIN
        )

    def test_no_roles_listed_leaves_ownership_as_the_only_route(self) -> None:
        """``require_owner_or_role(user, resource)`` is an owner-only check."""
        require_owner_or_role(_Caller(id=_OWNER_ID), _Collection(_OWNER_ID))
        with pytest.raises(AuthorizationError):
            require_owner_or_role(
                _Caller(id=_OTHER_ID, roles=frozenset({ADMIN})), _Collection(_OWNER_ID)
            )
