import '@testing-library/jest-dom';

// jsdom does not implement matchMedia; provide a minimal stub so components
// that call window.matchMedia (e.g. CorpusBrowser's useMediaQuery hook) do
// not throw during tests.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
