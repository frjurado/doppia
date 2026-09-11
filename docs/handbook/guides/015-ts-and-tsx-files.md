# .ts and .tsx Files: TypeScript in Plain Language

## What it is

**.ts** and **.tsx** are TypeScript file extensions — TypeScript is JavaScript with an added layer that lets you declare what *type* of data every variable, function parameter, and return value holds.

## What it does

Plain JavaScript lets you put anything anywhere, which is flexible but error-prone: you can accidentally pass a number where a function expects a string, and the bug only surfaces at runtime (often in front of a user). TypeScript catches those mistakes *before* the code runs, at the moment you write it. Your editor can also use the type information to autocomplete, flag mismatches, and navigate code more reliably.

The difference between the two extensions is small: **.ts** is for pure logic files (utilities, services, type definitions), while **.tsx** is for files that contain **JSX** — the HTML-like syntax React uses to describe UI components. If a file renders anything visual, it's `.tsx`; if it's just functions and data, it's `.ts`.

## How it works

TypeScript is a superset of JavaScript — all valid JavaScript is valid TypeScript. You just add type annotations on top. A build tool (in this project, **Vite**) strips the type annotations at compile time and produces plain JavaScript that browsers can run. The types exist only during development; they have zero runtime cost.

## Example

```ts
// service.ts — pure logic, no JSX → .ts
function getFragmentById(id: string): Promise<Fragment> { ... }

// CorpusBrowser.tsx — renders UI with JSX → .tsx
export default function CorpusBrowser() {
  return <div className="corpus-browser">...</div>;
}
```

In this project, `.js` files are forbidden — everything in `frontend/src/` must be `.ts` or `.tsx`.
