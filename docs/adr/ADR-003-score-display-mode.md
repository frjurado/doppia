# ADR-003 — Score Display Mode

**Status:** Accepted
**Date:** 2026-03-27

---

## Context

The score viewer renders MEI files in the browser using Verovio (WASM). For a complete movement — which may span 100–300 bars — Verovio produces a multi-page SVG output. The display mode determines how those pages are presented to the user and how MIDI playback position is synchronised with the visible notation.

Three display modes are viable:

**Horizontal infinite scroll** — the score extends rightward as a single continuous system, scrolling on the horizontal axis. This mirrors the physical experience of unrolling a scroll or advancing a piano roll. The scroll axis is semantically aligned with musical time, which can feel natural during playback. It is unusual for web interfaces and requires horizontal scroll events, which are less ergonomic with most input devices (trackpad gestures work; mouse wheels typically do not without a modifier key). Synchronising the playback position with the horizontal scroll position is non-trivial.

**Vertical infinite scroll** — systems stack downward in the standard web layout. The user scrolls vertically through the score as through any long web page. This is the most familiar pattern for web-based document viewing. Verovio's multi-page SVG output maps directly onto this layout: each page is rendered as an SVG block, displayed in sequence, without gaps. MIDI playback synchronisation follows the standard pattern of scrolling the viewport to keep the currently playing element visible.

**Pagination** — one page at a time, with explicit page-turn controls. Each page is a complete Verovio-rendered SVG. Clean rendering, minimal DOM footprint (only one page in view at a time). Disrupts continuous listening: page turns interrupt the visual flow during playback and require UI affordances (arrows, keyboard shortcuts, swipe gestures). Most appropriate for a print-preview context, not an interactive analysis tool.

The score viewer is used in two contexts in Phase 1: (1) the tagging tool, where an annotator browses a movement to select fragments, and (2) the fragment detail view, where a specific excerpt is displayed in isolation. Context (2) is always a short excerpt and the display mode question is largely moot; context (1) drives the decision.

The Phase 2 blog feature has a specific additional requirement: a **horizontal scrollytelling layout** where notation advances in sync with the reader's scroll position. This is a different interaction mode from general score viewing, driven by authoring intent rather than user navigation. It will need to be built regardless of the general display mode decision.

---

## Decision

Use **vertical infinite scroll** as the default display mode for the score viewer in Phase 1.

Verovio renders multi-page SVG output natively. Displaying pages stacked vertically requires no transformation of Verovio's output: each page SVG is inserted into the DOM in sequence, and the browser's native scroll handles the rest. MIDI playback synchronisation follows a straightforward pattern: on each tick, call `verovio.getElementsAtTime()` to identify the currently sounding element, then scroll the viewport to keep that element centred.

The SVG overlay layer for fragment brackets and playback indicators is positioned absolutely relative to a container element that spans the full score height. This is the correct architecture for vertical scroll and is also compatible with a future horizontal toggle: switching display modes would change the primary scroll axis of the container, not the overlay positioning logic.

Horizontal scroll is not implemented in Phase 1 for the general score viewer. It is deferred until the blog's scrollytelling layout is built in Phase 2, at which point both horizontal modes (scrollytelling and general horizontal) can share the same scroll infrastructure.

---

## Consequences

**Positive**

- Direct mapping to Verovio's output format. Verovio generates pages; vertical scroll displays pages. No layout transformation is required.
- Familiar interaction model. Vertical scroll is the default web convention. Users who have never used the tool can navigate it without explanation.
- MIDI synchronisation is straightforward. Keeping a playing element in the viewport by scrolling vertically is a well-understood pattern with a clear implementation path.
- Compatible with the overlay architecture. The absolutely-positioned SVG overlay layer for fragment brackets works correctly over a vertically scrolling score.
- Progressive rendering is natural. Verovio can render pages one at a time; displaying them as they complete gives the user something to read immediately on large scores rather than waiting for a full render.

**Negative**

- Vertical scroll is not semantically aligned with musical time moving left to right. For users accustomed to reading music from a physical score, this is a minor conceptual mismatch.
- Long movements produce very tall pages. At small staff sizes, a 200-bar sonata movement could produce a DOM height of several thousand pixels. This is well within browser rendering capability and does not require virtualisation at Phase 1 corpus scale.

**Neutral**

- The horizontal scrollytelling layout needed for the Phase 2 blog is a distinct feature with its own scroll logic, not an extension of the general viewer. The decision to use vertical scroll for the general viewer does not constrain or complicate the scrollytelling implementation.
- A user-facing toggle between vertical scroll and horizontal scroll can be added in Phase 2. The architecture supports it: switching scroll axis is a layout change, not a data model change.

---

## Alternatives considered

**Horizontal infinite scroll (general viewer).** Rejected for Phase 1. The implementation complexity of horizontal scroll synchronisation, the ergonomic limitations with standard input devices, and the unfamiliarity of the interaction pattern for a web interface are all costs with no compensating benefit at this stage. Deferred for reconsideration if user feedback in Phase 2 requests it.

**Pagination.** Rejected. Page turns interrupt playback continuity and add UI affordances (navigation controls, keyboard shortcuts) that add development cost without improving the core use case — browsing a movement to find and tag fragments. The tagging tool benefits from continuous scrolling; pagination works against it.
