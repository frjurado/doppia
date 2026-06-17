/**
 * Tests for StageList bounds display — the sidebar stage cards must show beat
 * precision (not just bar numbers) so an annotator can read e.g.
 * "m. 14, beat 3 – m. 15, beat 2" rather than "m. 14 – 15".
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
    expect(card.textContent).toContain('m. 14, beat 3 – m. 15, beat 2');
  });

  it('shows beats for a single-bar beat-precise stage', () => {
    renderList([
      makeStage({
        bounds: { barStart: 14, beatStart: 1.0, barEnd: 14, beatEnd: 3.0 },
      }),
    ]);
    expect(screen.getByTestId('stage-card-stage-1').textContent).toContain(
      'm. 14, beats 1–3',
    );
  });

  it('shows a plain measure range for a measure-level stage', () => {
    renderList([makeStage({ bounds: { barStart: 14, beatStart: null, barEnd: 16, beatEnd: null } })]);
    expect(screen.getByTestId('stage-card-stage-1').textContent).toContain('mm. 14–16');
  });
});
