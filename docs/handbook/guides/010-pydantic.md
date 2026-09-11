# Pydantic: Data Validation in Python

## What it is
Pydantic is a Python library that lets you define the exact shape and types of data your code expects, and then automatically checks that incoming data matches those rules.

## What it does
When your API receives data from the outside world — a form submission, a JSON payload, a database row — that data could be anything: wrong types, missing fields, unexpected values. Pydantic catches those problems before they cause bugs deeper in your code. You describe what valid data looks like once, and Pydantic enforces it every time.

In this project, no data reaches any database without first passing through a Pydantic model. This is a hard project rule, not a suggestion.

## How it works
Think of a Pydantic model like a customs form at an airport. You declare exactly what fields are required, what type each one must be, and any extra constraints (e.g. "this string must be at least 3 characters"). When data arrives, Pydantic checks it against the form. If something doesn't match, it raises a clear error immediately — before anything is saved or processed.

## Example

```python
from pydantic import BaseModel

class Fragment(BaseModel):
    title: str
    measure_start: int
    measure_end: int

# This works fine
f = Fragment(title="Opening theme", measure_start=1, measure_end=8)

# This raises a validation error — measure_start must be an int
f = Fragment(title="Opening theme", measure_start="one", measure_end=8)
```

Pydantic also coerces types when it safely can (e.g. the string `"8"` becomes the integer `8`), and it generates JSON schemas automatically — which is how FastAPI produces its interactive API documentation.
