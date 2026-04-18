"""Alembic migration environment configuration.

Reads DATABASE_URL from the environment, converts the async asyncpg DSN to a
synchronous psycopg2 DSN (Alembic's runner is sync), and wires the SQLAlchemy
declarative Base so that autogenerate can detect schema drift.

All ORM model modules must be imported here so that their table definitions
are registered on Base.metadata before Alembic compares against the DB.
"""

from __future__ import annotations

import os
import re
from logging.config import fileConfig
from pathlib import Path

from dotenv import load_dotenv

# Load .env from repo root when running alembic from the backend/ directory.
# No-op if the variables are already set in the environment.
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from alembic import context
from sqlalchemy import engine_from_config, pool

from models.base import Base

# Import all ORM models so they register their tables on Base.metadata.
# These imports have no other effect; they are purely for side-effect
# registration on the declarative base.
import models.user  # noqa: F401
import models.music  # noqa: F401
import models.fragment  # noqa: F401
import models.analysis  # noqa: F401

# Alembic Config object — gives access to values in alembic.ini.
config = context.config

# Wire up Python logging from alembic.ini [loggers] section.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _get_sync_url() -> str:
    """Return a synchronous psycopg2 DSN derived from DATABASE_URL.

    Alembic's run_migrations_online uses a synchronous engine. The application
    uses ``postgresql+asyncpg://`` for its async engine, but psycopg2-binary
    (installed as a dev/migration dependency) provides the sync driver that
    Alembic needs. We simply swap the driver prefix.

    Raises:
        KeyError: If DATABASE_URL is not set in the environment.
    """
    url = os.environ["DATABASE_URL"]
    return re.sub(r"^postgresql\+asyncpg://", "postgresql://", url)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    In offline mode Alembic emits SQL statements to stdout rather than
    connecting to a live database. Useful for generating migration scripts
    to review or apply manually.
    """
    url = _get_sync_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode against a live database connection."""
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = _get_sync_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
