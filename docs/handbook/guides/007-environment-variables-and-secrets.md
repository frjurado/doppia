# Environment Variables, Secrets, and Multi-Environment Config

## What it is
An environment variable is a named value stored outside your code — in the shell or operating system — that your app reads at startup. Secrets are a subset of these: sensitive values like passwords, API keys, and database credentials.

## What it does
Hardcoding passwords or database URLs directly in source code is dangerous (anyone with repo access sees them) and inflexible (you'd need different code for dev vs. production). Environment variables solve both problems: the code stays the same everywhere, but the values it reads change depending on where it's running.

## How it works

Think of environment variables as sticky notes attached to the room your app runs in. The app asks "what's the database password?" and reads whatever note is on the wall — without caring who put it there.

**In development (local):** Values live in a `.env` file at the project root. This file is listed in `.gitignore` so it's never committed. A copy of all required variable names (with blank or dummy values) is kept in `.env.example` so new developers know what to fill in.

**In staging/production (Fly.io):** Secrets are set via the Fly CLI (`fly secrets set KEY=value`) and injected into the running container. They never touch the filesystem or version control.

**In Docker Compose:** The `docker-compose.yml` file can reference variables from your local `.env` using `${VARIABLE_NAME}` syntax, passing them into containers at startup.

## Example
```bash
# .env (local, never committed)
NEO4J_USER=neo4j
NEO4J_PASSWORD=supersecret

# In Python
import os
password = os.environ["NEO4J_PASSWORD"]
```

The code is identical in every environment. Only the `.env` file (or the platform's secret store) changes.
