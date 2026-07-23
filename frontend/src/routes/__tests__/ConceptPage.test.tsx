/**
 * ConceptPage tests — Component 11 Step 5.
 *
 * Coverage:
 *  - The payload is fetched from the glossary client for the URL's concept id
 *    and rendered: name, aliases, breadcrumb, definition, children.
 *  - The Step 2 editorial gate: reviewed prose is shown, unreviewed prose is
 *    replaced by the placeholder (and the raw prose never reaches the DOM).
 *  - Typed relationships render as labelled blocks, with unknown edge types
 *    falling back to a humanised label. (The grouping itself — ordering and the
 *    symmetric merge — is pinned in utils/__tests__/conceptRelationships.)
 *  - Stub targets render as flagged non-links; the concept's own stub state
 *    leads with the banner and drops the definition and browse link.
 *  - Links: children/targets to /glossary/:id, browse to /public/concepts.
 *  - Loading, 404, and generic error states.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { ConceptDetail, ConceptRelationship } from '../../services/glossaryApi';
import * as glossaryApi from '../../services/glossaryApi';
import ConceptPage from '../ConceptPage';

vi.mock('../../services/glossaryApi');

// The inline example section is covered by its own suite (ConceptExamples.test)
// and pulls in the Verovio/MIDI renderer; stub it here so the concept-page
// tests stay focused on the Step 5 payload and avoid the heavy import chain.
vi.mock('../../components/score/ConceptExamples', () => ({
  default: ({ conceptId }: { conceptId: string }) => (
    <div data-testid="concept-examples">{conceptId}</div>
  ),
}));

function makeConcept(overrides: Partial<ConceptDetail> = {}): ConceptDetail {
  return {
    id: 'PerfectAuthenticCadence',
    name: 'Perfect Authentic Cadence',
    aliases: ['PAC'],
    definition: 'A cadence closing on a root-position tonic with scale degree 1 in the soprano.',
    domain: 'cadences',
    complexity: 'foundational',
    stub: false,
    definition_reviewed: true,
    top_level_taggable: true,
    hierarchy_path: ['Cadence', 'Authentic Cadence', 'Perfect Authentic Cadence'],
    parent: { id: 'AuthenticCadence', name: 'Authentic Cadence', stub: false },
    children: [],
    relationships: [],
    ...overrides,
  };
}

function rel(
  type: string,
  direction: 'outgoing' | 'incoming',
  target: { id: string; name: string; stub?: boolean }
): ConceptRelationship {
  return { type, direction, target: { stub: false, ...target } };
}

function renderConceptPage(conceptId = 'PerfectAuthenticCadence') {
  return render(
    <MemoryRouter initialEntries={[`/glossary/${conceptId}`]}>
      <Routes>
        <Route path="/glossary/:conceptId" element={<ConceptPage />} />
        <Route path="/public/concepts" element={<div data-testid="browse-stub" />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(makeConcept());
});

describe('ConceptPage — identity and definition', () => {
  it('fetches the concept in the URL and renders its identity', async () => {
    renderConceptPage('AuthenticCadence');

    await screen.findByRole('heading', { name: 'Perfect Authentic Cadence', level: 1 });
    expect(glossaryApi.getPublicConcept).toHaveBeenCalledWith('AuthenticCadence');
    expect(screen.getByText(/also known as PAC/i)).toBeInTheDocument();
    expect(screen.getByText(/Cadences · Foundational/)).toBeInTheDocument();
  });

  it('renders the ancestor breadcrumb with the parent linked, excluding itself', async () => {
    renderConceptPage();

    const crumbs = await screen.findByRole('navigation', { name: /concept hierarchy/i });
    expect(within(crumbs).getByText('Cadence')).toBeInTheDocument();
    const parentLink = within(crumbs).getByRole('link', { name: 'Authentic Cadence' });
    expect(parentLink).toHaveAttribute('href', '/glossary/AuthenticCadence');
    // The concept's own name is the h1, never a crumb.
    expect(within(crumbs).queryByText('Perfect Authentic Cadence')).not.toBeInTheDocument();
  });

  it('shows the definition prose when it has passed editorial review', async () => {
    renderConceptPage();
    expect(await screen.findByText(/closing on a root-position tonic/i)).toBeInTheDocument();
  });

  it('withholds unreviewed prose behind the editorial placeholder', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({ definition_reviewed: false })
    );
    renderConceptPage();

    expect(await screen.findByText(/under editorial review/i)).toBeInTheDocument();
    expect(screen.queryByText(/closing on a root-position tonic/i)).not.toBeInTheDocument();
  });

  it('states that no definition exists when the concept has none', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({ definition: null, definition_reviewed: false })
    );
    renderConceptPage();
    expect(await screen.findByText(/no definition has been written/i)).toBeInTheDocument();
  });
});

describe('ConceptPage — hierarchy and relationships', () => {
  it('links direct children to their own concept pages', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({
        children: [
          { id: 'ImperfectAuthenticCadence', name: 'Imperfect Authentic Cadence', stub: false },
        ],
      })
    );
    renderConceptPage();

    const link = await screen.findByRole('link', { name: 'Imperfect Authentic Cadence' });
    expect(link).toHaveAttribute('href', '/glossary/ImperfectAuthenticCadence');
  });

  it('renders stub targets as flagged non-links', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({
        children: [{ id: 'PhrygianCadence', name: 'Phrygian Cadence', stub: true }],
      })
    );
    renderConceptPage();

    expect(await screen.findByText('Phrygian Cadence')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Phrygian Cadence/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not yet covered/i)).toBeInTheDocument();
  });

  it('groups typed relationships by type and direction', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({
        relationships: [
          rel('RESOLVES_TO', 'outgoing', { id: 'Tonic', name: 'Tonic' }),
          rel('PRECEDES', 'incoming', { id: 'PreDominant', name: 'Pre-Dominant' }),
          rel('CONTAINS', 'outgoing', { id: 'DominantStage', name: 'Dominant Stage' }),
        ],
      })
    );
    renderConceptPage();

    expect(await screen.findByText('Contains')).toBeInTheDocument();
    expect(screen.getByText('Led into by')).toBeInTheDocument();
    expect(screen.getByText('Resolves to')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tonic' })).toHaveAttribute('href', '/glossary/Tonic');
  });

  it('omits the relationships section when there are none', async () => {
    renderConceptPage();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/related concepts/i)).not.toBeInTheDocument();
  });
});

describe('ConceptPage — unknown edge label fallback', () => {
  it('humanises an edge type with no translated label', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({
        relationships: [rel('SOME_NEW_EDGE', 'outgoing', { id: 'X', name: 'X' })],
      })
    );
    renderConceptPage();
    expect(await screen.findByText('Some new edge')).toBeInTheDocument();
  });
});

describe('ConceptPage — stub concept', () => {
  it('leads with the stub banner and drops the definition and browse link', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockResolvedValue(
      makeConcept({
        id: 'Sequence',
        name: 'Sequence',
        stub: true,
        definition: null,
        definition_reviewed: false,
        hierarchy_path: ['Sequence'],
        parent: null,
      })
    );
    renderConceptPage('Sequence');

    expect(await screen.findByText(/has not modelled this concept's domain/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Definition$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /browse fragments/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // A stub carries no approved fragments — the example section is omitted too.
    expect(screen.queryByTestId('concept-examples')).not.toBeInTheDocument();
  });
});

describe('ConceptPage — example fragments (Step 6)', () => {
  it('mounts the example section for a non-stub concept, keyed on its id', async () => {
    renderConceptPage();

    const examples = await screen.findByTestId('concept-examples');
    expect(examples).toHaveTextContent('PerfectAuthenticCadence');
  });
});

describe('ConceptPage — fragment browse link', () => {
  it('links into the anonymous fragment browse for this concept', async () => {
    renderConceptPage();

    const link = await screen.findByRole('link', { name: /browse fragments/i });
    expect(link).toHaveAttribute('href', '/public/concepts?concept=PerfectAuthenticCadence');
  });
});

describe('ConceptPage — load states', () => {
  it('shows a loading notice before the payload arrives', () => {
    vi.mocked(glossaryApi.getPublicConcept).mockReturnValue(new Promise(() => {}));
    renderConceptPage();
    expect(screen.getByText(/loading concept/i)).toBeInTheDocument();
  });

  it('shows a not-found message for an unknown concept id', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockRejectedValue(
      new ApiError('CONCEPT_NOT_FOUND', "Concept 'Nope' not found.", 404)
    );
    renderConceptPage('Nope');

    expect(await screen.findByText(/no concept with that identifier/i)).toBeInTheDocument();
    // The raw backend message is never shown verbatim.
    expect(screen.queryByText(/'Nope' not found/)).not.toBeInTheDocument();
  });

  it('shows the API error message for a non-404 failure', async () => {
    vi.mocked(glossaryApi.getPublicConcept).mockRejectedValue(
      new ApiError('SERVER_ERROR', 'Something broke', 500)
    );
    renderConceptPage();
    await waitFor(() => {
      expect(screen.getByText(/something broke/i)).toBeInTheDocument();
    });
  });
});
