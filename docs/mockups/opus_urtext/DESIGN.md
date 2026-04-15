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

*   **Buttons:**
    *   **Primary:** Gradient of `primary` to `primary_container`. Text in `on_primary`. 0px radius. Padding: `spacing-3` (vertical) / `spacing-6` (horizontal).
    *   **Tertiary:** Newsreader serif, underlined with a 1px `primary` line. No container.
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