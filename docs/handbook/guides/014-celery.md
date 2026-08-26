# Celery: Running Slow Work in the Background

## What it is

**Celery** is a Python library for running tasks asynchronously — meaning you hand off a job to a background worker and your web server immediately returns a response, without waiting for the job to finish.

## What it does

Some operations are too slow to run inside a web request: generating a PDF, sending a batch of emails, processing an audio file, or re-rendering dozens of music scores. If a user clicks a button and your server spends 30 seconds doing heavy work before replying, the browser times out and the experience feels broken. Celery solves this by moving that work out of the request cycle entirely. The server says "got it, working on it" right away, and a separate worker process does the actual work in the background.

## How it works

Celery uses a **message broker** (typically Redis or RabbitMQ) as a middleman — think of it as a shared to-do list. When your web server wants to offload a task, it writes a message to the broker ("please do X with these inputs"). One or more Celery worker processes are running separately, watching that list. A worker picks up the message, does the work, and optionally stores the result somewhere the web server can retrieve later.

## Example

In this project, Redis is already in the stack (see `docker-compose.yml`). If a future feature needed to re-ingest and re-normalize a batch of MEI files after an edit, that could be dispatched as a Celery task — the API responds instantly, and the worker processes each file in the background without blocking any user requests.
