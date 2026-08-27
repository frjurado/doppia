"""Seed synthetic dev users and their role grants for local development.

Inserts the two hardcoded dev identities from ``api/middleware/auth.py``
into ``app_user`` so that ``fragment.created_by`` and
``fragment_review.reviewer_id`` FK constraints pass without a real Supabase
Auth user, and grants each one its role in ``user_role``.

The grants are not optional decoration: since ADR-037 the dev bypass supplies
an identity only, and ``get_current_user`` resolves roles from ``user_role`` on
the local path exactly as it does in staging. Without this script the dev
editor authenticates and is then refused by every ``require_role`` check.

``granted_by`` is NULL — these are system grants with no granting admin.

Safe to re-run: both inserts use ``ON CONFLICT ... DO NOTHING``.

Usage::

    cd backend
    python scripts/seed_dev_users.py

Reads ``DATABASE_URL`` from the environment or the repo-root ``.env`` file.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Ensure backend package is importable when run from project root or backend/.
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv(Path(__file__).parent.parent.parent / ".env")

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_DEV_USERS = [
    ("00000000-0000-0000-0000-000000000001", "dev@local", "editor"),
    ("00000000-0000-0000-0000-000000000002", "admin@local", "admin"),
]


async def seed() -> None:
    """Insert dev users and their role grants, skipping rows that already exist."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        sys.exit(1)

    engine = create_async_engine(
        database_url,
        echo=False,
        connect_args={"statement_cache_size": 0},
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with factory() as session:
            await session.execute(
                text(
                    "INSERT INTO app_user (id, email) VALUES "
                    "(:id1, :email1), "
                    "(:id2, :email2) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {
                    "id1": _DEV_USERS[0][0],
                    "email1": _DEV_USERS[0][1],
                    "id2": _DEV_USERS[1][0],
                    "email2": _DEV_USERS[1][1],
                },
            )
            await session.execute(
                text(
                    "INSERT INTO user_role (user_id, role) VALUES "
                    "(:id1, :role1), "
                    "(:id2, :role2) "
                    "ON CONFLICT (user_id, role) DO NOTHING"
                ),
                {
                    "id1": _DEV_USERS[0][0],
                    "role1": _DEV_USERS[0][2],
                    "id2": _DEV_USERS[1][0],
                    "role2": _DEV_USERS[1][2],
                },
            )
            await session.commit()
        print("Dev users and role grants seeded (or already present).")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
