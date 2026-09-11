/**
 * Tests for StageList — sidebar stage cards (Component 9 G2 ordering +
 * Part 8 item 4 sidebar rework):
 *
 *  - Cards no longer repeat the measure/beat bounds (visible on the score
 *    brackets); the status row appears only for absent/orphaned/error states.
 *  - Stage property forms are always open for present stages — activation
 *    only highlights, it no longer gates the form.
 *  - Cards order by physical position in the score (G2), and the order
 *    freezes for the duration of a split-handle drag (freezeOrder) so cards
 *    don't jump mid-gesture, resorting once on release.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StageList from '../StageList';
import type { StageAssignment } from '../stages';

// StageList's gating/ordering is under test, not the form itself — replace
// SubPartForm with a marker div (it fetches schemas on mount otherwise).
vi.mock('../SubPartForm', () => ({
  default: ({ stageId }: { stageId: string }) => <div data-testid={`subpart-form-${stageId}`} />,
}));

function makeStage(overrides: Partial<StageAssignment> = {}): StageAssignment {
  return {
    stageId: 'stage-1',
    stageName: 'Predominant',
    order: 1,
    required: true,
    displayMode: 'stage',
    containmentMode: 'contiguous',
    defaultWeight: 1,
    bounds: { barStart: 14, beatStart: null, barEnd: 14, beatEnd: null },
    confirmed: true,
    absent: false,
    orphaned: false,
    error: false,
    ...overrides,
  };
}

function renderList(
  assignments: StageAssignment[],
  extraProps: Partial<Parameters<typeof StageList>[0]> = {}
) {
  return render(
    <StageList
      assignments={assignments}
      activeStageId={null}
      onStageActivate={vi.fn()}
      onToggleAbsent={vi.fn()}
      {...extraProps}
    />
  );
}

describe('StageList — status row (Part 8 item 4)', () => {
  it('shows no bounds text on a healthy card', () => {
    renderList([
      makeStage({
        bounds: { barStart: 14, beatStart: 3.0, barEnd: 15, beatEnd: 2.0 },
      }),
    ]);
    const card = screen.getByTestId('stage-card-stage-1');
    expect(card.textContent).not.toContain('m. 14');
    expect(card.textContent).not.toContain('15');
  });

  it('still labels an absent stage', () => {
    renderList([makeStage({ required: false, absent: true, bounds: null })]);
    expect(screen.getByTestId('stage-card-stage-1').textContent).toContain('absent');
  });

  it('still warns on an orphaned stage', () => {
    renderList([makeStage({ orphaned: true })]);
    const card = screen.getByTestId('stage-card-stage-1');
    expect(card.textContent?.length).toBeGreaterThan('Predominant'.length);
  });
});

describe('StageList — always-open property forms (Part 8 item 4)', () => {
  it('renders the form for every present stage with no activation', () => {
    renderList([makeStage({ stageId: 'a', order: 0 }), makeStage({ stageId: 'b', order: 1 })], {
      onSubPartTagUpdate: vi.fn(),
    });
    expect(screen.getByTestId('subpart-form-a')).toBeInTheDocument();
    expect(screen.getByTestId('subpart-form-b')).toBeInTheDocument();
  });

  it('renders no form for absent or orphaned stages', () => {
    renderList(
      [
        makeStage({ stageId: 'a', order: 0, required: false, absent: true, bounds: null }),
        makeStage({ stageId: 'b', order: 1, orphaned: true }),
      ],
      { onSubPartTagUpdate: vi.fn() }
    );
    expect(screen.queryByTestId('subpart-form-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subpart-form-b')).not.toBeInTheDocument();
  });
});

describe('StageList — ordering (Component 9 G2)', () => {
  it('orders cards by their position in the score, not the schema order', () => {
    // Schema order is Consequent(0) before Antecedent(1), but Antecedent is
    // positioned earlier in the score (m. 10 vs m. 20) — the list must read
    // top-to-bottom as the stages actually appear in the music.
    renderList([
      makeStage({
        stageId: 'consequent',
        stageName: 'Consequent',
        order: 0,
        bounds: { barStart: 20, beatStart: null, barEnd: 24, beatEnd: null },
      }),
      makeStage({
        stageId: 'antecedent',
        stageName: 'Antecedent',
        order: 1,
        bounds: { barStart: 10, beatStart: null, barEnd: 14, beatEnd: null },
      }),
    ]);
    const cards = screen.getAllByTestId(/^stage-card-/);
    expect(cards.map((c) => c.dataset['testid'])).toEqual([
      'stage-card-antecedent',
      'stage-card-consequent',
    ]);
  });

  it('keeps an absent (unbounded) stage in its place in the sequence', () => {
    // Changed in Component 12 Step 18 (M9). Absent stages used to be grouped
    // after every positioned one, so disabling a stage threw its card to the
    // bottom of the list. It now holds its slot: stage `a` has schema order 0,
    // so it stays above `b` even with no bounds to sort by.
    renderList([
      makeStage({
        stageId: 'a',
        order: 0,
        bounds: null,
        absent: true,
        required: false,
      }),
      makeStage({
        stageId: 'b',
        order: 1,
        bounds: { barStart: 10, beatStart: null, barEnd: 14, beatEnd: null },
      }),
    ]);
    const cards = screen.getAllByTestId(/^stage-card-/);
    expect(cards.map((c) => c.dataset['testid'])).toEqual(['stage-card-a', 'stage-card-b']);
  });

  it('places an absent stage between the positioned stages it sits between', () => {
    // The M9 case as reported: four stages, the second disabled. Its card must
    // stay second rather than jumping past the third and fourth.
    renderList([
      makeStage({
        stageId: 'one',
        order: 1,
        bounds: { barStart: 1, beatStart: null, barEnd: 1, beatEnd: null },
      }),
      makeStage({ stageId: 'two', order: 2, bounds: null, absent: true, required: false }),
      makeStage({
        stageId: 'three',
        order: 3,
        bounds: { barStart: 3, beatStart: null, barEnd: 3, beatEnd: null },
      }),
      makeStage({
        stageId: 'four',
        order: 4,
        bounds: { barStart: 4, beatStart: null, barEnd: 4, beatEnd: null },
      }),
    ]);
    const cards = screen.getAllByTestId(/^stage-card-/);
    expect(cards.map((c) => c.dataset['testid'])).toEqual([
      'stage-card-one',
      'stage-card-two',
      'stage-card-three',
      'stage-card-four',
    ]);
  });
});

describe('StageList — order freeze during drag (Part 8 item 4)', () => {
  const stageA = (barStart: number) =>
    makeStage({
      stageId: 'a',
      order: 0,
      bounds: { barStart, beatStart: null, barEnd: barStart, beatEnd: null },
    });
  const stageB = (barStart: number) =>
    makeStage({
      stageId: 'b',
      order: 1,
      bounds: { barStart, beatStart: null, barEnd: barStart, beatEnd: null },
    });

  const order = () => screen.getAllByTestId(/^stage-card-/).map((c) => c.dataset['testid']);

  it('keeps the pre-drag order while frozen, resorts on release', () => {
    // Initial: a(10) before b(20).
    const view = renderList([stageA(10), stageB(20)], { freezeOrder: false });
    expect(order()).toEqual(['stage-card-a', 'stage-card-b']);

    // Mid-drag the bounds swap (a moves past b) — frozen, so no reorder.
    view.rerender(
      <StageList
        assignments={[stageA(30), stageB(20)]}
        activeStageId={null}
        onStageActivate={vi.fn()}
        onToggleAbsent={vi.fn()}
        freezeOrder={true}
      />
    );
    expect(order()).toEqual(['stage-card-a', 'stage-card-b']);

    // Release: resorts by position exactly once.
    view.rerender(
      <StageList
        assignments={[stageA(30), stageB(20)]}
        activeStageId={null}
        onStageActivate={vi.fn()}
        onToggleAbsent={vi.fn()}
        freezeOrder={false}
      />
    );
    expect(order()).toEqual(['stage-card-b', 'stage-card-a']);
  });
});
