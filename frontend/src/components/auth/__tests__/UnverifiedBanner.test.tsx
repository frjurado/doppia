/**
 * UnverifiedBanner tests — Component 12 Step 5.
 *
 * The banner is mounted unconditionally in the shared layout, so the states it
 * must stay silent in matter more than the one it speaks in: an anonymous
 * visitor and a verified account must see nothing at all.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../../services/session';
import UnverifiedBanner from '../UnverifiedBanner';

const mockAuth = vi.fn();
vi.mock('../AuthContext', () => ({ useAuth: () => mockAuth() }));

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    email: 'editor@test.com',
    roles: ['editor'],
    email_verified: false,
    ...overrides,
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <UnverifiedBanner />
    </MemoryRouter>
  );
}

describe('UnverifiedBanner', () => {
  it('warns an authenticated user whose address is unconfirmed', () => {
    mockAuth.mockReturnValue({ status: 'authenticated', user: user() });
    renderBanner();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('links to the interstitial carrying the address, so resend has a target', () => {
    mockAuth.mockReturnValue({ status: 'authenticated', user: user() });
    renderBanner();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/auth/verify-email?email=editor%40test.com'
    );
  });

  it('renders nothing for a verified account', () => {
    mockAuth.mockReturnValue({
      status: 'authenticated',
      user: user({ email_verified: true }),
    });
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an anonymous visitor', () => {
    mockAuth.mockReturnValue({ status: 'anonymous', user: null });
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the session is still bootstrapping', () => {
    // `loading` carries a null user; a banner flashing during bootstrap would
    // be both wrong and ugly.
    mockAuth.mockReturnValue({ status: 'loading', user: null });
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });
});
