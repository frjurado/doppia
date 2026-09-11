# Vitest

## What it is

Vitest is a unit testing framework for JavaScript and TypeScript projects built on top of Vite. It's designed as a faster, modern alternative to Jest that works seamlessly with Vite and ES modules.

## What it does

Vitest lets you write and run automated tests for your code. Tests verify that your functions, components, and features work as expected. Instead of manually clicking through your app to verify behavior, tests run instantly and alert you when something breaks. Vitest is particularly useful in the Doppia frontend because it's tightly integrated with Vite, the build tool we use — tests run faster and with better ES module support than older test runners.

## How it works

When you write a test with Vitest, you describe what you expect a piece of code to do:

```javascript
import { describe, it, expect } from 'vitest';

describe('myFunction', () => {
  it('should return 5 when given 2 and 3', () => {
    expect(myFunction(2, 3)).toBe(5);
  });
});
```

You run `npm run test` and Vitest executes all tests, showing you which ones pass or fail. If a test fails, Vitest tells you exactly what went wrong — maybe the function returned 4 instead of 5.

## Example

In Doppia's frontend, Vitest might test that a React component renders correctly or that a utility function properly processes MEI data. Before shipping code, tests automatically verify that new changes don't break existing features.

## Related

See `006-testing-concepts-and-test-types.md` for broader testing strategy and test types.
