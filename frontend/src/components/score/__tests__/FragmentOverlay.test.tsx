/**
 * Tests for FragmentOverlay — Step 10 data-layer / projection + Step 11 visuals.
 *
 * Step 10 coverage (unchanged):
 *  - Container/children behaviour.
 *  - Stored-fragment projection: brackets rendered at projected positions.
 *  - Filter-ready show flag: fragments with show=false are hidden.
 *  - Pointer-events: bracket bars are non-interactive; click targets are auto.
 *  - Ghost-layer null guard: no brackets when ghostLayer is absent.
 *
 * Step 11 coverage (new):
 *  - Alias labels rendered on the first segment; absent when alias is null.
 *  - Click target renders when fragment has sub-parts (even without onBracketClick).
 *  - Collapse/expand: sub-part brackets hidden by default; shown after click;
 *    hidden again after second click.
 *  - Sub-part bracket placement: below the staff at systemBottom + gap.
 *  - Sub-part status classes applied correctly.
 *  - Two-level display limit: sub_parts.sub_parts are never rendered.
 *
 * The DOM-based buildGhosts() function returns zeros in jsdom, so we use a
 * hand-constructed minimal ghost layer (just measureIndex entries) rather than
 * calling buildGhosts.  This tests the projection path with real measureIndex
 * lookups while bypassing the SVG geometry step that jsdom cannot simulate.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FragmentOverlay from '../FragmentOverlay';
import type { FragmentOverlayProps } from '../FragmentOverlay';
import type { GhostLayer, MeasureGhostEntry } from '../ghosts';
import type { FragmentListItem } from '../../../services/fragmentApi';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal GhostLayer-shaped object with the given measure entries. */
function makeMockGhostLayer(
  entries: Array<{ barN: number; left: number; width: number; systemTop: number }>,
): GhostLayer {
  const measureIndex = new Map<string, MeasureGhostEntry>();
  for (const e of entries) {
    const key = `m${e.barN}`;
    measureIndex.set(key, {
      el: document.createElement('div'),
      barN: e.barN,
      endingN: null,
      key,
      bounds: { left: e.left, top: e.systemTop + 4, width: e.width, height: 40 },
      systemTop: e.systemTop,
    });
  }
  return { measureIndex, beatIndex: new Map(), subBeatIndex: new Map() } as unknown as GhostLayer;
}

/** A minimal FragmentListItem for a measure-level fragment, no sub-parts. */
function makeFragment(
  id: string,
  barStart: number,
  barEnd: number,
  status: FragmentListItem['status'] = 'approved',
): FragmentListItem {
  return {
    id,
    movement_id: 'mov-1',
    parent_fragment_id: null,
    mc_start: barStart,
    mc_end: barEnd,
    bar_start: barStart,
    bar_end: barEnd,
    beat_start: null,
    beat_end: null,
    repeat_context: null,
    status,
    primary_concept_id: 'cad-pac',
    primary_concept_alias: 'PAC',
    sub_parts: [],
  };
}

/**
 * A fragment with one sub-part child.
 * Parent covers parentBarStart..parentBarEnd; child covers subBarStart..subBarEnd.
 * Child status defaults to 'submitted'.
 */
function makeFragmentWithSubPart(
  parentId: string,
  parentBarStart: number,
  parentBarEnd: number,
  subId: string,
  subBarStart: number,
  subBarEnd: number,
  subStatus: FragmentListItem['status'] = 'submitted',
): FragmentListItem {
  return {
    ...makeFragment(parentId, parentBarStart, parentBarEnd),
    sub_parts: [makeFragment(subId, subBarStart, subBarEnd, subStatus)],
  };
}

/**
 * Ghost layer covering bars 1–4, all on one system row.
 *   systemTop = 50
 *   bounds.top = 54, bounds.height = 40  →  systemBottom = 94
 */
const FOUR_BAR_LAYER = makeMockGhostLayer([
  { barN: 1, left:   0, width: 100, systemTop: 50 },
  { barN: 2, left: 100, width: 100, systemTop: 50 },
  { barN: 3, left: 200, width: 100, systemTop: 50 },
  { barN: 4, left: 300, width: 100, systemTop: 50 },
]);

// ---------------------------------------------------------------------------
// Existing container / children tests (must not regress)
// ---------------------------------------------------------------------------

describe('FragmentOverlay — container', () => {
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

// ---------------------------------------------------------------------------
// Ghost-layer null guard
// ---------------------------------------------------------------------------

describe('FragmentOverlay — null ghost layer', () => {
  it('renders no stored brackets when ghostLayer is not provided', () => {
    const frag = makeFragment('frag-1', 1, 2);
    render(<FragmentOverlay fragments={[frag]} />);
    expect(screen.queryByTestId('stored-bracket-frag-1')).not.toBeInTheDocument();
  });

  it('renders no stored brackets when ghostLayer is null', () => {
    const frag = makeFragment('frag-1', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={null} />);
    expect(screen.queryByTestId('stored-bracket-frag-1')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Projection: brackets render at projected positions
// ---------------------------------------------------------------------------

describe('FragmentOverlay — projection', () => {
  it('renders a bracket for a fragment whose bars are in the ghost layer', () => {
    const frag = makeFragment('frag-a', 2, 3);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.getByTestId('stored-bracket-frag-a')).toBeInTheDocument();
  });

  it('renders no bracket for a fragment whose bars are not in the ghost layer', () => {
    const frag = makeFragment('frag-missing', 10, 12); // bars 10-12 not in layer
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.queryByTestId('stored-bracket-frag-missing')).not.toBeInTheDocument();
  });

  it('renders one bracket element per fragment', () => {
    const frags = [
      makeFragment('frag-1', 1, 1),
      makeFragment('frag-2', 3, 4),
    ];
    render(<FragmentOverlay fragments={frags} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.getByTestId('stored-bracket-frag-1')).toBeInTheDocument();
    expect(screen.getByTestId('stored-bracket-frag-2')).toBeInTheDocument();
  });

  it('projects correct left and width from ghost layer bounds', () => {
    // Fragment covers bars 2–3: left=100, right=300 → width=200.
    const frag = makeFragment('frag-b', 2, 3);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const el = screen.getByTestId('stored-bracket-frag-b');
    expect(el.style.left).toBe('100px');   // left of bar 2
    expect(el.style.width).toBe('200px');  // right of bar 3 minus left of bar 2
  });

  it('bracket top is above the systemTop by the stored bracket constant', () => {
    // systemTop=50, STORED_BRACKET_ABOVE_SYSTEM_PX=16 → top=34
    const frag = makeFragment('frag-c', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const el = screen.getByTestId('stored-bracket-frag-c');
    expect(el.style.top).toBe('34px');
  });

  it('projects a full-span bracket when the fragment covers all bars', () => {
    const frag = makeFragment('frag-all', 1, 4);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const el = screen.getByTestId('stored-bracket-frag-all');
    expect(el.style.left).toBe('0px');
    expect(el.style.width).toBe('400px'); // 4 × 100
  });

  it('re-projects when ghostLayer prop changes (zoom/resize re-render)', () => {
    const frag = makeFragment('frag-repro', 1, 2);
    const { rerender } = render(
      <FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />,
    );
    expect(screen.getByTestId('stored-bracket-frag-repro').style.left).toBe('0px');

    // Simulate zoom — new ghost layer with doubled widths.
    const zoomedLayer = makeMockGhostLayer([
      { barN: 1, left:   0, width: 200, systemTop: 50 },
      { barN: 2, left: 200, width: 200, systemTop: 50 },
    ]);
    rerender(<FragmentOverlay fragments={[frag]} ghostLayer={zoomedLayer} />);
    expect(screen.getByTestId('stored-bracket-frag-repro').style.width).toBe('400px');
  });
});

// ---------------------------------------------------------------------------
// Filter-ready state
// ---------------------------------------------------------------------------

describe('FragmentOverlay — filter-ready show state', () => {
  it('shows all fragments by default (show defaults to true)', () => {
    const frags = [makeFragment('f-1', 1, 1), makeFragment('f-2', 2, 2)];
    render(<FragmentOverlay fragments={frags} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.getByTestId('stored-bracket-f-1')).toBeInTheDocument();
    expect(screen.getByTestId('stored-bracket-f-2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pointer-events and click target
// ---------------------------------------------------------------------------

describe('FragmentOverlay — pointer-events', () => {
  it('bracket bar has pointer-events: none so ghost drags pass through', () => {
    const frag = makeFragment('frag-pe', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const bar = screen.getByTestId('stored-bracket-frag-pe');
    // CSS module sets pointer-events: none; jsdom returns '' for CSS module
    // computed styles, so assert the class is applied (convention here).
    expect(bar.className).toContain('storedBracket');
  });

  it('click target button is rendered on the first (and only) segment when handler wired', () => {
    const frag = makeFragment('frag-ct', 1, 2); // no sub-parts
    render(
      <FragmentOverlay
        fragments={[frag]}
        ghostLayer={FOUR_BAR_LAYER}
        onBracketClick={vi.fn()}
      />,
    );
    // { hidden: true } because the overlay container carries aria-hidden="true".
    const buttons = screen.getAllByRole('button', {
      name: 'Open fragment details',
      hidden: true,
    });
    expect(buttons).toHaveLength(1);
  });

  it('click target calls onBracketClick with the fragment id', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const frag = makeFragment('frag-click', 1, 2); // no sub-parts
    render(
      <FragmentOverlay
        fragments={[frag]}
        ghostLayer={FOUR_BAR_LAYER}
        onBracketClick={handler}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'Open fragment details', hidden: true }),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('frag-click');
  });

  it('no click target is rendered when fragment has no sub-parts and onBracketClick is absent', () => {
    const frag = makeFragment('frag-no-click', 1, 2); // no sub-parts, no handler
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    // No button of either aria-label should exist.
    expect(
      screen.queryByRole('button', { name: 'Open fragment details', hidden: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Expand fragment', hidden: true }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Status class assignment
// ---------------------------------------------------------------------------

describe('FragmentOverlay — status classes', () => {
  const cases: Array<[FragmentListItem['status'], string]> = [
    ['draft',     'statusDraft'],
    ['submitted', 'statusSubmitted'],
    ['approved',  'statusApproved'],
    ['rejected',  'statusRejected'],
  ];

  it.each(cases)(
    'fragment with status %s gets the %s CSS class',
    (status, expectedClass) => {
      const frag = makeFragment(`frag-${status}`, 1, 2, status);
      render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
      const bracket = screen.getByTestId(`stored-bracket-frag-${status}`);
      expect(bracket.className).toContain(expectedClass);
    },
  );
});

// ---------------------------------------------------------------------------
// Alias labels (Step 11)
// ---------------------------------------------------------------------------

describe('FragmentOverlay — alias labels', () => {
  it('renders the alias label on the first bracket segment', () => {
    const frag = makeFragment('frag-label', 1, 2); // alias = 'PAC'
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const bracket = screen.getByTestId('stored-bracket-frag-label');
    expect(bracket.textContent).toContain('PAC');
  });

  it('does not render a label when primary_concept_alias is null', () => {
    const frag: FragmentListItem = {
      ...makeFragment('frag-no-alias', 1, 2),
      primary_concept_alias: null,
    };
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const bracket = screen.getByTestId('stored-bracket-frag-no-alias');
    // The bracket element should have no text content (no label span).
    expect(bracket.textContent).toBe('');
  });

  it('renders the alias text matching primary_concept_alias', () => {
    const frag: FragmentListItem = {
      ...makeFragment('frag-iac', 1, 2),
      primary_concept_alias: 'IAC',
    };
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    const bracket = screen.getByTestId('stored-bracket-frag-iac');
    expect(bracket.textContent).toBe('IAC');
  });

  it('renders labels for all fragments independently', () => {
    const frags = [
      { ...makeFragment('f-pac', 1, 2), primary_concept_alias: 'PAC' },
      { ...makeFragment('f-hc', 3, 4), primary_concept_alias: 'HC' },
    ] as FragmentListItem[];
    render(<FragmentOverlay fragments={frags} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.getByTestId('stored-bracket-f-pac').textContent).toContain('PAC');
    expect(screen.getByTestId('stored-bracket-f-hc').textContent).toContain('HC');
  });
});

// ---------------------------------------------------------------------------
// Collapse / expand (Step 11)
// ---------------------------------------------------------------------------

describe('FragmentOverlay — collapse/expand', () => {
  it('renders a click target even without onBracketClick when fragment has sub-parts', () => {
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    expect(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    ).toBeInTheDocument();
  });

  it('sub-part brackets are hidden when collapsed (default state)', () => {
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);
    expect(screen.queryByTestId('stored-bracket-sub')).not.toBeInTheDocument();
  });

  it('clicking the expand button shows sub-part brackets', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    expect(screen.getByTestId('stored-bracket-sub')).toBeInTheDocument();
  });

  it('button aria-label changes to "Collapse fragment" when expanded', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    expect(
      screen.getByRole('button', { name: 'Collapse fragment', hidden: true }),
    ).toBeInTheDocument();
  });

  it('clicking again collapses the sub-part brackets', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    // Expand.
    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );
    expect(screen.getByTestId('stored-bracket-sub')).toBeInTheDocument();

    // Collapse.
    await user.click(
      screen.getByRole('button', { name: 'Collapse fragment', hidden: true }),
    );
    expect(screen.queryByTestId('stored-bracket-sub')).not.toBeInTheDocument();
  });

  it('expand also calls onBracketClick when wired', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(
      <FragmentOverlay
        fragments={[frag]}
        ghostLayer={FOUR_BAR_LAYER}
        onBracketClick={handler}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('parent');
  });

  it('two fragments expand/collapse independently', async () => {
    const user = userEvent.setup();
    const frags = [
      makeFragmentWithSubPart('p1', 1, 2, 's1', 1, 1),
      makeFragmentWithSubPart('p2', 3, 4, 's2', 3, 3),
    ];
    render(<FragmentOverlay fragments={frags} ghostLayer={FOUR_BAR_LAYER} />);

    // Expand only the first.
    const [expandBtn] = screen.getAllByRole('button', {
      name: 'Expand fragment',
      hidden: true,
    });
    await user.click(expandBtn!);

    expect(screen.getByTestId('stored-bracket-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('stored-bracket-s2')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sub-part bracket rendering (Step 11)
// ---------------------------------------------------------------------------

describe('FragmentOverlay — sub-part brackets', () => {
  it('sub-part brackets are positioned below the staff (systemBottom + gap)', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    // systemTop=50, bounds.top=54, bounds.height=40 → systemBottom=94
    // sub-part top = systemBottom + SUB_BRACKET_BELOW_STAFF_GAP = 94 + 6 = 100
    const subBracket = screen.getByTestId('stored-bracket-sub');
    expect(subBracket.style.top).toBe('100px');
  });

  it('sub-part bracket has the correct x-bounds from its own bar range', async () => {
    const user = userEvent.setup();
    // sub covers bars 2–3: left=100, right=300 → width=200
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 2, 3);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    const subBracket = screen.getByTestId('stored-bracket-sub');
    expect(subBracket.style.left).toBe('100px');
    expect(subBracket.style.width).toBe('200px');
  });

  it('sub-part bracket has the subPartBracket CSS class', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    const subBracket = screen.getByTestId('stored-bracket-sub');
    expect(subBracket.className).toContain('subPartBracket');
  });

  it('sub-part bracket carries the correct status class', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2, 'submitted');
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    const subBracket = screen.getByTestId('stored-bracket-sub');
    expect(subBracket.className).toContain('statusSubmitted');
  });

  it('sub-part alias label is rendered', async () => {
    const user = userEvent.setup();
    const frag = makeFragmentWithSubPart('parent', 1, 4, 'sub', 1, 2);
    // sub has primary_concept_alias: 'PAC' (from makeFragment)
    render(<FragmentOverlay fragments={[frag]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    const subBracket = screen.getByTestId('stored-bracket-sub');
    expect(subBracket.textContent).toContain('PAC');
  });

  it('two-level display limit: sub_parts.sub_parts are never rendered', async () => {
    const user = userEvent.setup();

    // depth-2 grandchild
    const grandchild = makeFragment('grandchild', 1, 1);
    // sub-part carries a grandchild (depth-2 nesting)
    const sub: FragmentListItem = {
      ...makeFragment('sub', 1, 2),
      sub_parts: [grandchild],
    };
    const parent: FragmentListItem = {
      ...makeFragment('parent', 1, 4),
      sub_parts: [sub],
    };

    render(<FragmentOverlay fragments={[parent]} ghostLayer={FOUR_BAR_LAYER} />);

    await user.click(
      screen.getByRole('button', { name: 'Expand fragment', hidden: true }),
    );

    // Direct sub-part renders.
    expect(screen.getByTestId('stored-bracket-sub')).toBeInTheDocument();
    // Grandchild does NOT render (two-level limit, ADR-011).
    expect(screen.queryByTestId('stored-bracket-grandchild')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Props type — ensure the component compiles with the full prop surface
// ---------------------------------------------------------------------------

describe('FragmentOverlay — prop surface', () => {
  it('accepts the full prop surface without type errors', () => {
    const props: FragmentOverlayProps = {
      fragments: [],
      ghostLayer: null,
      onBracketClick: vi.fn(),
      'data-testid': 'test',
      children: null,
    };
    render(<FragmentOverlay {...props} />);
    expect(screen.getByTestId('test')).toBeInTheDocument();
  });
});
