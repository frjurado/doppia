/**
 * Topbar tests — Component 12 Step 13.
 *
 * The topbar is an audience split, so the cases worth pinning are the ones
 * where the wrong audience would see the wrong door: an anonymous visitor must
 * not be offered Editorial, a signed-in editor must not be offered admin-only
 * entries, and an unshipped surface must be absent rather than present and
 * inert. The compact disclosure panel is tested through the same component
 * with `matchMedia` reporting a phone, since that is the only difference
 * between the two presentations.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopBar from '../TopBar';

const logout = vi.fn();
let authState: {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: { id: string; email: string; roles: string[] } | null;
};

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ ...authState, logout }),
}));

function signedIn(roles: string[]) {
  authState = {
    status: 'authenticated',
    user: { id: 'u1', email: 'someone@test.com', roles },
  };
}

/** Drive the `sm` breakpoint: matchMedia decides which presentation renders. */
function setViewport(compact: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: compact,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderBar() {
  return render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState = { status: 'anonymous', user: null };
  setViewport(false);
});

afterEach(() => {
  setViewport(false);
});

describe('public nav', () => {
  it('offers the public surfaces to an anonymous visitor', () => {
    renderBar();
    expect(screen.getByRole('link', { name: 'Fragments' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Glossary' })).toBeInTheDocument();
  });

  it('points Fragments at the one browse surface, for every audience', () => {
    signedIn(['editor']);
    renderBar();
    // There is one browse route since Step 14b; the editorial and public
    // halves it used to choose between are the same page now, and the session
    // decides what it fetches.
    expect(screen.getByRole('link', { name: 'Fragments' })).toHaveAttribute('href', '/fragments');
  });

  it('shows sign-in and register entry points when anonymous', () => {
    renderBar();
    expect(screen.getByRole('link', { name: 'Login' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /editorial/i })).not.toBeInTheDocument();
  });

  it('lists Glossary before Fragments, as the landing page does', () => {
    // The two disagreed until 2026-09-11 (Francisco). Presence tests cannot
    // see an order, so the decision needs its own assertion or the next edit
    // to this array silently undoes it.
    renderBar();
    const glossary = screen.getByRole('link', { name: 'Glossary' });
    const fragments = screen.getByRole('link', { name: 'Fragments' });
    const order = glossary.compareDocumentPosition(fragments);

    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('editorial menu', () => {
  it('sits with the public nav, not with the account controls', () => {
    // It names destinations — the corpus, the review queue — the way Glossary
    // and Fragments do, and the landing page offers the corpus as a door
    // beside them (Francisco, 2026-09-11). Asserted structurally rather than
    // on a class name: what matters is that it shares a parent with the nav
    // links, whatever that element ends up being called.
    signedIn(['editor']);
    renderBar();
    const linksGroup = screen.getByRole('link', { name: 'Glossary' }).parentElement;

    expect(linksGroup).toContainElement(screen.getByRole('button', { name: /editorial/i }));
    expect(linksGroup).not.toContainElement(screen.getByRole('button', { name: /account|@/i }));
  });

  it('is absent for an anonymous visitor and for a role-less account', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Editorial▾' })).not.toBeInTheDocument();

    signedIn([]);
    renderBar();
    expect(screen.queryByRole('button', { name: 'Editorial▾' })).not.toBeInTheDocument();
  });

  it('gives an editor the editorial surfaces but not the admin ones', async () => {
    signedIn(['editor']);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: /Editorial/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Corpus' })).toHaveAttribute(
      'href',
      '/corpus'
    );
    // "Concept tree" is gone: it pointed at the editorial half of a browse
    // surface that no longer has halves, and the public Fragments entry
    // reaches the same page.
    expect(within(menu).queryByRole('menuitem', { name: 'Concept tree' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Review' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'People' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Moderation' })).not.toBeInTheDocument();
  });

  it('gives an admin the moderation queue and user management', async () => {
    signedIn(['admin']);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: /Editorial/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Moderation' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'People' })).toBeInTheDocument();
    // Admin holds every editorial capability, so the editor entries stay too.
    expect(within(menu).getByRole('menuitem', { name: 'Review' })).toBeInTheDocument();
  });
});

describe('account menu', () => {
  it('carries profile, progress and sign out', async () => {
    signedIn([]);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: /someone@test.com/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Progress' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('signs out through the auth context', async () => {
    signedIn([]);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: /someone@test.com/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledOnce();
  });

  it('shows nothing while the session bootstrap is still resolving', () => {
    authState = { status: 'loading', user: null };
    renderBar();
    // Neither a login button nor an account menu: flashing one and replacing it
    // with the other is worse than a brief gap.
    expect(screen.queryByRole('link', { name: 'Login' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /@/ })).not.toBeInTheDocument();
  });
});

describe('compact disclosure (below sm)', () => {
  it('collapses the three groups into one panel', async () => {
    setViewport(true);
    signedIn(['admin']);
    renderBar();

    // The inline nav is gone; one toggle stands in its place.
    expect(screen.queryByRole('link', { name: 'Fragments' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // All three groups live in the single panel — not three separate menus.
    expect(screen.getByRole('link', { name: 'Fragments' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });

  it('omits the editorial group for a visitor who has no editorial role', async () => {
    setViewport(true);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('link', { name: 'Glossary' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Login' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    setViewport(true);
    renderBar();

    const toggle = screen.getByRole('button', { name: 'Menu' });
    await userEvent.click(toggle);
    expect(screen.getByRole('link', { name: 'Glossary' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('link', { name: 'Glossary' })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
