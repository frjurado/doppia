import '@testing-library/jest-dom';
// Initialise i18next with the bundled English resources so components rendered
// in tests resolve real strings (not raw keys). Resources load synchronously
// (initImmediate: false), so no async test setup is required.
import '../i18n';

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
