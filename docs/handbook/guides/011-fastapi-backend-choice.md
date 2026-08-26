# FastAPI: Why It Powers This Backend

## What it is
FastAPI is a Python web framework for building APIs — the layer that receives HTTP requests (from the frontend or other services) and sends back responses.

## What it does
It handles the plumbing of a web server: routing incoming requests to the right function, parsing request bodies, validating input, and formatting responses. What makes FastAPI stand out is that it does all of this with very little boilerplate, and it leans heavily on Python's type hints to do so — meaning the same annotations that make your code readable also drive validation and documentation automatically.

## How it works
Think of FastAPI as a traffic director. You write a Python function and tell FastAPI "when someone sends a POST request to `/api/v1/fragments`, run this function." FastAPI takes care of the rest: it checks that the incoming data is valid (using Pydantic under the hood), calls your function, and wraps the return value into a proper HTTP response.

Because it's built on top of Python's `async`/`await` system, it can handle many requests at the same time without blocking — which matters when your backend is waiting on slow operations like database queries.

## Example

```python
@router.post("/fragments")
async def create_fragment(payload: FragmentCreate) -> FragmentRead:
    return await fragment_service.create(payload)
```

One function, one decorator — FastAPI handles routing, input validation, and response serialization automatically. It also generates interactive API docs at `/docs` for free, which makes testing endpoints during development much faster.

In this project, all routes live under `backend/api/`, are prefixed with `/api/v1/`, and are always `async def`.
