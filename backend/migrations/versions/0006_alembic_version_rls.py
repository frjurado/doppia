"""Enable Row Level Security on the alembic_version table.

alembic_version was intentionally excluded from migration 0005 due to a
concern that enabling RLS could break future migrations if the runner
connected as a non-owner role. That concern is moot: Alembic connects via
DATABASE_URL as the postgres superuser, and PostgreSQL superusers bypass
RLS entirely regardless of whether any policies are defined.

The Supabase linter flags any public.* table without RLS because PostgREST
exposes it through the auto-generated REST API. Enabling RLS with no
policies is exactly the correct state for alembic_version: invisible to
PostgREST's anon and authenticated roles; fully accessible to Alembic's
superuser connection.

See docs/architecture/security-model.md §6 for the full RLS rationale.

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-10
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE alembic_version ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.execute("ALTER TABLE alembic_version DISABLE ROW LEVEL SECURITY")
