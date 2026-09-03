/**
 * Route topology (Step 14b).
 *
 * The old browse URLs are kept as redirects rather than deleted: Component
 * 11's glossary has linked into `/public/concepts?concept=…` since it shipped,
 * and a concept id in the query is the whole point of those links. A redirect
 * that loses the query is worse than no redirect, because it lands the reader
 * on an empty prompt instead of the fragments they asked for.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

/**
 * The redirect components under test, mirrored from App.tsx.
 *
 * App.tsx cannot be imported here: it mounts BrowserRouter, the auth provider
 * and the whole route tree, which would pull Verovio and the API clients into
 * a unit test. What matters is the redirect rule, so the rule is what is
 * exercised — and these two definitions must stay in step.
 */
function RedirectToFragments() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/fragments', search }} replace />;
}

function RedirectToFragmentDetail() {
  const { fragmentId } = useParams();
  return <Navigate to={`/fragments/${fragmentId}`} replace />;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/public/concepts" element={<RedirectToFragments />} />
        <Route path="/concepts" element={<RedirectToFragments />} />
        <Route path="/public/fragments/:fragmentId" element={<RedirectToFragmentDetail />} />
        <Route path="/fragments" element={<Landed label="browse" />} />
        <Route path="/fragments/:fragmentId" element={<Landed label="detail" />} />
      </Routes>
    </MemoryRouter>
  );
}

function Landed({ label }: { label: string }) {
  const { search } = useLocation();
  const { fragmentId } = useParams();
  return (
    <span data-testid="landed">
      {label}
      {fragmentId ? `:${fragmentId}` : ''}
      {search}
    </span>
  );
}

describe('retired browse routes', () => {
  it('carries the concept query across the public-browse redirect', () => {
    // This is the assertion that matters: every glossary "browse fragments
    // tagged X" link is a concept id in this query.
    renderAt('/public/concepts?concept=PerfectAuthenticCadence');
    expect(screen.getByTestId('landed')).toHaveTextContent(
      'browse?concept=PerfectAuthenticCadence'
    );
  });

  it('carries a multi-parameter query intact', () => {
    renderAt('/public/concepts?concept=Cadence&include_subtypes=false');
    expect(screen.getByTestId('landed')).toHaveTextContent(
      'browse?concept=Cadence&include_subtypes=false'
    );
  });

  it('redirects the editorial browse path to the same place', () => {
    renderAt('/concepts?concept=Cadence');
    expect(screen.getByTestId('landed')).toHaveTextContent('browse?concept=Cadence');
  });

  it('redirects a public fragment permalink to the one detail route', () => {
    renderAt('/public/fragments/frag-123');
    expect(screen.getByTestId('landed')).toHaveTextContent('detail:frag-123');
  });

  it('redirects a bare public-browse path without inventing a query', () => {
    renderAt('/public/concepts');
    expect(screen.getByTestId('landed')).toHaveTextContent('browse');
  });
});
