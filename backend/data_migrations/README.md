# Data Migrations

This directory contains per-version data migration scripts for the `fragment.summary` JSONB field.

These are **not** Alembic schema migrations (those live in `backend/migrations/`). Alembic migrations change the PostgreSQL schema (table structure, columns, indexes). Data migrations here transform the *content* of `fragment.summary` records when a breaking change is made to the `summary` JSONB schema defined in `docs/architecture/fragment-schema.md`.

## When to write a data migration here

Per the versioning policy in `fragment-schema.md`:

> When any breaking change is made: increment `version`, write a migration script in `backend/data_migrations/`, update this document, and run the migration in staging before production.

A **breaking change** to the `summary` JSONB schema is any of the following:

- Renaming a field
- Removing a field
- Changing a field's type or structure
- Restructuring the hierarchy

Adding new optional top-level fields is safe without a migration, provided existing consumers ignore unknown fields.

## Naming convention

```
v{N}_to_v{N+1}_{short_description}.py
```

Example: `v1_to_v2_add_repeat_context.py`

## Running a migration

Each script is standalone and can be run directly:

```bash
cd backend
source .venv/bin/activate
python data_migrations/v1_to_v2_add_repeat_context.py
```

Scripts must be idempotent: running them more than once must produce the same result as running them once. Always run in staging before production.
