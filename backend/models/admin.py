"""API models for admin user management (Component 12 Step 10).

This is what makes an invite-only launch operable without handing anyone the
Supabase dashboard: list who exists, invite someone, grant and revoke roles.

``roles`` here is the *granted* set from ``user_role`` (ADR-037), never a token
claim and never ``app_user.self_declared_role``, which grants nothing.
"""

from __future__ import annotations

from datetime import datetime

from models.roles import GRANTABLE_ROLES
from pydantic import BaseModel, EmailStr, field_validator


class AdminUserItem(BaseModel):
    """One account as the admin list shows it.

    Attributes:
        id: The account's UUID.
        email: Its address.
        display_name: The name it shows, if it has set one.
        roles: Granted roles, sorted. Empty for a plain registered account.
        created_at: When the row was first seen.
    """

    id: str
    email: str
    display_name: str | None
    roles: list[str]
    created_at: datetime


class AdminUserListResponse(BaseModel):
    """Cursor-paginated account list.

    Attributes:
        items: Accounts, newest first — the useful order for an invite-only
            launch, where the account you just created is the one you want.
        next_cursor: Opaque cursor for the next page, or ``None`` at the end.
    """

    items: list[AdminUserItem]
    next_cursor: str | None


class RoleGrantRequest(BaseModel):
    """A role grant.

    Attributes:
        role: One of :data:`~models.roles.GRANTABLE_ROLES`. ``registered`` is
            implicit in holding an account and is never granted; ``anonymous``
            is the absence of one.
    """

    role: str

    @field_validator("role")
    @classmethod
    def _known_role(cls, value: str) -> str:
        """Reject anything outside the grantable set.

        Args:
            value: The submitted role name.

        Returns:
            The validated role name.

        Raises:
            ValueError: If the role is not grantable.
        """
        if value not in GRANTABLE_ROLES:
            raise ValueError(
                f"'{value}' is not a grantable role "
                f"({', '.join(sorted(GRANTABLE_ROLES))})."
            )
        return value


class InviteRequest(BaseModel):
    """An invitation to create an account.

    Attributes:
        email: Who to invite. Supabase sends the email; the recipient chooses a
            password through the invite link, which is why accepting an invite
            and resetting a password share a route in the SPA.
    """

    email: EmailStr


class InviteResponse(BaseModel):
    """The outcome of issuing an invitation.

    Attributes:
        email: The address invited.
        invited_at: When the invitation was issued.
    """

    email: str
    invited_at: datetime
