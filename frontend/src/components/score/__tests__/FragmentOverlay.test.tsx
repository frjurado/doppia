import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FragmentOverlay from '../FragmentOverlay';

describe('FragmentOverlay', () => {
  it('renders an overlay container with the default data-testid', () => {
    render(<FragmentOverlay />);
    expect(screen.getByTestId('fragment-overlay')).toBeInTheDocument();
  });

  it('renders children inside the overlay', () => {
    render(
      <FragmentOverlay>
        <span data-testid="child-content">bracket</span>
      </FragmentOverlay>,
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('accepts a custom data-testid', () => {
    render(<FragmentOverlay data-testid="custom-overlay" />);
    expect(screen.getByTestId('custom-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('fragment-overlay')).not.toBeInTheDocument();
  });

  it('has aria-hidden so screen readers skip the decorative overlay', () => {
    render(<FragmentOverlay />);
    expect(screen.getByTestId('fragment-overlay')).toHaveAttribute('aria-hidden', 'true');
  });
});
