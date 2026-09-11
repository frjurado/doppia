# Black, isort & Ruff: Python Code Quality Tools

## What it is

Three command-line tools that automatically clean up and check Python code style. Together they enforce consistent formatting so every contributor's code looks the same, regardless of personal habits.

## What it does

Without these tools, a team of developers will write Python in dozens of slightly different styles — some use single quotes, some double; some sort imports alphabetically, some don't. This creates noisy diffs and pointless arguments in code review. These tools eliminate that entirely:

- **Black** — a code *formatter*. It rewrites your Python files to follow one opinionated style. You never debate formatting again; Black just decides.
- **isort** — sorts and groups your `import` statements at the top of each file into a consistent order (standard library → third-party → local).
- **Ruff** — a fast *linter*. It doesn't reformat code; it flags potential bugs and bad practices (unused variables, missing type hints, etc.) and explains what to fix.

## How it works

Think of Black as autocorrect for code layout, isort as alphabetizing your bookshelf, and Ruff as a proofreader marking problems in red. You run them before committing:

```bash
black backend/
isort backend/
ruff check backend/
```

Black and isort modify files in place. Ruff prints a list of issues to fix manually.

## In this project

These three are the required Python quality gate for the `backend/` directory. Run them before every commit to avoid CI failures.
