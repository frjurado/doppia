# Testing Concepts: Fixtures, Unit Tests, and More

## What it is
Automated tests are code that checks whether other code behaves correctly. Instead of manually clicking around to verify something works, you write a test once and run it whenever something changes.

## What it does
Tests catch bugs before they reach production. They also act as living documentation — a well-named test tells you exactly what a function is supposed to do. This project uses `pytest` as the test runner.

## How it works

**Test types** describe how much of the system a test exercises:

- **Unit test** — tests a single function in isolation, with no database, no network, no external dependencies. Fast and reliable. Lives in `tests/unit/`.
- **Integration test** — tests how multiple pieces work together, usually against a real database. Slower, but catches issues that unit tests miss. Lives in `tests/integration/`.
- **Snapshot test** — saves a known-good output (e.g. a rendered SVG) to disk and alerts you if it ever changes unexpectedly. Lives in `tests/snapshots/`.
- **Graph test** — validates the structure and integrity of the Neo4j knowledge graph. Lives in `tests/graph/`.

**Fixture** — a reusable setup helper. Think of it like mise en place in cooking: before each test, a fixture prepares the ingredients (a database connection, a fake user, sample data). In pytest, fixtures are functions decorated with `@pytest.fixture`. Tests declare the fixtures they need as arguments, and pytest injects them automatically.

## Example
```python
@pytest.fixture
def sample_fragment():
    return {"id": "frag-1", "title": "Opening theme"}

def test_fragment_has_title(sample_fragment):
    assert sample_fragment["title"] == "Opening theme"
```

The fixture creates the data; the test checks the behaviour. They stay separate so the same fixture can be reused across many tests.
