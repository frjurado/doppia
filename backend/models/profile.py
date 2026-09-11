"""Pydantic models for the account profile (`/api/v1/users/me`).

``self_declared_role`` is how a user describes themselves and carries **no**
authorisation meaning whatsoever — the granted set lives in ``user_role`` and
reaches the API as ``roles`` (ADR-037). The two never mix: this model exposes
the granted roles read-only, and accepts only the self-reported one.
"""

from __future__ import annotations

from typing import Final, Literal

from pydantic import BaseModel, Field

#: The CHECK vocabulary mirrored from migration 0011. "Prefer not to say" is
#: expressed by leaving the field null rather than by a vocabulary entry.
SelfDeclaredRole = Literal[
    "student",
    "educator",
    "researcher",
    "hobbyist",
    "professional_musician",
    "other",
]

SELF_DECLARED_ROLES: Final[tuple[str, ...]] = (
    "student",
    "educator",
    "researcher",
    "hobbyist",
    "professional_musician",
    "other",
)


class ProfileResponse(BaseModel):
    """The authenticated caller's own account.

    Attributes:
        id: The user's UUID.
        email: The account address (changed through Supabase, not here).
        email_verified: Whether the address is confirmed. Unverified accounts
            can read but not write, including writes to this profile.
        display_name: The name shown on the account menu, or ``None``.
        self_declared_role: The user's own description of themselves, or
            ``None`` if they have not said.
        reading_history_opt_in: Whether visits may be recorded. Default off.
        roles: The granted roles, read-only. Changing these is an admin action
            (Step 10), never a profile edit.
    """

    id: str
    email: str
    email_verified: bool
    display_name: str | None
    self_declared_role: SelfDeclaredRole | None
    reading_history_opt_in: bool
    roles: list[str]


class ProfileUpdateRequest(BaseModel):
    """A partial profile edit.

    Every field is optional and ``None`` is a meaningful value for two of them
    (clearing the display name, withdrawing the self-description), so the
    service distinguishes "not supplied" from "set to null" via
    ``model_fields_set`` rather than by treating ``None`` as absence.

    Attributes:
        display_name: New display name; ``None`` clears it.
        self_declared_role: New self-description; ``None`` clears it.
        reading_history_opt_in: Consent for recording what the user reads.
    """

    display_name: str | None = Field(default=None, max_length=120)
    self_declared_role: SelfDeclaredRole | None = None
    reading_history_opt_in: bool | None = None
