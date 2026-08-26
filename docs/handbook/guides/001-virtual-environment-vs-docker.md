# Virtual Environment vs Docker

## What it is

Both are ways to keep a project's dependencies isolated from the rest of your computer. A **virtual environment** is a lightweight Python-only sandbox; **Docker** is a full container that packages the entire operating system environment alongside the code.

## What it does

When you build software, you inevitably pull in libraries (e.g. "I need version 2.1 of this tool"). The problem: two projects on the same machine can want conflicting versions of the same library. Isolation solves that.

- A **Python virtual environment** (`python -m venv .venv`) creates a private folder that holds its own copy of Python and all installed packages. Only Python is isolated — the database, system tools, and OS are still shared with your machine.
- **Docker** wraps *everything* — Python, the database (Neo4j, PostgreSQL), Redis, and all system-level dependencies — into self-contained containers that run identically on any machine.

## How it works

Think of a virtual environment as a locked drawer inside your desk: you keep your tools in there, separate from your colleague's drawer. Docker is more like renting a separate office: you get your own desk, your own filing cabinet, and your own coffee machine — completely independent.

## In this project

This project uses **both**:
- `python -m venv .venv` — for local development of just the backend Python code (fast iteration, no Docker needed for unit tests).
- `docker compose up` — to spin up the full stack (Neo4j + PostgreSQL + the backend + the frontend) together, matching the production-like environment needed for integration tests.
