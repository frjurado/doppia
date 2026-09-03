# Design System Document: The Living Score

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Living Score."** 

This system is an homage to the timeless precision of G. Henle Verlag and the scholarly rigor of Urtext music editions. We are not building a standard digital interface; we are composing a digital folio. The goal is to evoke the tactile sensation of heavy-stock cream paper and the authoritative weight of archival ink. 

The design breaks the "template" look by eschewing standard grids in favor of **intentional asymmetry** and **editorial pacing**. We use high-contrast typography scales and generous white space to allow content to breathe, much like a complex piano score requires room for interpretation. This is a system of "quiet authority"—it does not scream for attention with animations or shadows; it commands respect through its impeccable legibility and structural discipline.

## 2. Colors: The Palette of the Archive
Our color strategy is rooted in the "Henle Blue" and "Urtext Cream," designed to provide a high-contrast yet eye-straining-free reading experience.

*   **Primary (`#3f5f77`):** The iconic blue-grey of a Henle cover. Use this for high-level branding, active states, and primary actions.
*   **Background & Surface (`#fbf9f0`):** The "Urtext Cream." This is the foundational paper tone. It provides a warmer, more sophisticated experience than a sterile digital white.
*   **Neutral Tones:** These are used to create depth through tonal shifts rather than lines.

### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders to section off content. Boundaries must be defined solely through background color shifts. For example, a content block should be defined by placing a `surface-container-low` (`#f6f4eb`) section against a `surface` (`#fbf9f0`) background. 

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. To create depth, stack containers using the following tiers:
1.  **Base:** `surface` (`#fbf9f0`)
2.  **Inset/Secondary Content:** `surface_container_low` (`#f6f4eb`)
3.  **Active/Prominent Modules:** `surface_container_high` (`#eae8df`)
4.  **Highest Importance/Floating:** `surface_container_highest` (`#e4e3da`)

### Signature Textures
To avoid a flat "bootstrap" feel, use **Signature Gradients** for primary CTAs. Transition from `primary` (`#3f5f77`) to `primary_container` (`#587891`) at a 135-degree angle. This provides a subtle "ink-sheen" quality that flat color lacks.

## 3. Typography: The Engraver’s Precision
Typography is the most critical element of this system. It reflects the meticulous nature of music engraving.

*   **The Serif (Newsreader):** Used for all Display, Headline, Title, and Body styles. It is our "Engraver's Voice." It provides the scholarly, high-end editorial feel required for the brand.
*   **The Sans (Public Sans):** Used exclusively for `label-md` and `label-sm` tokens. This is the "Technical Voice," reserved for metadata, captions, and utilitarian micro-copy.

**Hierarchy Strategy:**
*   **Display-LG (3.5rem):** Use for major section headers. Don't be afraid to let these overflow or sit asymmetrically on the page.
*   **Body-LG (1rem):** Set with generous line-height to mimic the readability of a preface in a music book.
*   **The Contrast:** Pair a large `display-sm` title with a `label-md` uppercase subtitle for a sophisticated, archival look.

## 4. Elevation & Depth: Tonal Layering
We reject the heavy drop shadows of the modern web. Depth is achieved through **Tonal Layering**.

*   **The Layering Principle:** Soft lift is achieved by placing a `surface_container_lowest` (`#ffffff`) card onto a `surface_container_low` (`#f6f4eb`) background. The 0px roundedness (as defined in the scale) ensures these layers look like stacked sheets of cardstock.
*   **Ambient Shadows:** If a floating element (like a modal) is required, use an extra-diffused shadow: `blur: 40px`, `opacity: 6%`, using a tint of `on_surface` (`#1b1c17`).
*   **The "Ghost Border" Fallback:** If a container absolutely requires a boundary for accessibility, use the `outline_variant` token at **15% opacity**. Never use a 100% opaque border.
*   **Glassmorphism:** For navigation overlays, use `surface` (`#fbf9f0`) at 80% opacity with a `backdrop-blur` of 12px. This creates a "frosted vellum" effect that allows the underlying "score" to peek through.

## 5. Components
All components must adhere to the **0px Roundedness Scale**. Sharp corners are non-negotiable; they reflect the cut edges of paper.

*   **Buttons:** implemented once, in `frontend/src/components/ui/Button.tsx` (design-debt register **F12**). Do not re-declare these in a module stylesheet; pass a layout-only class if a call site needs positioning. Sizes carry padding only — `md` (`spacing-3`/`spacing-6`) for page surfaces, `sm` (`spacing-2`/`spacing-3`) for panel chrome — because typography is `Type`'s job everywhere in this codebase.
    *   **Primary:** Gradient of `primary` to `primary_container`. Text in `on_primary`. 0px radius.
    *   **Secondary:** The same shape without the gradient — a tonal fill of `surface_container_high` with `primary` text, so the primary action keeps its rank. A fill, not an outline: the no-line rule applies to buttons too.
    *   **Tertiary:** Newsreader serif, underlined with a 1px `primary` line. No container.
    *   **Quiet:** A neutral dismissal (Cancel, Close, Back). No container until hovered.
    *   **Destructive:** A *pair*, never a single treatment — see below.
*   **Segmented controls** (`components/ui/SegmentedControl.tsx`): an exclusive choice among a few short options — staff size, selection grid. A segment always carries a **resting fill of `surface_container_lowest`**, and the selected one takes a **`primary` fill**. Both halves are deliberate. The resting fill is a white card rather than a tonal step because these controls sit on two different layers — the score viewer's toolbar and the fragment viewer's panel — and any step chosen to read against one disappears against the other (§ 4). Without it a lone toggle reads as plain text and an icon segment as decoration. `ToggleButton` is the single-option form of the same thing (the harmony toggle, TAG/Done); it lives in the same module so the two cannot drift.
*   **Icon buttons** (`components/ui/IconButton.tsx`): a bare glyph — transport, close. No container, `primary` on hover, 40% when disabled. `ariaLabel` is required, not optional: a glyph names nothing.
*   **Destructive actions:** the trigger and the confirmation are two different buttons, and the difference is the safeguard.
    *   The **trigger** (Delete, Reject) is never a filled button: `error` ink on no container, hover fills with `error_container`. A filled destructive control sitting beside a filled Save is a control the hand can reach by muscle memory.
    *   The **confirmation** is the only place a solid `error` fill is permitted, and it appears inside an `error_container` well, where it is the one filled thing present. Reaching it always costs a second, deliberate click.
    *   The destructive control is **separated spatially**, not merely ordered last: it sits in the chrome row below the decisions, takes that row's trailing edge (`margin-left: auto`), and is never full-width where the decisions are. Distance is the affordance; a divider line is not available to us (§ 6). See **Action blocks** below for the row it belongs to.
    *   This is the codified version of what the tagging tool already converged on independently in three places (fragment delete, fragment-detail delete, review rejection). Recorded as a precedent during Component 12 Step 14 so the account-deletion UI has one to follow.
*   **Action blocks:** a panel has **one** action block, at its foot, on **one** tonal layer. Never two rows on two backgrounds — that was the state this rule replaced, and it made a four-button panel unreadable.
    *   **Decisions stack full-width.** The editorial panels are ~320px resizable columns; an inline row of four controls cannot read at that width, so decisions are stacked buttons, most consequential last.
    *   **At most one filled button**, and it is the action that moves the record's lifecycle *on the server* — Submit for review, Save changes, Approve. A mode switch such as Edit changes nothing server-side, so it is always secondary; its treatment never depends on what else happens to be on screen.
    *   A **forward action keeps its primary treatment while unavailable**, faded rather than recoloured. A faded primary says "not yet"; a grey box says "a different kind of button".
    *   **Lifecycle chrome** (Edit, Cancel, Delete) sits in one small row beneath the decisions, never full-width and never filled, separated by space rather than a rule (§ 6). The destructive action takes the **trailing edge**.
    *   Semantic wells (a delete confirmation, an approval-gate failure) **nest inside** the block and keep their own colour.
*   **Option controls (radio / checkbox / BOOL):** one family, one row shape. Down a sidebar column these had drifted into three different controls; the rules that hold them together:
    *   **One mark, 16px, in one column.** Property marks, the BOOL mark and the stage swatch are all 16×16 and left-aligned with each other. They were 16, 24 and 14px, so the same gesture had three targets down one column — and the smallest mark carried the largest label.
    *   **The row is flat; only the mark changes colour.** No per-row fill: a fill that reads as a tonal step in one context is invisible in another (`surface-container` rows inside a `surface-container-highest` stage well became pale rectangles inside a grey one; in a `surface-container` panel section the same rows vanished entirely). Hover is the only fill, and it is transient.
    *   **The whole row is the target**, label included — never the mark alone.
    *   **An empty mark is a white card with the ghost outline** (§ 4), not a tonal step, because it has to read on every layer it sits on.
    *   **The selected mark carries the cardinality**, since the 0px rule rules out the conventional circle-vs-square. **A MANY_OF option is a BOOL** — its well fills, exactly like the BOOL "on" state, because a multi-select is a row of independent booleans and should look like one. **A ONE_OF option** gets a solid mark centred inside the well: the square counterpart of a radio's dot. The same marks are used in the dropdown presentation.
    *   **No explanatory text.** A control that has to tell you how it works has already failed.
*   **Explanations (ⓘ):** one implementation, `frontend/src/components/ui/InfoHint.tsx`. Opens on **hover, focus and click**; the panel **floats** and never pushes siblings down; it spans the **full sidebar width**, so a two-word explanation and a two-sentence one produce the same rectangle rather than a shrink-wrapped sliver. It is absolutely positioned against the nearest positioned ancestor, so **give it a full-width one** — that contract is the only thing a call site has to remember.
*   **Input Fields:** Avoid the "box." Use a single 1px underline of `outline` (`#72787d`) and a background of `surface_container_low`. Labels should be `label-md` in `primary`.
*   **Cards:** No borders. Use a background of `surface_container` or `surface_container_high`.
*   **Lists:** **Forbid the use of divider lines.** Use vertical white space (`spacing-4` or `spacing-5`) to separate items.
*   **The Marginalia (Special Component):** A side-column note style using `body-sm` in `on_surface_variant`, positioned asymmetrically to provide scholarly context to the main content.

## 6. Do's and Don'ts

### Do:
*   **Embrace Asymmetry:** Align text to the left but allow images or secondary modules to offset to the right, creating a dynamic, editorial rhythm.
*   **Respect the "Paper":** Use `surface` (`#fbf9f0`) as the primary canvas. It is the soul of the system.
*   **Use Spacing as a Divider:** Use `spacing-10` or `spacing-12` to separate major content blocks instead of lines.

### Don't:
*   **No Rounded Corners:** Never use `border-radius`. Everything must be 0px to maintain the "cut paper" aesthetic.
*   **No Pure Black:** Use `on_background` (`#1b1c17`) for text. Pure `#000000` is too harsh for the "Urtext Cream" background.
*   **No Standard Grids:** Avoid the 12-column "Bootstrap" look. Think in terms of "pockets of content" and "intentional voids."
*   **No High-Contrast Borders:** Never use `outline` at 100% opacity to box in content. It breaks the scholarly flow.

---

## 7. Responsive Addendum

*Added Component 12 Step 12 (2026-08-31). This section is authoritative for
breakpoints, the mobile navigation pattern, and per-surface mobile support. It
is written **before** the topbar redesign (Step 13) and the design-system pass
(Step 14) so both are built to it rather than the reverse. Every measurement
below was taken from the production bundle with real Verovio WASM
(`frontend/e2e/narrow-width.spec.ts`), not estimated.*

### 7.1 Breakpoints

Three, no more. Each earns its place with a reason, not a device name.

| Name | Width | What changes at it |
|---|---|---|
| `sm` | **600px** | Below: single column, disclosure nav, notation is optically scaled. Above: inline nav, notation renders at nominal staff size. |
| `md` | **900px** | Below: two-pane editorial layouts are unusable and are not offered. Above: side-by-side panes. |
| `lg` | **1280px** | The widest content cap; above it the page gutters grow, content does not. |

`sm` is not arbitrary: notation stops being downscaled at a 552px viewport on
fragment detail and 560px on the glossary concept page (§ 7.6). 600 is the
first round number clearing both.

**Write breakpoints as literals, in range notation.** CSS custom properties
are not valid inside `@media` conditions, so a `--bp-sm` token would be
silently useless. Write the query with the name in a comment:

```css
/* < sm — single column, disclosure nav */
@media (width < 600px) { … }
```

Range notation (`width < 600px`, `width >= 600px`) rather than
`max-width: 599px`: it states the boundary exactly, so there is no off-by-one
fudge and no pair of queries that both match at fractional zoom. Stylelint
enforces it (`media-feature-range-notation`). The JS half of the same
boundary lives in `frontend/src/hooks/useMediaQuery.ts` (`BELOW_SM`,
`BELOW_MD`) and uses the identical string — keep the two in step.

### 7.2 Supported-surface matrix

Doppia does not claim blanket mobile support. Each surface commits to one of
three levels, and the level is a design constraint, not an aspiration.

| Surface | Level | Meaning |
|---|---|---|
| Glossary index, concept page, fragment detail, blog reading, collection viewing | **Full** | Designed and verified below `sm`. A defect here is a bug. |
| Exercises (listening especially — no notation needed) | **Full** | Same. |
| Collection editing | **Degrades gracefully** | Reachable and non-destructive below `sm`, but not optimised; may hide secondary affordances. |
| Tagging tool, score viewer, blog authoring, admin, presentation mode | **Desktop-only** | Below `md` these show a "needs a wider screen" notice rather than a broken layout. Never silently render an unusable pane. |

A desktop-only surface must still be *reachable* on a phone — the notice is
part of the design, not a 404.

### 7.3 Layout widths

The measured content caps in the tree today are `62ch` (prose), 640px (list
panels), 720px (glossary / concept), 880px (public browse), 1200px (score
viewer), 1280px (fragment detail), 400px (login). These are the scattered
magic numbers **F10** already names. Step 14 tokenises them; this addendum
fixes the *set* so the tokenisation is a rename, not a redesign:

| Token | Value | Used by |
|---|---|---|
| `--width-prose` | `62ch` | Definition and annotation body text |
| `--width-form` | `400px` | Login, register, single-purpose forms |
| `--width-list` | `640px` | List panels, review queue, profile column |
| `--width-reading` | `720px` | Glossary index, concept page |
| `--width-listing` | `880px` | Public fragment browse, admin tables |
| `--width-wide` | `1280px` | Fragment detail, score viewer |

The score viewer's 1200px unifies **up** to 1280 (F10 left this open; the
score viewer's width interacts with Verovio break behaviour, so confirm on a
render before committing that change).

**Landed in Step 14** as custom properties in `frontend/src/styles/tokens.css`.
Two surfaces the Component 9 survey predated joined the set rather than adding
to it: the admin tables (960px → `--width-listing`) and the profile column
(640px → `--width-list`). Reach for the token that names what the surface *is*;
a new width value needs a reason recorded here first.

Below `sm`, every cap yields to the viewport: `width: 100%` with a
`spacing-4` gutter. Never a horizontal scrollbar on the page — see § 7.6.

### 7.4 Navigation below `sm`

The topbar (Step 13) carries three groups: public nav, a role-gated Editorial
menu, and the account menu. Inline above `sm`; below it they collapse into
**one disclosure panel**, not three separate menus.

- The bar keeps the wordmark and a single menu button. **There is no tagline
  on the bar.** There was one, and this note used to argue about the width at
  which to hide it — first below `sm`, then below `md` once measurement showed
  that a tagline truncated to "OPEN MUSIC …" reads as a defect rather than as
  graceful degradation. Step 14b removed it outright instead: a tagline is
  something a site says once, on arrival, and the landing page now exists to
  say it. Repeated on every screen it was noise, and set in the same face and
  size as the nav links beside it, it read as one of them.

  The rule that survives is the general one it was an instance of: **the bar
  carries nothing that has no function.** It is a frame, not a banner.
- The button opens a full-width panel below the bar, using the existing
  glassmorphism treatment from § 4: `surface` at 80% opacity,
  `backdrop-blur: 12px`. This is the "frosted vellum" case that token was
  written for; do not invent a second overlay style.
- Inside the panel the three groups stack, separated by `spacing-6` and a
  `label-md` uppercase group heading. **No divider lines** — § 5's list rule
  holds here.
- Unshipped surfaces are absent, not greyed out. Role-gated groups are absent
  for users without the role, never shown-and-disabled.
- The panel closes on selection, outside click, and Escape — matching the
  existing account dropdown's behaviour in `NavBar.tsx`.

### 7.5 Touch targets

**Minimum 44 × 44px for any interactive element below `sm`.** Measured at
360px, nothing on the public reading path currently meets this:

| Control | Measured at 360px |
|---|---|
| S / M / L staff-size presets | 33 × 21 |
| MIDI transport (play, stop) | 28 × 22 |
| Language switcher (EN / ES) | 42 × 27 |
| "← Fragment Browser" back link | 156 × 17 |
| Wordmark | 65 × 20 |

Raising these is Step 14's shared control library (**F12**) — the fix belongs
in one place, not seven. Expand the *hit area* with padding, not the visual
box: the 0px-radius, tightly-set look is the design, and growing the painted
control would coarsen it. A transparent padded wrapper preserves the visual
weight while meeting the target.

### 7.6 Notation at narrow widths

The Step 12 technical check. Measured on fragment detail and the glossary
concept page across 360 / 390 / 414 / 552 / 560 / 768 / 1280 / 1920 / 2560.

**How it behaves.** `FragmentNotation` measures its container and clamps
Verovio's `pageWidth` to a 480px floor (`MIN_PAGE_WIDTH`). Below that the SVG
is rendered at 480px and CSS-scaled down to fit. Notation on a phone is
therefore **optically scaled, not reflowed**:

| Viewport | Container | Verovio canvas | Optical scale | Staff height |
|---|---|---|---|---|
| 360 | 288 | 480 | 0.60× | 34px detail / 26px glossary |
| 390 | 318 | 480 | 0.66× | 38 / 29 |
| 414 | 342 | 480 | 0.71× | 41 / 31 |
| 552+ | 480+ | = container | 1.00× | 57 / 44 |

**Verdict: acceptable, kept as is.** A 26px staff is close to Henle print size
physically on a typical phone, so legibility is not the problem. Reflowing
instead (dropping the clamp) would give roughly two bars per system at 360px
and a much longer scroll, for notation no easier to read. The design system
records this as intended behaviour: *below `sm`, notation is presented at
reduced optical scale; the S/M/L presets still apply, uniformly scaled.*

**The overlays survive it.** Bracket overlays are absolutely-positioned HTML
above the SVG (the CLAUDE.md overlay rule) and their geometry is read from
post-layout rects, so main and sub-part brackets stay correctly aligned to
their measures through the downscale, at every width tested. This was the
principal risk in the check and it did not materialise — nothing to fix.

**No horizontal overflow, anywhere.** Document scroll width equals client
width at all nine viewports on both surfaces. The only elements extending past
the viewport edge are inside Verovio's `<defs>`, which is never painted.

**The one real defect: labels do not scale with their brackets.** Sub-part
bracket labels are a fixed 10px and a fixed rendered width at every viewport,
while the brackets they annotate shrink to 60%. At 360px a 28px bracket
carries a 19px "PAC" label, and two adjacent labels read on screen as a single
"PAC PAC" blob. A five-character alias overflows its own bracket at 360px
where it would fit comfortably at 768px — the collision threshold is ~2.4×
worse on a phone. This is the same defect **M5** already lists as "sub-bracket
label collision" (Step 14); the addendum's contribution is that **M5's
redesign must be verified at 360px, not only at desktop width**, and that
label typography needs to scale with the optical scale rather than sit at a
fixed pixel size.

### 7.7 Scoped follow-ups

Neither blocks Step 13.

1. **Glossary example card collapses badly below `sm`.**
   `ConceptExamples.module.css` `.cardHeader` is a three-column flex row with
   a `flex-shrink: 0` 140px preview well and a `flex-shrink: 0` expand hint.
   At 360px that leaves roughly 46px for the metadata column, which wraps to
   one word per line ("MOZART / · / PIANO / SONATA / K. / 279 …"). Fix: below
   `sm` the header becomes `flex-direction: column`, or the preview well
   collapses. This is a **Full**-support surface, so it is a bug, not a
   deferral. Folded into Step 14. **Fixed in Step 14:** the header wraps below
   `sm` and the preview takes the full width with the metadata and hint on the
   line beneath it. Collapsing the preview was the other option in this note
   and was rejected — the incipit is the most useful thing on a glossary
   example, so it is the metadata column that yields.
2. **Sub-part label scaling** — see § 7.6; folded into M5 in Step 14.

`FragmentBrowser.module.css` has the same fixed 140px preview pattern, but it
is a desktop-only surface by § 7.2 and is left alone.
