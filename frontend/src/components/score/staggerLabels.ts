/**
 * Two-row packing for bracket labels (M5, Component 12 Step 14).
 *
 * Stage labels run from their own bracket's left edge with `white-space:
 * nowrap` and no collision handling at all, so a one-beat stage (~30px) with a
 * name like "Pre-dominant" (~70px) simply overprints its neighbour. The
 * reported case is "Dominant" over "Final Tonic"; it is the general case.
 *
 * The fix staggers onto a second row — but **only where labels would actually
 * collide**. A permanent stagger would spend vertical budget, and look
 * irregular, on the common case where the names fit; most cadences do fit,
 * and Part 6 Step 15's short stage names will make more of them fit.
 *
 * The packing is deliberately a pure function over measured boxes so it can be
 * unit-tested without a DOM: the hook below does nothing but measure, call
 * this, and write the answer back as an attribute.
 */

import { useLayoutEffect } from 'react';
import { LABEL_MIN_GAP } from './bracketLanes';

/** A measured label: where it starts, how wide it is, and which system row. */
export interface LabelBox {
  left: number;
  width: number;
  /** System row identity — labels only ever collide within one row. */
  lane: number;
}

/**
 * Assign each label to row 0 or row 1, greedily, left to right within a lane.
 *
 * A label goes on row 0 unless it would come within `minGap` of the right edge
 * of the last label already placed on row 0; then it drops to row 1, tracked
 * the same way. Two rows are enough for the adjacency case M5 reports. Three
 * consecutive labels each wider than two brackets would still touch on row 1 —
 * rare, and visibly better than the status quo, which is every label touching.
 *
 * @param boxes Labels in any order; results are returned in the same order.
 * @param minGap Minimum horizontal gap before two labels count as colliding.
 * @returns Row index (0 or 1) per input label, positionally aligned.
 */
export function assignLabelRows(boxes: readonly LabelBox[], minGap = LABEL_MIN_GAP): number[] {
  const rows = new Array<number>(boxes.length).fill(0);

  // Group indices by lane, each sorted left to right.
  const byLane = new Map<number, number[]>();
  boxes.forEach((box, i) => {
    const bucket = byLane.get(box.lane);
    if (bucket) bucket.push(i);
    else byLane.set(box.lane, [i]);
  });

  for (const indices of byLane.values()) {
    indices.sort((a, b) => boxes[a]!.left - boxes[b]!.left);
    // Right edge of the last label placed on each row; -Infinity = row empty.
    const rowEnds = [-Infinity, -Infinity];
    for (const i of indices) {
      const { left, width } = boxes[i]!;
      const row = left >= rowEnds[0]! + minGap ? 0 : 1;
      rows[i] = row;
      rowEnds[row] = Math.max(rowEnds[row]!, left + width);
    }
  }

  return rows;
}

/**
 * Measure the labels inside `containerRef` and stagger the ones that collide.
 *
 * Writes `data-label-row="1"` onto the elements that need the second row and
 * removes it from those that do not; the offset itself is CSS. Going through an
 * attribute rather than React state is what keeps this from looping: measuring
 * a label does not depend on which row it is on, and the effect re-runs after
 * every render anyway, so the assignment always matches the current geometry.
 *
 * Labels opt in with `data-stage-label` and declare their system row with
 * `data-lane`.
 */
export function useStaggeredLabels(
  containerRef: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList
): void {
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-stage-label]'));
    if (nodes.length === 0) return;

    const boxes: LabelBox[] = nodes.map((node) => ({
      left:
        node.offsetLeft +
        (node.offsetParent instanceof HTMLElement ? node.offsetParent.offsetLeft : 0),
      width: node.getBoundingClientRect().width,
      lane: Number(node.dataset.lane ?? 0),
    }));

    const rows = assignLabelRows(boxes);
    rows.forEach((row, i) => {
      const node = nodes[i]!;
      if (row === 1) node.dataset.labelRow = '1';
      else delete node.dataset.labelRow;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
