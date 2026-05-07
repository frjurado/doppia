/// <reference types="vite/client" />

// Verovio 6.x ships no .d.ts files. The production code in services/verovio.ts
// imports these sub-paths with inline type casts; these declarations silence the
// "could not find declaration file" error from tsc without affecting runtime.
declare module 'verovio/wasm' {
  const createVerovioModule: () => Promise<unknown>;
  export default createVerovioModule;
}
declare module 'verovio/esm' {
  export class VerovioToolkit {
    constructor(module: unknown);
    [key: string]: unknown;
  }
}
