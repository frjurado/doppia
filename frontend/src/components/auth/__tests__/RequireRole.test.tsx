/**
 * Route role-gate tests.
 *
 * `RequireRole` became any-of here to match the backend's
 * `require_role(*roles)` (ADR-037). The cases worth pinning are the two that
 * were wrong before: an editor could not reach an `[EDITOR, ADMIN]` route
 * under the old single-role prop, and a signed-in account without the role was
 * sent to `/` — which is itself gated, so the redirect looped and the user
 * instead saw the raw backend permission string on the page.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequireRole from '../RequireRole';
import { ADMIN, EDITOR, EDITORIAL_ROLES } from '../../../services/roles';

let authState: {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: { id: string; email: string; roles: string[] } | null;
};

vi.mock('../AuthContext', () => ({ useAuth: () => authState }));

function renderGate(roles: readonly string[], at = '/gated') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="/gated"
          element={
            <RequireRole roles={roles}>
              <span>gated content</span>
            </RequireRole>
          }
        />
        <Route path="/glossary" element={<span>glossary</span>} />
        <Route path="/login" element={<span>login form</span>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  authState = { status: 'anonymous', user: null };
});

function signedIn(roles: string[]) {
  authState = { status: 'authenticated', user: { id: 'u1', email: 'a@b.c', roles } };
}

describe('any-of role matching', () => {
  it('admits a caller holding either listed role', () => {
    signedIn([EDITOR]);
    renderGate(EDITORIAL_ROLES);
    expect(screen.getByText('gated content')).toBeInTheDocument();

    signedIn([ADMIN]);
    renderGate(EDITORIAL_ROLES);
    expect(screen.getAllByText('gated content').length).toBeGreaterThan(0);
  });

  it('refuses a caller holding neither', () => {
    signedIn([EDITOR]);
    renderGate([ADMIN]);
    expect(screen.queryByText('gated content')).not.toBeInTheDocument();
  });

  it('refuses an account with no roles at all', () => {
    signedIn([]);
    renderGate(EDITORIAL_ROLES);
    expect(screen.queryByText('gated content')).not.toBeInTheDocument();
  });
});

describe('where a refused caller lands', () => {
  it('sends a signed-in caller to the glossary, not to a login form', () => {
    signedIn([]);
    renderGate(EDITORIAL_ROLES);
    // "/" would loop: it is itself gated while the corpus browser lives there.
    // A login form would suggest the wrong remedy to someone already signed in.
    expect(screen.getByText('glossary')).toBeInTheDocument();
    expect(screen.queryByText('login form')).not.toBeInTheDocument();
  });

  it('sends an anonymous caller to the login form', () => {
    renderGate(EDITORIAL_ROLES);
    expect(screen.getByText('login form')).toBeInTheDocument();
  });

  it('renders nothing while the session is still resolving', () => {
    authState = { status: 'loading', user: null };
    renderGate(EDITORIAL_ROLES);
    // Redirecting here would bounce a legitimate admin off their own page on
    // every reload, before the refresh cookie has restored their roles.
    expect(screen.queryByText('gated content')).not.toBeInTheDocument();
    expect(screen.queryByText('glossary')).not.toBeInTheDocument();
    expect(screen.queryByText('login form')).not.toBeInTheDocument();
  });
});
