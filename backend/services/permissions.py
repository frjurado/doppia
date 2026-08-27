"""Service-layer permission helpers.

Two mechanisms enforce permissions in this codebase and no others:

* ``require_role()`` (``api/dependencies.py``) — a route dependency, because a
  role check needs nothing but the caller.
* ``require_owner_or_role()`` (here) — a service-layer function, because an
  ownership check needs the loaded resource, which routes do not have.

The split is by design, not by accident (``docs/architecture/roles-and-permissions.md``
§ 1). ``require_verified()`` joins them as a *precondition* rather than a third
mechanism: it asks whether the account may create content at all, before the
question of which roles it holds.

No inline role or ownership checks anywhere else. See CONTRIBUTING.md § Invariants.
"""

from __future__ import annotations

from typing import Any, Protocol

from errors import AuthorizationError, EmailNotVerifiedError


class _Caller(Protocol):
    """The subset of ``api.dependencies.AppUser`` these helpers read.

    Declared structurally so the service layer does not import the API layer.
    """

    id: str
    roles: frozenset[str]
    email_verified: bool


def require_owner_or_role(
    user: _Caller,
    resource: Any,
    *roles: str,
    owner_attr: str = "owner_id",
) -> None:
    """Assert that the caller owns ``resource`` or holds any of ``roles``.

    Ownership is compared as strings so a ``UUID`` column and the token's string
    ``sub`` compare equal. A resource whose owner column is ``NULL`` has no
    owner, and only the listed roles pass.

    Args:
        user: The authenticated caller.
        resource: Any ORM object exposing an owner column.
        *roles: Role names that pass regardless of ownership, from
            :mod:`models.roles`.
        owner_attr: Name of the owner column on ``resource`` — ``owner_id`` for
            user-owned content, ``created_by`` for editorial records.

    Raises:
        AuthorizationError: If the caller neither owns the resource nor holds
            one of the roles.
        AttributeError: If ``resource`` has no ``owner_attr`` attribute — a
            programming error, surfaced loudly rather than defaulting to deny.
    """
    owner = getattr(resource, owner_attr)
    if owner is not None and str(owner) == user.id:
        return
    if frozenset(roles) & user.roles:
        return
    raise AuthorizationError(
        "You do not own this resource and lack the required role.",
        detail={
            "resource": type(resource).__name__,
            "required_roles": sorted(roles),
            "caller_roles": sorted(user.roles),
        },
    )


def require_verified(user: _Caller) -> None:
    """Assert that the caller's email address is confirmed.

    Checked alongside role checks for every content-creating action: an
    unverified account can log in and read, but cannot write
    (``roles-and-permissions.md`` § 3).

    Args:
        user: The authenticated caller.

    Raises:
        EmailNotVerifiedError: If the address has not been confirmed.
    """
    if not user.email_verified:
        raise EmailNotVerifiedError(
            "Confirm your email address before creating content.",
            detail={"email": getattr(user, "email", "")},
        )
