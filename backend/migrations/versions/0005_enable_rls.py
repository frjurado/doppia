"""Enable Row Level Security on all public application tables.

PostgREST (Supabase's built-in REST API) exposes every table in the
public schema to the anon role by default. The Supabase anon key is
embedded in the frontend bundle, so any visitor can extract it and
query application tables directly — bypassing FastAPI, its JWT
middleware, and require_role() entirely.

Enabling RLS with no explicit policies creates a default-deny for all
connections that are not the table owner (the postgres superuser that
FastAPI uses). PostgREST's anon and authenticated roles are denied;
the FastAPI application is unaffected.

This migration must run before any staging deployment.
See docs/architecture/security-model.md §6 for the full rationale.

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-05
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# All application tables in the public schema as of migration 0004.
# alembic_version is deferred to migration 0006: enabling RLS on an Alembic
# internal table in the same migration that first runs Alembic against the
# schema was considered overly risky at the time. Migration 0006 adds RLS
# to alembic_version once the superuser-bypass property was confirmed.
_TABLES = [
    "app_user",
    "composer",
    "corpus",
    "work",
    "movement",
    "movement_analysis",
    "fragment",
    "fragment_concept_tag",
    "fragment_review",
    "fragment_annotation_translation",
    "prose_chunk",
    "concept_translation",
    "property_schema_translation",
    "property_value_translation",
]


def upgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
