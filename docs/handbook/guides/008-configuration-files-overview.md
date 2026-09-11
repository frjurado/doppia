# Configuration Files: What They Are and What They Do

## What it is

Configuration files are plain-text files that tell tools — formatters, test runners, deployment platforms, container engines — how to behave. Instead of passing a long list of options on the command line every time, you write them once in a file and they apply automatically.

## What it does

Each file in this project configures a different tool or layer of the stack:

- **`pyproject.toml`** — the central config for Python tooling. It tells Black how wide lines should be, tells isort how to sort imports, tells Ruff which lint rules to enforce, and tells pytest where to find tests and how to run async code. One file, four tools.

- **`docker-compose.yml`** — describes the local development infrastructure. It defines which services to run (Neo4j, PostgreSQL, Redis, MinIO), how they connect to each other, what environment variables they need, and what ports to expose on your machine. Think of it as a recipe: "start these containers, in this order, with these settings."

- **`fly.toml`** — tells [Fly.io](https://fly.io) (the hosting platform) how to deploy the backend to staging. It specifies which Dockerfile to build, what environment variables to set, how much memory to allocate, and how to check if the app is healthy after each deploy.

## How it works

Think of each config file as a contract between you and a tool. The tool reads the file at startup and applies whatever it finds there. If the file doesn't exist, the tool falls back to defaults — which may not be what you want. If the file has a typo, the tool usually tells you on the spot.

The layering mirrors the stack itself: `pyproject.toml` governs your code quality locally, `docker-compose.yml` governs your local runtime environment, and `fly.toml` governs what actually runs in the cloud.
