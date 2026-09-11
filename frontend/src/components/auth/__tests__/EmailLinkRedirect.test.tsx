/**
 * Tests for the emailed-token route guard.
 *
 * The case that motivated this is the staging invitation of 2026-08-30: the
 * link arrived as `/?token_hash=…&type=invite` because `redirect_to` was not in
 * Supabase's allowlist and it silently substituted the Site URL. Nothing at `/`
 * reads a token, so the invitee was bounced to /login with no way to continue
 * and nothing on screen to explain it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import EmailLinkRedirect from '../EmailLinkRedirect';

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <EmailLinkRedirect>
        <Routes>
          <Route path="/" element={<p>corpus browser</p>} />
          <Route path="/login" element={<p>login</p>} />
          <Route path="/auth/reset-password" element={<ResetStub label="choose a password" />} />
          <Route path="/auth/callback" element={<ResetStub label="callback" />} />
        </Routes>
      </EmailLinkRedirect>
    </MemoryRouter>
  );
}

/** Renders its label plus the router's query string, so a redirect that
 *  dropped the token fails the test as loudly as one that never happened. */
function ResetStub({ label }: { label: string }) {
  const { search } = useLocation();
  return (
    <p>
      {label}
      {search}
    </p>
  );
}

describe('EmailLinkRedirect', () => {
  it('forwards an invitation that landed on the site root, token intact', async () => {
    renderAt('/?token_hash=abc123&type=invite');
    expect(
      await screen.findByText('choose a password?token_hash=abc123&type=invite')
    ).toBeInTheDocument();
    expect(screen.queryByText('corpus browser')).not.toBeInTheDocument();
  });

  it('forwards a recovery link that landed on the site root', async () => {
    renderAt('/?token_hash=abc123&type=recovery');
    expect(
      await screen.findByText('choose a password?token_hash=abc123&type=recovery')
    ).toBeInTheDocument();
  });

  it('sends a signup confirmation to the callback, not the password form', async () => {
    // Confirming an address only needs a session established; there is no
    // password to choose.
    renderAt('/?token_hash=abc123&type=signup');
    expect(await screen.findByText('callback?token_hash=abc123&type=signup')).toBeInTheDocument();
  });

  it('leaves a link that already arrived at the right route alone', async () => {
    // No redirect loop: the guard must be a no-op once the path matches.
    renderAt('/auth/reset-password?token_hash=abc123&type=invite');
    expect(await screen.findByText(/choose a password/)).toBeInTheDocument();
  });

  it('ignores an unknown token type rather than guessing a destination', async () => {
    renderAt('/?token_hash=abc123&type=something_else');
    expect(await screen.findByText('corpus browser')).toBeInTheDocument();
  });

  it('ignores a request with no token at all', async () => {
    renderAt('/');
    expect(await screen.findByText('corpus browser')).toBeInTheDocument();
  });

  it('ignores a type with no token', async () => {
    renderAt('/?type=invite');
    expect(await screen.findByText('corpus browser')).toBeInTheDocument();
  });
});
