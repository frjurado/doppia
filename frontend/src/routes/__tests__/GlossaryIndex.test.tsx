/**
 * GlossaryIndex tests — Component 11 Step 7.
 *
 * Coverage:
 *  - Fetches the browse-by-domain index on mount and renders one heading per
 *    domain (translated where a key exists, else the server label).
 *  - Forest assembly: a domain with several `parent_id: null` entries renders
 *    them all as top-level siblings, and IS_SUBTYPE_OF children nest under their
 *    parent — the flat-list-plus-parent_id shape from § Step 4b.
 *  - Each node links to its concept page; aliases and non-zero fragment counts
 *    show, a zero count is omitted.
 *  - Loading, error, and empty states.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { ConceptIndexDomain, ConceptIndexNode } from '../../services/glossaryApi';
import * as glossaryApi from '../../services/glossaryApi';
import GlossaryIndex from '../GlossaryIndex';

vi.mock('../../services/glossaryApi');

function node(overrides: Partial<ConceptIndexNode> = {}): ConceptIndexNode {
  return {
    id: 'Cadence',
    name: 'Cadence',
    aliases: [],
    hierarchy_path: ['Cadence'],
    parent_id: null,
    fragment_count: 0,
    ...overrides,
  };
}

/** The cadences domain as § Step 4b describes it: a forest, not a single tree. */
function cadencesDomain(): ConceptIndexDomain {
  return {
    domain: 'cadences',
    label: 'Cadences',
    nodes: [
      node({ id: 'Cadence', name: 'Cadence', parent_id: null, fragment_count: 0 }),
      node({
        id: 'AuthenticCadence',
        name: 'Authentic Cadence',
        parent_id: 'Cadence',
        fragment_count: 4,
      }),
      node({
        id: 'PerfectAuthenticCadence',
        name: 'Perfect Authentic Cadence',
        aliases: ['PAC'],
        parent_id: 'AuthenticCadence',
        fragment_count: 7,
      }),
      // A second root in the same domain — a post-cadential concept that is a
      // subtype of nothing (parent_id null) but still belongs to cadences.
      node({
        id: 'ClosingSection',
        name: 'Closing Section',
        parent_id: null,
        fragment_count: 2,
      }),
    ],
  };
}

function renderIndex() {
  return render(
    <MemoryRouter initialEntries={['/glossary']}>
      <GlossaryIndex />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GlossaryIndex — browse-by-domain forest', () => {
  it('fetches the index on mount and renders the domain heading', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({
      domains: [cadencesDomain()],
    });

    renderIndex();

    await screen.findByRole('heading', { name: 'Cadences', level: 2 });
    expect(glossaryApi.getPublicConceptIndex).toHaveBeenCalledTimes(1);
  });

  it('renders every node as a link to its concept page', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({
      domains: [cadencesDomain()],
    });

    renderIndex();

    const pac = await screen.findByRole('link', { name: /Perfect Authentic Cadence/ });
    expect(pac).toHaveAttribute('href', '/glossary/PerfectAuthenticCadence');
    expect(screen.getByRole('link', { name: /^Cadence/ })).toHaveAttribute(
      'href',
      '/glossary/Cadence'
    );
  });

  it('renders several parent_id:null entries as sibling roots (a forest)', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({
      domains: [cadencesDomain()],
    });

    renderIndex();

    // Both Cadence and Closing Section are top-level in the domain forest.
    const heading = await screen.findByRole('heading', { name: 'Cadences', level: 2 });
    const section = heading.closest('section')!;
    // The forest is the section's outermost list; its direct <li> children are
    // the roots (nested subtype lists are deeper <ul>s and don't count here).
    const forest = section.querySelector('ul')!;
    const roots = forest.querySelectorAll(':scope > li');
    expect(roots).toHaveLength(2);
  });

  it('shows aliases and non-zero counts, omitting a zero count', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({
      domains: [cadencesDomain()],
    });

    renderIndex();

    const pac = await screen.findByRole('link', { name: /Perfect Authentic Cadence/ });
    expect(within(pac).getByText('PAC')).toBeInTheDocument();
    expect(within(pac).getByText('7')).toBeInTheDocument();

    // Cadence has a zero count — no number rendered in its row.
    const cadence = screen.getByRole('link', { name: /^Cadence/ });
    expect(within(cadence).queryByText('0')).not.toBeInTheDocument();
  });

  it('renders one section per domain', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({
      domains: [
        cadencesDomain(),
        {
          domain: 'prolongation',
          label: 'Prolongation',
          nodes: [node({ id: 'Prolongation', name: 'Prolongation', parent_id: null })],
        },
      ],
    });

    renderIndex();

    await screen.findByRole('heading', { name: 'Cadences', level: 2 });
    expect(screen.getByRole('heading', { name: 'Prolongation', level: 2 })).toBeInTheDocument();
  });
});

describe('GlossaryIndex — states', () => {
  it('shows a loading notice before the index arrives', async () => {
    let resolve: (v: { domains: ConceptIndexDomain[] }) => void = () => {};
    vi.mocked(glossaryApi.getPublicConceptIndex).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    renderIndex();

    expect(screen.getByText(/loading the glossary/i)).toBeInTheDocument();
    resolve({ domains: [] });
    await waitFor(() =>
      expect(screen.queryByText(/loading the glossary/i)).not.toBeInTheDocument()
    );
  });

  it('shows the empty note when no domains are published', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockResolvedValue({ domains: [] });

    renderIndex();

    expect(await screen.findByText(/no concepts have been published/i)).toBeInTheDocument();
  });

  it('shows an error message when the index fails to load', async () => {
    vi.mocked(glossaryApi.getPublicConceptIndex).mockRejectedValue(
      new ApiError('BOOM', 'nope', 500)
    );

    renderIndex();

    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
