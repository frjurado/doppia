import React from 'react';
import Surface from './Surface';
import Type from './Type';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches synchronous render-time errors in the component subtree and
 * displays a fallback UI instead of crashing the whole page.
 *
 * Wrap route-level components with this to contain crashes:
 *   <ErrorBoundary><CorpusBrowser /></ErrorBoundary>
 */
export default class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Surface layer="base" style={{ padding: '2rem' }}>
          <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
            Something went wrong: {this.state.error.message}
          </Type>
        </Surface>
      );
    }
    return this.props.children;
  }
}
