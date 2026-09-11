# Why Separate Development and Production Dependencies

## What it is

A project's dependencies are all the external packages it needs to run. Separating them means keeping two lists: one for everything needed in production, and one that adds extra tools only needed during development.

## What it does

In production — the live, deployed version of the app — you only want what's strictly necessary to run the software. Shipping extra tools bloats the container, increases the attack surface (more packages = more potential vulnerabilities), and slows down deployments. Development tools like test runners, code formatters, and linters have no business being on a production server.

## How it works

Think of it like packing for a trip. You pack clothes to wear (production). You don't pack your iron, lint roller, and sewing kit just because you use them at home (dev tools) — they stay behind.

In this project:

- `requirements.txt` — the "trip bag": only what the API needs to run (FastAPI, database drivers, etc.)
- `requirements-dev.txt` — everything, including the home tools: testing libraries (`pytest`), formatters (`black`, `ruff`), and so on.

`requirements-dev.txt` typically starts with `-r requirements.txt` to include all production deps automatically, so you only need to install one file locally.

## Example

```bash
# Local development — installs everything
pip install -r requirements-dev.txt

# Docker / production — installs only what's needed to run
pip install -r requirements.txt
```

This keeps the production image lean and the development environment fully equipped — without mixing the two.
