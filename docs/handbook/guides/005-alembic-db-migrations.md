# Database Migrations with Alembic

## What it is
Alembic is a migration tool for SQL databases. It tracks and applies changes to your database schema (tables, columns, indexes) over time.

## What it does
When you're building an app, your database structure evolves — you add a column here, rename a table there. The problem is that the database doesn't automatically know about those changes; you have to tell it. Alembic solves this by keeping a history of every structural change as a series of numbered scripts called **migrations**. When you deploy a new version of the app, Alembic runs only the migrations that haven't been applied yet, bringing the database up to date.

Without something like Alembic, every developer (and every server) would need to manually run raw SQL to keep their database in sync with the code — a fragile, error-prone process.

## How it works
Think of it like version control (git) for your database schema. Each migration is a small Python file with two functions: `upgrade()` (what to change) and `downgrade()` (how to undo it). Alembic records which migrations have already run in a special table called `alembic_version`. When you run `alembic upgrade head`, it checks that table, finds any unapplied migrations, and runs them in order.

## Example
You add a `bio` column to the `users` table in your SQLAlchemy model. You then run:

```bash
alembic revision --autogenerate -m "add bio to users"
alembic upgrade head
```

The first command generates a migration file based on the difference between your model and the current database. The second applies it, adding the column to the actual database.

In this project, SQLAlchemy models live in `backend/models/` and migrations are managed alongside them.
