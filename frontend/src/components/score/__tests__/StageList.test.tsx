/**
 * Tests for StageList bounds display — the sidebar stage cards must show beat
 * precision (not just bar numbers) so an annotator can read e.g.
 * "m. 14, beat 3 – m. 15, beat 1" rather than "m. 14 – 15". (The displayed end
 * beat is the stored exclusive bound stepped back by one when it's a whole
 * number — Component 9 G1.)
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StageList from '../StageList';
import type { StageAssignment } from '../stages';

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

function renderList(assignments: StageAssignment[]) {
  return render(
    <StageList
      assignments={assignments}
      activeStageId={null}
      onStageActivate={vi.fn()}
      onToggleAbsent={vi.fn()}
    />,
  );
}

describe('StageList — bounds display', () => {
  it('shows a cross-bar stage with beats on both sides', () => {
    renderList([
      makeStage({
        bounds: { barStart: 14, beatStart: 3.0, barEnd: 15, beatEnd: 2.0 },
      }),
    ]);
    const card = screen.getByTestId('stage-card-stage-1');
    expect(card.textContent).toContain('m. 14, beat 3 – m. 15, beat 1');
  });

  it('shows beats for a single-bar beat-precise stage', () => {
    renderList([
      makeStage({
        bounds: { barStart: 14, beatStart: 1.0, barEnd: 14, beatEnd: 3.0 },
      }),
    ]);
    expect(screen.getByTestId('stage-card-stage-1').textContent).toContain(
      'm. 14, beats 1–2',
    );
  });

  it('shows a plain measure range for a measure-level stage', () => {
    renderList([makeStage({ bounds: { barStart: 14, beatStart: null, barEnd: 16, beatEnd: null } })]);
    expect(screen.getByTestId('stage-card-stage-1').textContent).toContain('mm. 14–16');
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

  it('groups absent (unbounded) stages after positioned ones', () => {
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
    expect(cards.map((c) => c.dataset['testid'])).toEqual(['stage-card-b', 'stage-card-a']);
  });
});
