/**
 * FragmentDetailPanel — the read sidebar fixes from M6 (Component 11 Step 10).
 *
 * Three defects, all in what the panel shows about a stored fragment:
 *
 *  - **Property order.** Rows came out in `summary.properties` insertion order,
 *    i.e. whatever sequence the tagging session happened to write, rather than
 *    the (grouped-first, order, name) sequence the server returns and the
 *    create/edit form renders (ADR-023).
 *  - **Local key.** Printed on every harmony row. Score convention writes a key
 *    where it is established and where it changes; the harmony panel and the
 *    in-score overlay already did that, the sidebar did not.
 *  - **Stage properties.** Sub-parts showed a name and a range but nothing an
 *    annotator had recorded about them.
 *
 * Rendered in standalone mode with a pre-fetched fragment, so no `getFragment`
 * call is involved; `getConceptSchemas` is mocked per concept.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import FragmentDetailPanel from '../FragmentDetailPanel';
import * as conceptApi from '../../../services/conceptApi';
import type { FragmentDetailResponse } from '../../../services/fragmentApi';

vi.mock('../../../services/conceptApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A schema tree whose display order deliberately differs from insertion order. */
function schemaTree(schemas: Array<{ id: string; name: string }>) {
  return {
    concept_id: 'PerfectAuthenticCadence',
    schemas: schemas.map((s) => ({
      id: s.id,
      name: s.name,
      description: null,
      cardinality: 'ONE_OF',
      required: false,
      order: null,
      group: null,
      values: [],
      translation_missing: false,
    })),
    stages: [],
    type_refinement: { show: false, children: [] },
  } as unknown as Awaited<ReturnType<typeof conceptApi.getConceptSchemas>>;
}

function fragment(overrides: Partial<FragmentDetailResponse> = {}): FragmentDetailResponse {
  return {
    id: 'frag-1',
    movement_id: 'mov-1',
    parent_fragment_id: null,
    bar_start: 12,
    bar_end: 15,
    mc_start: 12,
    mc_end: 15,
    beat_start: null,
    beat_end: null,
    repeat_context: null,
    section_label: null,
    summary: {
      version: 1,
      key: 'C major',
      meter: '4/4',
      concepts: ['PerfectAuthenticCadence'],
      properties: {},
    },
    prose_annotation: null,
    data_licence: null,
    data_licence_url: null,
    harmony_sources: [],
    status: 'approved',
    created_by: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    concept_tags: [
      {
        concept_id: 'PerfectAuthenticCadence',
        is_primary: true,
        name: 'Perfect Authentic Cadence',
        alias: 'PAC',
        hierarchy_path: ['Cadence', 'Perfect Authentic Cadence'],
      },
    ],
    harmony_events: [],
    sub_parts: [],
    composer_name: null,
    work_title: null,
    work_catalogue_number: null,
    movement_number: null,
    movement_title: null,
    mei_url: null,
    preview_url: null,
    ...overrides,
  } as FragmentDetailResponse;
}

function renderPanel(frag: FragmentDetailResponse) {
  return render(
    <FragmentDetailPanel
      fragmentId={frag.id}
      onClose={() => {}}
      tagMode="view"
      standalone
      initialFragment={frag}
    />
  );
}

beforeEach(() => {
  vi.mocked(conceptApi.getConceptSchemas).mockReset();
});

// ---------------------------------------------------------------------------
// Property order
// ---------------------------------------------------------------------------

describe('FragmentDetailPanel — property order', () => {
  it('renders properties in schema order, not stored order', async () => {
    // Stored insertion order is cadence-position, cadence-strength; the schema
    // tree (which the form follows) is the other way round.
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(
      schemaTree([
        { id: 'cadence-strength', name: 'Strength' },
        { id: 'cadence-position', name: 'Position' },
      ])
    );

    renderPanel(
      fragment({
        summary: {
          version: 1,
          key: 'C major',
          meter: '4/4',
          concepts: ['PerfectAuthenticCadence'],
          properties: { 'cadence-position': 'medial', 'cadence-strength': 'strong' },
        },
      } as Partial<FragmentDetailResponse>)
    );

    await waitFor(() => expect(screen.getByText('Strength')).toBeInTheDocument());
    const labels = screen.getAllByText(/^(Strength|Position)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Strength', 'Position']);
  });

  it('keeps properties with no schema, after the known ones', async () => {
    // A value must never vanish from the sidebar because its schema is missing.
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(
      schemaTree([{ id: 'cadence-strength', name: 'Strength' }])
    );

    renderPanel(
      fragment({
        summary: {
          version: 1,
          key: 'C major',
          meter: '4/4',
          concepts: ['PerfectAuthenticCadence'],
          properties: { 'unknown-prop': 'kept', 'cadence-strength': 'strong' },
        },
      } as Partial<FragmentDetailResponse>)
    );

    await waitFor(() => expect(screen.getByText('Strength')).toBeInTheDocument());
    expect(screen.getByText('unknown-prop')).toBeInTheDocument();
    expect(screen.getByText('kept')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Local-key convention
// ---------------------------------------------------------------------------

describe('FragmentDetailPanel — local key convention', () => {
  const events = [
    { mn: 12, beat: 1, numeral: 'I', local_key: 'C major', reviewed: true },
    { mn: 12, beat: 3, numeral: 'V', local_key: 'C major', reviewed: true },
    { mn: 13, beat: 1, numeral: 'V', local_key: 'G major', reviewed: true },
    { mn: 13, beat: 3, numeral: 'I', local_key: 'G major', reviewed: true },
  ];

  it('prints the key on the first event and at each change only', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(schemaTree([]));

    const { container } = renderPanel(
      fragment({ harmony_events: events } as Partial<FragmentDetailResponse>)
    );

    await waitFor(() => expect(screen.getByText(/I \(C major\)/)).toBeInTheDocument());

    // Two keys are established across four events → exactly two printed keys.
    expect(container.textContent?.match(/\(C major\)/g) ?? []).toHaveLength(1);
    expect(container.textContent?.match(/\(G major\)/g) ?? []).toHaveLength(1);
    // The repeats render bare.
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('prints the key on a single-event fragment', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(schemaTree([]));

    renderPanel(fragment({ harmony_events: [events[0]!] } as Partial<FragmentDetailResponse>));

    await waitFor(() => expect(screen.getByText(/I \(C major\)/)).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Stage properties
// ---------------------------------------------------------------------------

describe('FragmentDetailPanel — stage properties', () => {
  it("renders a sub-part's properties, labelled from the stage concept schema", async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockImplementation(async (conceptId: string) => {
      if (conceptId === 'CadentialDominant') {
        return schemaTree([{ id: 'dominant-form', name: 'Dominant form' }]);
      }
      return schemaTree([]);
    });

    const subPart = {
      ...fragment({ id: 'stage-1' }),
      parent_fragment_id: 'frag-1',
      bar_start: 14,
      bar_end: 14,
      mc_start: 14,
      mc_end: 14,
      concept_tags: [
        {
          concept_id: 'CadentialDominant',
          is_primary: true,
          name: 'Dominant',
          alias: null,
          hierarchy_path: [],
        },
      ],
      summary: {
        version: 1,
        key: 'C major',
        meter: '4/4',
        concepts: ['CadentialDominant'],
        properties: { 'dominant-form': 'V7' },
      },
    } as unknown as FragmentDetailResponse;

    renderPanel(fragment({ sub_parts: [subPart] } as Partial<FragmentDetailResponse>));

    // The stage's own schema tree supplies the label; before this fix nothing
    // about the stage's properties reached the sidebar at all.
    await waitFor(() => expect(screen.getByText('Dominant form')).toBeInTheDocument());
    const item = screen.getByText('Dominant form').closest('li');
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).getByText('V7')).toBeInTheDocument();
  });

  it('renders a sub-part with no properties without an empty list', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(schemaTree([]));

    const subPart = {
      ...fragment({ id: 'stage-bare' }),
      parent_fragment_id: 'frag-1',
      concept_tags: [
        {
          concept_id: 'CadentialDominant',
          is_primary: true,
          name: 'Dominant',
          alias: null,
          hierarchy_path: [],
        },
      ],
    } as unknown as FragmentDetailResponse;

    renderPanel(fragment({ sub_parts: [subPart] } as Partial<FragmentDetailResponse>));

    await waitFor(() => expect(screen.getByText('Dominant')).toBeInTheDocument());
    const item = screen.getByText('Dominant').closest('li');
    expect(within(item as HTMLElement).queryByRole('definition')).toBeNull();
  });
});
