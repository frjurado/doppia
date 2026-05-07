import '@testing-library/jest-dom';

// jsdom does not implement ResizeObserver; provide a no-op stub so components
// that attach ResizeObservers (e.g. ScoreViewer's container-width measurement)
// do not throw during tests.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

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
