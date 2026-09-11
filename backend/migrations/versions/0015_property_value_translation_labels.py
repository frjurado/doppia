"""Add ``short_name`` and ``description`` to ``property_value_translation``.

ADR-039 gave ``PropertyValue`` a context-elided ``short_name`` and a per-value
``description``, and recorded both as untranslated because this table carried
``name`` alone. That was provisional, and the i18n inventory (Component 12
Step 19) made the cost concrete: with the other tables populated in Spanish,
these two fields would be the only English text left inside an otherwise
Spanish property form, which reads as a bug rather than as missing content.

Both columns are nullable, matching the graph: most values have neither. A
value whose translation row leaves them null falls back to the English graph
value, the same fallback the rest of the payload already uses — so this
migration cannot make any existing response worse.

``source_hash`` is not recomputed here. The English rows are rewritten by the
next ``scripts/seed.py --all``, which now hashes all three fields together, so
the baseline corrects itself on the next seed rather than needing a data
migration that would duplicate the hashing rule.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-06
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "property_value_translation",
        sa.Column("short_name", sa.Text(), nullable=True),
    )
    op.add_column(
        "property_value_translation",
        sa.Column("description", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("property_value_translation", "description")
    op.drop_column("property_value_translation", "short_name")
