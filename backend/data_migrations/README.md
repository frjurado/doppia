# Data Migrations

This directory contains one-off scripts that repair or transform stored fragment *data*.

These are **not** Alembic schema migrations (those live in `backend/migrations/`). Alembic migrations change the PostgreSQL schema (table structure, columns, indexes); nothing here touches the schema.

Two kinds live here:

1. **`summary` schema-version migrations** — transform the *content* of `fragment.summary` records when a breaking change is made to the JSONB schema defined in `docs/architecture/fragment-schema.md`. These follow the naming convention below and pair with a `version` bump.
2. **Value repairs** — fix rows written wrong by a bug that has since been fixed at its source. The schema is unchanged, so there is **no `version` bump**: the shape was always right, the values were not. Named for what they repair (`fix_…`, `clamp_…`), and each script's docstring must state the defect, why it is not a version bump, and that it is idempotent. Current:
   - `fix_summary_key_meter.py` (M6 — key and meter written from the wrong place)
   - `clamp_subpart_bounds.py` (M7 — stage bounds overflowing their parent fragment)
   - `fix_movement_meter.py` (M18 — curated movement meter contradicting the notation)

   **Order matters between these.** `fix_movement_meter.py` corrects the movement record; `fix_summary_key_meter.py` reads it (as the fallback for an unreadable MEI) and writes fragment summaries. Run movement-level repairs before fragment-level ones, or the second pass propagates values the first was about to fix — which is exactly how M18 reached 76 fragments.

Every script here takes `--dry-run`; use it first, read the diff it prints, then run for real.

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
