"""Seed the ``deleted-user`` system account.

Account deletion *deletes* user-owned content but *reassigns* editorial
contributions — fragments created, reviews given, translations made — so the
platform's editorial and review-integrity record survives someone leaving
(``roles-and-permissions.md`` § 5, ADR-038). That reassignment needs a target,
and it needs the same target in every environment, so the row is seeded by a
migration rather than by a script an operator might not run.

The id is fixed at ``00000000-0000-0000-0000-0000000000ff`` and mirrored in
``models.user.SYSTEM_USER_ID``. It comes from the all-zero block because a real
Supabase user id is a random v4 and can never collide with it; it is
deliberately *not* the nil UUID, which other code is entitled to read as
"unset". The address uses ``.invalid`` (RFC 2606), which can never be
registered, so it cannot collide with a real account either.

The row holds no role grants: it is an attribution target, not an actor, and
nothing should ever authenticate as it.

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-29
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SYSTEM_USER_ID = "00000000-0000-0000-0000-0000000000ff"
_SYSTEM_USER_EMAIL = "deleted-user@doppia.invalid"


def upgrade() -> None:
    op.execute(
        f"""
        INSERT INTO app_user (id, email, display_name)
        VALUES ('{_SYSTEM_USER_ID}', '{_SYSTEM_USER_EMAIL}', 'Deleted user')
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    # Only removable while nothing has been reassigned to it. If a deletion has
    # already happened, the foreign keys will refuse — correctly: dropping the
    # row would orphan the editorial record it was created to preserve.
    op.execute(f"DELETE FROM app_user WHERE id = '{_SYSTEM_USER_ID}'")
