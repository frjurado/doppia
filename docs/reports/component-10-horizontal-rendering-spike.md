# Horizontal single-system rendering spike — findings

**Component 10, Part 5, Step 12.** Throwaway spike; its only deliverable is this
report. De-risks the horizontal single-system + scroll-synced-playback layout
that **Component 16 (scrollytelling)** will depend on, months before it does.

**Bottom line: Verovio does not fight us.** Single-system layout holds at
movement length with no clipping or wrapping; playback→scroll sync is accurate;
frame rate stays at 55–60 fps even on a 47 000 px-wide score. The one rough edge
— steppy scrolling — is a spike implementation detail (discrete per-note scroll
jumps), not a Verovio or browser limitation, and is trivially fixable with
continuous interpolation. Component 16's horizontal scrollytelling is viable on
the current path.

---

## The question

Does Verovio fight us when we render a **whole movement as one horizontal
system** and drive **horizontal auto-scroll from MIDI playback position**?
Specifically: (1) does `breaks: 'none'` hold at movement length; (2) does
horizontal scroll stay in sync and feel smooth; (3) what are the performance /
layout-stability limits?

---

## Method

The spike is a **dev-only** route, `/spike/horizontal`
([frontend/src/routes/spike/HorizontalRenderSpike.tsx](../../frontend/src/routes/spike/HorizontalRenderSpike.tsx)),
gated behind `import.meta.env.DEV` in `App.tsx` so it never ships to production.
It reuses the **real** rendering/playback path so findings transfer:

- `getVerovioToolkit()` + `renderToSVG(1)` with `breaks: 'none'` (single system).
- `renderToMIDI()` + `buildHighlightSchedule()` — the same timemap the score
  viewer highlights from.
- `useMidiPlayback()` — the production playback hook; its `onPositionUpdate(ms)`
  callback drives the scroll.

On each playback frame the spike binary-searches the schedule for the active
note, toggles a highlight class on its Verovio group, computes the note's
content-space x, and sets `scrollLeft` so the note rests at a fixed reading line
(a caret — an HTML overlay above the SVG, per the CLAUDE.md overlay rule). A
metrics strip reports render/MIDI/timemap time, SVG size, measure/schedule
counts, live FPS, and the max per-frame scroll jump.

Exercised by Francisco (2026-07-22) on the Mozart piano-sonata corpus, short and
long movements.

---

## Observations

| Movement | Measures | Render (SVG) | SVG px @ scale 40 | Schedule | FPS on playback | Max scroll jump |
|---|---|---|---|---|---|---|
| K.280/ii (short) | 60 | 201 ms | 8 708 × 228 | 1 014 | 55–60 | — |
| K.284/iii (long) | 287 | 2 806 ms | 47 036 × 246 | 4 788 | 55–60 | up to ~3 490 px |

- **Layout stability — PASS.** Every movement tried rendered as a full single
  horizontal system. **No clipping, wrapping, overlap, or mis-spacing** was
  observed at any length, including the 287-measure / 47 k px worst case.
  `pageWidth = 30000` was sufficient; it never needed raising, and no distortion
  appeared. Verovio's `breaks: 'none'` is the whole mechanism and it holds at
  movement scale.
- **Scroll-sync — accurate but steppy.** The caret **stays on the sounding
  note** and **does not drift**, even across a long movement — the timemap →
  x → scroll mapping is correct. But motion is **steppy**: `scrollLeft` visibly
  jumps at each note-on rather than gliding, because the spike only moves the
  viewport when the active note *changes*.
- **Frame rate — fine.** 55–60 fps throughout, even scrolling the 47 k px SVG.
  The browser has no trouble with the large single SVG; the steppiness is not
  dropped frames, it is the discrete scroll command.
- **Scroll-jump profile.** Normal note-to-note jumps are moderate. The large
  readings come from **positional discontinuities**: the initial seek to the
  first note (~396 px), and especially **repeats** — the playback position (and
  therefore the correctly-followed caret) jumps backward/forward in the score on
  a repeat pass (1 626 px) or a da-capo-style return to the start (3 490 px).

---

## Analysis

- **Render cost scales superlinearly** with measure count: 3.4 ms/measure at 60
  measures vs 9.8 ms/measure at 287 (≈ O(n^1.7): 4.8× the measures → 14× the
  time). 2.8 s for a long movement is an acceptable **one-time** cost (it is a
  single render, not per-frame), but it is the clearest scaling limit — a
  600-measure movement would push toward ~7–10 s.
- **SVG width scales ~linearly** (≈ 145–165 px/measure). A 47 k px node was no
  problem for scroll/paint here; width alone is not the ceiling — render time is.
- **The steppiness is an implementation detail, not a limitation.** The spike
  commands scroll only on note-onset changes. Driving scroll from **continuous
  playback time** (interpolate the viewport toward the target every frame, or
  map transport seconds → x directly) yields smooth motion with no change to
  Verovio or the render.
- **Repeats are the real scrollytelling design question.** Because the timemap
  expands repeats, the reading position legitimately jumps when a repeat sends
  playback backward. The caret follows correctly, but a 1.6–3.5 k px instantaneous
  jump reads as a lurch.

---

## Failure modes & workarounds

| Observed | Cause | Workaround for Component 16 |
|---|---|---|
| Steppy scroll | Viewport moved only on note-onset change | Interpolate `scrollLeft` toward target each frame (lerp), or drive it from continuous transport time rather than discrete onsets |
| Large lurches at repeats / return-to-start | Timemap expands repeats → playback position jumps backward/forward | Deliberate choice: ease/animate the jump, or render the movement **repeat-unrolled** so reading advances monotonically, or suppress the visual jump for backward repeats |
| ~2.8 s render on a long movement | Superlinear layout cost | One-time cost — show a loading state / pre-render; consider segmented or lazy rendering only for very long pieces (>~400–500 measures) |
| Highlight lost on any re-render (spike toggles an SVG class) | Class lives on Verovio's SVG, discarded on re-render | Production must highlight via an **HTML overlay** (as the score viewer already does), not an SVG class — the spike only gets away with it because it renders once |

---

## Implications

- **ADR-024 `context` contract (one-system mode).** The naive whole-movement
  `breaks: 'none'` render **suffices for layout** — no windowed or segmented
  rendering is needed for correctness at movement scale. The reusable pieces the
  spike confirms for the contract: (a) one-system rendering *is* just
  `breaks:'none'` + a large `pageWidth`; (b) the **scroll driver** — timemap →
  active-element x → viewport — is the hook worth carrying forward, and it must
  interpolate on continuous time, not step per note-onset. Neither is merged
  here; both are noted for the contract.
- **Component 16 scrollytelling — viable on the current Verovio path.**
  Recommended layout strategy: a **single horizontal SVG** per movement (not
  segmented) for the corpus's typical lengths, with (1) continuous-time scroll
  interpolation for smoothness, (2) a render/loading state to absorb the ~1–3 s
  render, and (3) an explicit repeat-handling decision (unroll vs. animate the
  jump) — the one genuine design question this spike surfaced. Revisit segmented
  rendering only if movements beyond ~400–500 measures enter the corpus.
- **Performance ceiling** was **not** reached at 287 measures / 47 k px / 55–60
  fps. The scaling constraint is render time (superlinear), not frame rate or
  SVG size.

---

## Disposition

Throwaway, but **kept dev-gated at least through the end of Phase 2** (decision,
Francisco, 2026-07-22) so the spike can be re-run when Component 16 planning
starts. The `/spike/horizontal` route and `HorizontalRenderSpike.tsx` are
dev-only (excluded from production builds via `import.meta.env.DEV`) and carry no
tests or nav entry; nothing here is merged as a component. The reusable insights
are captured above for the ADR-024 contract and Component 16, not left in the
tree. Remove when Phase 2 closes, unless Component 16 has adopted it by then.
