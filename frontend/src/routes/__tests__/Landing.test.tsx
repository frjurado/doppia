/**
 * The landing page (Step 14b).
 *
 * `/` was the corpus browser. The point of the page is that every audience can
 * open it, so that is what these check: an anonymous visitor gets doors rather
 * than a redirect, and the editorial door appears only for editorial roles.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Landing from '../Landing';

let mockRoles: string[] = [];
let mockStatus = 'anonymous';

vi.mock('../../components/auth/AuthContext', () => ({
  useAuth: () => ({
    status: mockStatus,
    user: mockStatus === 'anonymous' ? null : { id: 'u1', email: 'e', roles: mockRoles },
  }),
}));

function renderLanding() {
  return render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockRoles = [];
  mockStatus = 'anonymous';
});

describe('Landing', () => {
  it('shows the public doors to an anonymous visitor', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /glossary/i })).toHaveAttribute('href', '/glossary');
    expect(screen.getByRole('link', { name: /browse fragments/i })).toHaveAttribute(
      'href',
      '/fragments'
    );
  });

  it('does not offer the corpus to a caller without an editorial role', () => {
    // The corpus browser is editorial and gated; showing the door to someone
    // who would be refused at it is the trap this whole step exists to close.
    mockStatus = 'authenticated';
    mockRoles = [];
    renderLanding();
    expect(screen.queryByRole('link', { name: /corpus/i })).not.toBeInTheDocument();
  });

  it('offers the corpus to an editor', () => {
    mockStatus = 'authenticated';
    mockRoles = ['editor'];
    renderLanding();
    expect(screen.getByRole('link', { name: /corpus/i })).toHaveAttribute('href', '/corpus');
  });

  it('names the doors region for assistive tech', () => {
    renderLanding();
    expect(screen.getByRole('navigation', { name: /where to start/i })).toBeInTheDocument();
  });
});
