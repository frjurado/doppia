/**
 * The one vertical lane table for every bracket surface (M5, Component 12
 * Step 14).
 *
 * Three surfaces draw brackets around a staff — `StageBrackets` (live stages),
 * `FragmentOverlay` (stored parents and sub-parts) and `FragmentNotation` (the
 * read-only fragment viewer) — and until this module each carried a private
 * copy of the geometry. There was a fourth, `MainBracket`, until the live
 * selection bracket was removed as redundant with the ghost layer. That is what
 * produced the collisions M5 was raised for: `FragmentOverlay` deliberately
 * matched `StageBrackets`' `BELOW_STAFF_GAP` so stored sub-parts would "sit in
 * the same lane as live stage brackets", and they duly landed on top of each
 * other. A lane can only be double-booked when two files each believe they own
 * it.
 *
 * Only the *vertical* half of the backlog's bracket-geometry unification lives
 * here, which is the half M5 needs. Per-system horizontal projection
 * (`stageFrame.ts`, `resolveSegments`) is deliberately untouched — it carries
 * the M7 beat-precision clipping fix and invariant I7, and has no bearing on
 * these collisions.
 *
 * ## Reading the table
 *
 * `ABOVE` values are distances **above** a system's top; `BELOW` values are
 * distances **below** a system's bottom. Both grow away from the staff, so a
 * larger number is always further from the music.
 *
 * Labels always sit on the far side of their bracket from the staff — above
 * for above-staff brackets, below for below-staff ones. Nothing hangs inward
 * into a neighbouring lane, which is the rule that retires the above-staff
 * collision.
 */

// ---------------------------------------------------------------------------
// Bracket weights
// ---------------------------------------------------------------------------

/** Live stage bracket. */
export const STAGE_BRACKET_H = 6;

/** Stored parent-fragment bracket. */
export const STORED_BRACKET_H = 4;

/**
 * Stored sub-part bracket — thinner than a parent, so rank reads off weight
 * even where colour and status happen to match (M5 ask 2).
 */
export const SUB_BRACKET_H = 3;

/**
 * Length of the square serif dropped at each end of a *committed* bracket
 * (M5 ask 1). The end treatment is what distinguishes committed from editable:
 * a serif says the span is closed, a gradient fade says the end is grabbable.
 */
export const SERIF_LEN = 5;

/** Thickness of that serif. */
export const SERIF_W = 2;

// ---------------------------------------------------------------------------
// Above the staff
// ---------------------------------------------------------------------------

/**
 * Stored parent brackets — the only above-staff lane.
 *
 * It was 16, sharing the space with a live selection bracket 9px above the
 * staff; 3px of clearance made the two read as one two-tone bar, and left no
 * room for a serif. Moving the stored lane out to 26 fixed that, and removing
 * the live bracket then let it come back in to 14: far enough that a 5px serif
 * clears the staff, close enough that the label above it does not reach into
 * the system overhead.
 *
 * The distance matters beyond tidiness. Brackets colliding with the *adjacent
 * system* is the collision that actually bites, and every pixel of above-staff
 * stack is a pixel closer to it.
 */
export const ABOVE_STORED = 14;

// ---------------------------------------------------------------------------
// Below the staff
// ---------------------------------------------------------------------------

/**
 * Live stage brackets. Must clear the harmony label lane, which starts at
 * +6 and runs about 12px (see `harmonyOverlay.module.css`).
 */
export const BELOW_STAGE = 20;

/**
 * Stored sub-part brackets — the same lane as live stage brackets.
 *
 * They shared it by accident before, and collided. They share it deliberately
 * now, because they can no longer both be on screen: a stored fragment's
 * sub-parts are shown only while that fragment is the selected one, and
 * entering an annotation clears the selection. Giving them separate lanes cost
 * ~28px of vertical budget per system to separate two things that never
 * co-occur — and that budget is what pushes a system's brackets into its
 * neighbour, which is the collision that actually bites.
 */
export const BELOW_SUB_PART = BELOW_STAGE;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Gap between a bracket edge and its label. */
export const LABEL_GAP = 2;

/** Label line height, used when reserving space for a second label row. */
export const LABEL_LINE_H = 13;

/**
 * Extra offset applied to a stage label pushed onto the second row.
 *
 * Stage labels stagger **only where they would otherwise collide** — see
 * `useStaggeredLabels`. A permanent two-row stagger would spend the vertical
 * budget, and look irregular, on the common case where the names fit.
 */
export const LABEL_ROW_2_OFFSET = LABEL_GAP + LABEL_LINE_H;

/** Minimum horizontal gap two labels must keep before they count as colliding. */
export const LABEL_MIN_GAP = 6;

// ---------------------------------------------------------------------------
// Reserved space
// ---------------------------------------------------------------------------

/**
 * Headroom a surface must reserve above its first system so nothing in the
 * above-staff stack is clipped: the outermost lane plus its label.
 */
export const ABOVE_RESERVE = ABOVE_STORED + LABEL_GAP + LABEL_LINE_H;

/**
 * Space a surface must reserve below its last system: the outermost below-staff
 * lane, its bracket, and two label rows (the stagger's worst case).
 */
export const BELOW_RESERVE =
  BELOW_SUB_PART + SUB_BRACKET_H + LABEL_GAP + LABEL_LINE_H + LABEL_ROW_2_OFFSET;
