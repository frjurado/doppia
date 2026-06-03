/**
 * Inline SVG icons for the measure/beat/sub-beat resolution toggle (G4.4).
 *
 * MeasureIcon — a small staff enclosed by two barlines.
 * NoteIcon    — a rendered note value (whole through sixteenth, with optional dot).
 * ResolutionIcon — picks the correct icon for a given ResolutionMode + time signature.
 *
 * Icons use currentColor so they inherit the button's text colour and respond
 * to active/hover state without any extra CSS.
 */

import type { ResolutionMode } from './ghosts';
import { isCompoundMeter } from './ghosts';

// ── Note-value vocabulary ─────────────────────────────────────────────────────

type NoteType =
  | 'whole'
  | 'half'
  | 'quarter'
  | 'dotted-quarter'
  | 'eighth'
  | 'sixteenth';

/**
 * Map a time signature to the note values that represent one beat and one
 * sub-beat in the resolution toggle.
 *
 * Compound meters (6/8, 9/8, 12/8): beat = dotted quarter, sub-beat = eighth.
 * Simple meters: beat = denominator note value, sub-beat = one level shorter.
 */
function noteIconsForMeter(
  beatCount: number,
  beatUnit: number,
): { beat: NoteType; subbeat: NoteType } {
  if (isCompoundMeter(beatCount, beatUnit)) {
    return { beat: 'dotted-quarter', subbeat: 'eighth' };
  }
  switch (beatUnit) {
    case 1:  return { beat: 'whole',   subbeat: 'half'    };
    case 2:  return { beat: 'half',    subbeat: 'quarter' };
    case 8:  return { beat: 'eighth',  subbeat: 'sixteenth' };
    default: return { beat: 'quarter', subbeat: 'eighth'  };
  }
}

// ── Shared note-head geometry (viewBox "0 0 14 22") ──────────────────────────
//
// All note icons share a single viewBox so they render at identical pixel size.
// Notehead sits near the bottom; the stem rises to the upper portion.

const NH = { cx: 5, cy: 17, rx: 3.8, ry: 2.6 } as const;
const NH_TRANSFORM = `rotate(-15 ${NH.cx} ${NH.cy})`;
const STEM_X   = 8.5;
const STEM_TOP = 4;
const STEM_BOT = 16.5;

// ── Measure icon ─────────────────────────────────────────────────────────────

/** Five-line staff bounded by two barlines. Aspect ratio ≈ 4:3 (landscape). */
function MeasureIcon() {
  const STAFF_Y  = [3, 6, 9, 12, 15] as const;
  const LINE_X1  = 3;
  const LINE_X2  = 21;
  const BAR_Y1   = STAFF_Y[0];
  const BAR_Y2   = STAFF_Y[4];

  return (
    <svg
      viewBox="0 0 24 18"
      width="20"
      height="15"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {STAFF_Y.map((y) => (
        <line
          key={y}
          x1={LINE_X1}
          y1={y}
          x2={LINE_X2}
          y2={y}
          stroke="currentColor"
          strokeWidth="0.9"
        />
      ))}
      <line x1={LINE_X1} y1={BAR_Y1} x2={LINE_X1} y2={BAR_Y2} stroke="currentColor" strokeWidth="1.3" />
      <line x1={LINE_X2} y1={BAR_Y1} x2={LINE_X2} y2={BAR_Y2} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

// ── Note icon ─────────────────────────────────────────────────────────────────

/** A single note value rendered as a minimal inline SVG. */
function NoteIcon({ type }: { type: NoteType }) {
  const isOpen   = type === 'whole' || type === 'half';
  const hasStem  = type !== 'whole';
  const isDotted = type === 'dotted-quarter';
  const hasFlag1 = type === 'eighth' || type === 'sixteenth';
  const hasFlag2 = type === 'sixteenth';

  // Flag paths: cubic Bézier from stem top, sweeping right then back to stem.
  const flag1 = `M ${STEM_X},${STEM_TOP} C ${STEM_X + 5},${STEM_TOP + 1} ${STEM_X + 5},${STEM_TOP + 8} ${STEM_X},${STEM_TOP + 9}`;
  const flag2 = `M ${STEM_X},${STEM_TOP + 3} C ${STEM_X + 5},${STEM_TOP + 4} ${STEM_X + 5},${STEM_TOP + 11} ${STEM_X},${STEM_TOP + 12}`;

  return (
    <svg
      viewBox="0 0 16 22"
      width="11"
      height="15"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {/* notehead */}
      <ellipse
        cx={NH.cx}
        cy={NH.cy}
        rx={NH.rx}
        ry={NH.ry}
        transform={NH_TRANSFORM}
        fill={isOpen ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={isOpen ? 1.4 : 0}
      />
      {/* stem */}
      {hasStem && (
        <line
          x1={STEM_X}
          y1={STEM_BOT}
          x2={STEM_X}
          y2={STEM_TOP}
          stroke="currentColor"
          strokeWidth="1.2"
        />
      )}
      {/* flags */}
      {hasFlag1 && (
        <path d={flag1} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
      {hasFlag2 && (
        <path d={flag2} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
      {/* augmentation dot — cx=12.5 keeps it clear of the notehead right edge
          and well within the 16-unit viewBox; r=2.0 renders at ~2.7 px display */}
      {isDotted && (
        <circle
          cx={12.5}
          cy={NH.cy}
          r={2.0}
          fill="currentColor"
        />
      )}
    </svg>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface ResolutionIconProps {
  mode: ResolutionMode;
  beatCount: number;
  beatUnit: number;
}

/**
 * Renders the appropriate glyph for a resolution-toggle button.
 *
 * - measure   → staff-with-barlines SVG
 * - beat       → note value for one beat in the active time signature
 * - subbeat    → note value for one sub-beat in the active time signature
 */
export function ResolutionIcon({ mode, beatCount, beatUnit }: ResolutionIconProps) {
  if (mode === 'measure') {
    return <MeasureIcon />;
  }
  const { beat, subbeat } = noteIconsForMeter(beatCount, beatUnit);
  return <NoteIcon type={mode === 'beat' ? beat : subbeat} />;
}
