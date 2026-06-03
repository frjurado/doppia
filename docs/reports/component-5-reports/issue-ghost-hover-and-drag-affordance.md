# Issue: Ghost Hover State and Drag-Handle Affordance

**Component:** 5 — Score Selection (Step 10, `annotator.ts` + `ghosts.module.css`)  
**Status:** Open  
**Severity:** UX — the tagging tool is functional but the selection affordance is invisible; annotators have no visual feedback before they begin dragging, and no indication that selection endpoints are adjustable.

---

## Background

The ghost layer communicates two distinct things to the annotator:

1. **"You can start a selection here"** — a hover hint before any mouse button is pressed.
2. **"This edge is draggable"** — the gradient fade on ghost endpoints signals that an existing selection can be extended or contracted from that boundary.

The prototype documented both: `'light'` for hover hint, `'dark'` for active/committed selection; gradient edge zones as the drag affordance. Neither is working correctly in the current implementation.

---

## Bug A — No hover state; drag uses the wrong highlight class

**Files:** `frontend/src/components/score/annotator.ts`

### What happens

`_handleMouseOver` (line 449) starts with:

```ts
private _handleMouseOver(e: MouseEvent): void {
  if (!this._dragging) return;   // ← all non-drag mouse-over events discarded
  ...
}
```

There is no `mouseleave` / `mouseout` handler. The result:

- **Hover (no mousedown):** nothing visible happens.
- **During drag (mousedown + move):** `_updateMeasureDrag` / `_updateBeatDrag` / `_updateSubBeatDrag` apply `light` to the dragged range and track those elements in `_litGhosts`.
- **On mouseup (commit):** `_commitMeasureDrag` collects from `_litGhosts`, clears light, then applies `dark` to the committed range.

This inverts the documented semantics. The CSS comment is correct — `light` = hover hint, `dark` = active selection — but the code uses `light` for the in-progress drag and `dark` only for the committed result.

Francisco's observed behaviour matches exactly:
- "On hover nothing actually happens."
- "On click & drag, ghosts are light during selection, then dark on mouseup."
- "When extending from the drag handles, new bars are also light during mousedown."

### Desired behaviour

- **Hover (no mousedown):** `light` on the ghost under the cursor.
- **During drag:** `dark` on the entire range being swept.
- **After commit (mouseup):** `dark` on the committed range (unchanged).

### Fix

Three changes to `annotator.ts`:

**1. Add a hover-ghost tracker field:**

```ts
private _hoverGhost: HTMLElement | null = null;
```

**2. Split `_handleMouseOver` into hover vs. drag paths, and add a `mouseleave` handler:**

```ts
private _handleMouseOver(e: MouseEvent): void {
  const ghost = ghostFromTarget(e.target);

  if (!this._dragging) {
    // Hover hint: light on the ghost under the cursor.
    if (ghost !== this._hoverGhost) {
      if (this._hoverGhost) removeClass(this._hoverGhost, 'light');
      this._hoverGhost = ghost;
      if (ghost) addClass(ghost, 'light');
    }
    return;
  }

  // In-progress drag — existing logic, but using 'dark' (see change 3).
  if (!ghost) return;
  const key = ghostDataKey(ghost);
  if (key === null) return;
  // ... (resolution dispatch, unchanged)
}

private _handleMouseLeave(): void {
  // Cursor has left the overlay entirely — clear hover hint.
  if (this._hoverGhost) {
    removeClass(this._hoverGhost, 'light');
    this._hoverGhost = null;
  }
}
```

Register the `mouseleave` listener alongside the others in `_attachListeners()`:

```ts
const onMouseLeave = () => this._handleMouseLeave();
overlay.addEventListener('mouseleave', onMouseLeave);
this._cleanup.push(() => overlay.removeEventListener('mouseleave', onMouseLeave));
```

Also clear hover state on `mousedown` (the hover hint should disappear the instant the drag starts):

```ts
private _handleMouseDown(e: MouseEvent): void {
  // Clear hover hint before starting the drag.
  if (this._hoverGhost) {
    removeClass(this._hoverGhost, 'light');
    this._hoverGhost = null;
  }
  // ... existing logic
}
```

**3. Change drag highlighting from `light` to `dark`:**

In `_updateMeasureDrag`, `_updateBeatDrag`, and `_updateSubBeatDrag`, replace every occurrence of:

```ts
this._clearLight();
...
addClass(entry.el, 'light');
this._litGhosts.add(entry.el);
```

with:

```ts
this._clearDark();
...
addClass(entry.el, 'dark');
this._darkGhosts.add(entry.el);
```

The commit methods (`_commitMeasureDrag`, `_commitBeatDrag`, `_commitSubBeatDrag`) already collect from `_litGhosts` and then rebuild `_darkGhosts`. After this change they should collect from `_darkGhosts` instead:

```ts
// Before (collect the in-progress range from litGhosts):
for (const el of this._litGhosts) { ... }
this._clearLight();
this._clearDark();
for (const entry of entries) {
  addClass(entry.el, 'dark');
  this._darkGhosts.add(entry.el);
}

// After (darkGhosts already holds the drag range; just re-sort and confirm):
for (const el of this._darkGhosts) { ... }
// _clearDark() + re-add is still needed to re-sort and re-build _selection cleanly.
this._clearDark();
for (const entry of entries) {
  addClass(entry.el, 'dark');
  this._darkGhosts.add(entry.el);
}
```

The endpoint re-selection check (`if (this._darkGhosts.size >= 2)` at the start of `_startMeasureDrag`) remains correct: `_darkGhosts` holds the committed selection at `mousedown` time (no drag is in progress), and the in-progress drag is initiated fresh from `_clearAllHighlights()` or the endpoint re-anchor path.

---

## Bug B — Ghost gradient zones invisible against the ghost body

**Files:** `frontend/src/components/score/ghosts.module.css`

### What happens

There are two overlapping problems.

**Problem 1 — No `.ghost.light` rules for edge/gradient children.**

`ghosts.module.css` shows edge and gradient only on `.ghost.dark`:

```css
:global(.ghost.dark .ghost-edge) { opacity: 0.7; }
:global(.ghost.dark .ghost-gradient) { opacity: 1; }
```

There are no corresponding rules for `.ghost.light`. Even after Bug A is fixed (hover applies `light`), hovering over an endpoint measure will not reveal the gradient affordance.

**Problem 2 — Gradient merges with the ghost body.**

The `.ghost` element itself carries `background-color: var(--color-primary)` when `light` or `dark`. The `.ghost-gradient` children are positioned *inside* that same div and use the same primary colour. Because both the parent background and the gradient share the same hue, the gradient is visually absorbed into the body fill — it creates a slightly more opaque zone at the edges rather than a clear directional fade. The intended affordance ("this edge is draggable") is not legible.

The `MainBracket.module.css` comment acknowledges this dependency:

> "The ghost layer's own gradient zones provide the interactive affordance; this is decorative."

The bracket's own handle decorations are purely cosmetic; the affordance is supposed to come from ghost gradients. Both are currently not delivering on it.

### Desired behaviour

On hover of any ghost (after Bug A is fixed), the gradient zones at its left and right edges should be clearly visible, fading from the selection colour to transparent. This communicates that both boundaries are draggable regardless of which is the current selection endpoint.

### Fix

**1. Add `.ghost.light` rules for edge and gradient:**

```css
/* Show drag affordance on hover (light state) */
:global(.ghost.light .ghost-edge) {
  opacity: 0.7;
}

:global(.ghost.light .ghost-gradient) {
  opacity: 1;
}
```

**2. Reduce ghost body opacity so the gradient is visible against it.**

The current `.ghost.light` opacity of `0.35` on the whole element (including the gradient children) means the gradient fades from `~0.35 × 0.6 = 21%` down to `0%` on top of a `35%`-opaque body — a small relative change. Reducing the body opacity and relying on the edge/gradient children for the colour differentiation makes the fade more legible:

```css
:global(.ghost.light) {
  opacity: 0.18;   /* body tint only: low opacity, colour comes from children */
  background-color: var(--color-primary, #3f5f77);
}

:global(.ghost-gradient-left) {
  background: linear-gradient(
    to right,
    var(--color-primary, #3f5f77),  /* solid at the edge */
    transparent
  );
}

:global(.ghost-gradient-right) {
  background: linear-gradient(
    to left,
    var(--color-primary, #3f5f77),  /* solid at the edge */
    transparent
  );
}
```

With a lower body opacity, the gradient children (which render at `parent-opacity × child-opacity` effective on the page) produce a clearly visible fade from solid-edge to light-tint-center. The `dark` state (committed selection) can retain its current body opacity (`0.45`/`0.55`), as there the gradient just reinforces the boundary visibility rather than being the primary affordance.

---

## Non-issue: `pointer-events: none` on gradient zones

`ghosts.module.css` line 68 sets `pointer-events: none` on `.ghost-gradient`. This is correct: `ghostFromTarget()` uses `.closest('.ghost')` to walk up from any event target (including gradient children) to the containing ghost element. Mouse events on gradient zones therefore correctly identify the parent ghost, and endpoint re-selection works. The `pointer-events: none` on gradients is not a bug.

---

## Testing

After both fixes:

- Hovering over any measure ghost (no mousedown) should produce a visible tint with gradient fades at both edges.
- Beginning a drag should immediately darken the ghost under the cursor and the tint should extend to cover the full swept range as dark.
- Committing (mouseup) should leave the range dark.
- Moving the cursor off the overlay entirely should clear all hover tints.
- Existing Vitest tests for the selection state model and endpoint re-selection should continue to pass unchanged (the `light`/`dark` class names in the test assertions will need updating to reflect the new assignment of classes to drag vs. hover).
