# Stylelint

## What it is

Stylelint is an automated code quality tool for CSS and CSS-like languages. It scans your stylesheets and catches errors, bad practices, and inconsistencies — similar to how a spell-checker catches typos in prose.

## What it does

Stylelint helps enforce consistent style across your CSS codebase. It checks for common mistakes (like duplicate selectors or missing semicolons), enforces naming conventions, and ensures your CSS follows project rules. For Doppia's frontend, this is important because the design system defined in `docs/mockups/opus_urtext/DESIGN.md` has strict requirements — Henle Blue colors, specific fonts, no border-radius. Stylelint ensures every stylesheet adheres to these rules without manual review.

## How it works

You define a configuration file (`.stylelintrc`) that lists rules. When you run stylelint, it parses your CSS, checks each rule, and reports violations:

```
❌ color.md: Unexpected value "rgb(255, 0, 0)" — use Henle Blue #3f5f77 instead
❌ button.css: Unexpected property "border-radius" — not permitted in design system
```

You can fix issues manually or run `npm run lint:css -- --fix` to auto-correct simple problems.

## Example

In Doppia, stylelint might catch that someone accidentally used a border-radius on a button (violating the design system), or used an unauthorized color. The build fails until the CSS matches project rules, ensuring visual consistency across the app.

## Related

See `002-black-isort-ruff.md` for similar linting tools in the Python backend.
