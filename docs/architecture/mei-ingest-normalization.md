# MEI Ingest Normalization

## Purpose

MEI files sourced from different corpus providers — MuseScore exports, Humdrum-to-MEI conversions, hand-encoded scholarly editions — are inconsistent in areas where the MEI specification permits encoding flexibility. The tagging tool's ghost construction logic depends on certain attributes being present and consistent: if they are not, beat ghost positions are wrong and the `beat_start`/`beat_end` values written to the database are corrupted.

Rather than building defensive fallbacks into front-end code that runs on every annotation session, normalization is applied once at corpus ingest time. The file stored in S3 and used by all downstream components is the **normalized MEI**. The original source file is retained in a separate S3 prefix (`/originals/`) for provenance and re-processing purposes.

Normalization runs as a Python script in the ingest pipeline, after schema validation and before storage. A file that fails validation is rejected outright. A file that passes validation but requires normalization is normalized, stored, and the changes recorded in the ingestion report returned to the admin. Normalization must be idempotent — running it twice on an already-normalized file must produce the same output.

---

## What the normalizer enforces

### 1. Pickup bar encoding

**Problem:** Anacrusis measures are encoded inconsistently. Some encoders use `@n="0"`, some use `@n="1"` for the pickup and renumber all subsequent measures, some omit `@n` entirely on the anacrusis, and some use `@metcon` while others do not.

**Convention adopted:** A pickup bar is any measure that (a) precedes the first metrically complete measure and (b) contains fewer beats than the prevailing time signature. The normalizer:

- Assigns `@n="0"` to the pickup measure.
- Sets `@metcon="false"` if not already present.
- Renumbers subsequent measures from `@n="1"` if the original encoding used `@n="1"` for the pickup (to prevent the first full measure from being numbered 2 in the database).

The `fragment` table uses 1-indexed `bar_start`/`bar_end` for full measures and treats `@n="0"` as the pickup bar's coordinate. Fragments beginning in a pickup bar store `bar_start=0`.

### 2. Meter change propagation into measures

**Problem:** MEI allows meter changes to be encoded as `<staffDef>` updates inside a `<measure>` or as `<meterSig>` children of a `<measure>`. The tagging tool's `getMeterForMeasure()` function queries `meiMeasure.querySelector('meterSig')` — it finds `<meterSig>` children but not `<staffDef>` updates. If a meter change is encoded only as a `<staffDef>`, all subsequent measures report the wrong beat count.

**Fix applied:** The normalizer walks every measure and checks whether the measure contains a `<staffDef>` with `@meter.count` and `@meter.unit` attributes. If so, it inserts a `<meterSig count="..." unit="..."/>` as a direct child of the `<measure>` element. Already-present `<meterSig>` children are left unchanged. This ensures that `getMeterForMeasure()` finds the correct signature in every measure regardless of how the source encoder expressed the change.

### 3. `<ending>` element integrity

**Problem:** First and second endings (volta brackets) are not always well-formed. Common issues: missing `@n` attributes on `<ending>` elements, endings that contain zero measures, non-sequential ending numbers (e.g. a file with `<ending n="1">` and `<ending n="3">` and no second ending).

**Policy:** The normalizer flags but does not auto-correct ending structure problems, for two reasons. First, the correct repair is ambiguous — a missing second ending could mean the second pass goes to the end of the piece, or that the encoder simply omitted it. Second, silently restructuring endings could change the musical content. Instead:

- Files with malformed `<ending>` structure are stored with a `normalization_warnings` field in the ingestion report.
- The tagging tool's MEI parser treats any measure not inside an `<ending>` element as having `repeat_context = null`.
- Fragments tagged within a malformed ending section should be flagged for editorial review before approval.

The one auto-correction that is applied: if an `<ending>` element is present but has no `@n` attribute, the normalizer assigns `@n` values sequentially (1, 2, …) in document order.

### 4. Repeat barline pairing

**Problem:** Some encoders close a repeat section without an opening barline, or vice versa. The tagging tool uses repeat barlines as selection barriers; a genuinely unpaired barline could cause the barrier logic to behave incorrectly.

**MEI encoding.** Repeat barlines are encoded on the `@right` attribute of `<measure>` elements using three `data.BARRENDITION` values: `rptend` (`:||`), `rptstart` (`||:`), and `rptboth` (`:||:`, "repeat start and end"). The `@left` attribute accepts the same values and appears in legacy encodings; it is treated equivalently here. `@right` is structurally authoritative.

**Double repeat barlines (`rptboth`).** A `@right="rptboth"` value is treated as two events in sequence by the pairing algorithm: first an `rptend` (closing the current section), then an `rptstart` (opening a new one). A `rptboth` is therefore never itself a pairing error — it consumes one open section and produces one new open section.

**Convention:** Standard notation allows the first `rptend` (or `rptboth` acting as close) in the document to appear without a preceding `rptstart` — the implied repeat goes back to the beginning of the score. This is valid and must not be flagged. Every subsequent `rptend` or `rptboth`-as-close must have a matching `rptstart` or `rptboth`-as-open after the previous close. Any `rptstart` or `rptboth`-as-open with no subsequent close before the end of the document is always flagged.

**Policy:** The normalizer applies the following checks:
- The first `rptend` (or `rptboth`-as-close) encountered in document order is allowed to be unpaired. It is not flagged.
- Every subsequent `rptend` or `rptboth`-as-close must have a matching `rptstart` or `rptboth`-as-open after the previous close (or after the start of the piece if this is the second close and the first was unpaired). If no matching open is found, this is flagged.
- Any `rptstart` or `rptboth`-as-open with no subsequent `rptend` or `rptboth`-as-close before the end of the document is flagged.
- Legacy `@left="rptstart"` encodings are treated equivalently to `@right="rptstart"` on the preceding measure for pairing purposes.

Flagged files are stored with a `normalization_warnings` entry. The tagging tool's barrier detection must treat every `rptend` and `rptboth` as a selection barrier regardless of pairing status, and log a console warning during ghost construction when an `rptend` is unpaired beyond the first.

### 5. `@n` uniqueness outside `<ending>` elements

**Problem:** Outside of `<ending>` elements, `@n` values should be unique and sequential. Some encoders produce duplicate `@n` values or non-integer values (e.g. `@n="12a"` for an editorially inserted measure).

Note: measures that lie within a repeat section but outside any `<ending>` element — the repeated passage body — are subject to this rule. MEI does not duplicate those measures in the file (they appear once and are played twice); they carry unique `@n` values like any other measure. Only measures inside `<ending>` elements are exempt (see §6).

**Fix applied:**
- Non-integer `@n` values (e.g. `"12a"`) outside `<ending>` elements are flagged in the ingestion report. The normalizer does not auto-correct these because the right renumbering is editorially ambiguous.
- Duplicate `@n` values outside `<ending>` elements are flagged and the file is stored with warnings.
- Gaps in `@n` sequences (e.g. jumping from 4 to 6) are allowed — some editions number measures inconsistently for historical reasons — and are only flagged if the gap exceeds 10 (likely an error rather than an editorial convention).

### 6. `@n` values inside `<ending>` elements

**Background.** `<ending>` elements encode first/second (and further) volta brackets — the alternate endings played on successive passes through a repeat section. Measures in different endings that cover the same notational bar slot are alternatives to each other: the first ending's bar 12 and the second ending's bar 12 are both candidates for the same position, read on different passes.

**MEI specification note.** The MEI `@n` attribute on `<measure>` is typed as `data.WORD` (any word-like string). The spec explicitly notes that measures in endings often carry suffix-style labels such as `"12a"` and `"12b"` to distinguish counterpart bars across endings. However, because `fragment.bar_start` and `fragment.bar_end` are integer columns in PostgreSQL, and because the tagging tool already disambiguates ending context via the containing `<ending @n>` element rather than via measure-level suffixes (see `docs/architecture/prototype-tagging-tool.md`, "Not yet handled — Repeat sections"), Doppia requires integer `@n` on all measures.

**Convention adopted.** Measures in different endings that occupy the same bar slot share the same integer `@n` value. The first ending's bar 12 and the second ending's bar 12 both carry `@n="12"`. Disambiguation is provided by the `<ending @n="1">` and `<ending @n="2">` parent elements and, at the database level, by `fragment.repeat_context`. After the endings, the score resumes from the integer immediately following the highest `@n` found in any ending.

**Auto-correction applied.** If source MEI uses suffix notation inside `<ending>` elements (e.g. `@n="12a"`, `@n="12b"`), the normalizer strips the alphabetic suffix and assigns the integer base, recording the change in `changes_applied`. If the suffix is non-alphabetic or the integer base is ambiguous, the value is flagged as a warning instead.

**Uniqueness within a single ending.** `@n` values must be unique within a single `<ending>` element. Duplicate values within the same ending are flagged. Duplicate values across different endings (the shared-slot case described above) are expected and not flagged.

### 7. Incomplete measures at repeat boundaries

**Background.** A common notational convention places metrically incomplete measures on either side of a repeat barline when the music's phrasing does not align with the measure grid at that point. For example, in 4/4, a one-beat measure ending with `rptend` paired with a three-beat measure that continues the repeated passage together form one complete bar split across the barline. MEI encodes each half as a separate `<measure>` with `@metcon="false"`, and optionally links them with the `@join` attribute ("indicates another measure which metrically completes the current, incomplete one").

**Convention adopted.** Each half of a split measure receives its own sequential integer `@n`. The first half (before the closing repeat barline) keeps its natural sequential number; the complement (after the matching `rptstart`) receives the next available integer. Neither half shares `@n` with the other. Both carry `@metcon="false"`.

This means each half is an independently addressable bar in the tagging coordinate system: `bar_start` or `bar_end` may point to either half, and `beat_start`/`beat_end` within each half are computed against the beats actually present. Ghost construction is unaffected — the "only struck beats get ghosts" rule already handles measures with fewer content beats than the prevailing meter.

**Normalizer behavior:**
- When a measure has `@right="rptend"` or `@right="rptboth"` and already carries `@metcon="false"`, the normalizer searches for its complement: the first measure carrying `@metcon="false"` found after the matching `rptstart` or `rptboth`-as-open in the same structural scope.
- If the complement is identified but lacks `@metcon="false"`, the normalizer sets it and records the change in `changes_applied`.
- If no complement can be identified, the file is flagged with a warning. Ingest proceeds normally.
- The `@join` attribute is treated as informational and is not required. If present but referencing a non-existent `xml:id`, it is flagged.
- Both halves are subject to §5's integer uniqueness rules: each must carry a unique integer `@n`.

**Why beat-counting is not attempted.** Determining a measure's actual duration from raw MEI requires handling chords (take the max duration per simultaneous group, not the sum), multiple layers (parallel voices — take the max across layers), tuplets (scale by `@numbase / @num`), and tied continuations. This is outside the normalizer's `lxml`-only scope, and attempting it would be both fragile and redundant. The tagging tool's ghost construction already resolves this correctly at render time: it queries Verovio for actual note onsets via `getTimesForElement()` and builds ghosts only for struck beats — so a metrically incomplete measure automatically produces the right number of ghosts regardless of whether `@metcon` is set. No ingestion-time beat count is needed to ensure correct tagging behaviour. Cases where a genuine split-measure half lacks `@metcon="false"` will be visible to annotators as a measure with fewer ghosts than the prevailing meter suggests, which is self-evident and does not corrupt any data.

---

## What the normalizer does NOT change

- **Musical content**: pitches, durations, dynamics, articulations, text underlay, and all other content nodes are never touched.
- **`xml:id` values**: these are globally unique identifiers relied on by Verovio. The normalizer never reassigns them.
- **`<ending>` measure content**: measures inside `<ending>` elements are not renumbered or restructured, except for the two auto-corrections described in §3 (assigning sequential `@n` to `<ending>` elements that lack it) and §6 (stripping alphabetic suffixes from measure `@n` values inside endings).
- **Encoding style**: the normalizer does not convert between MEI encoding conventions (e.g. `@tie` vs. `<tie>` elements). Both styles are valid MEI and the tagging tool handles both.

---

## Implementation

The normalizer is a standalone Python module (`backend/services/mei_normalizer.py`) using `lxml` for XML manipulation. It exposes a single function:

```python
def normalize_mei(source_path: str, output_path: str) -> NormalizationReport:
    """
    Read the MEI file at source_path, apply all normalization rules,
    write the normalized file to output_path, and return a report
    describing what was changed and what was flagged.
    """
```

`NormalizationReport` is a Pydantic model containing:
- `changes_applied: list[str]` — human-readable descriptions of each auto-correction made
- `warnings: list[str]` — issues flagged but not auto-corrected
- `is_clean: bool` — True if no warnings were raised (the file was already normalized or required only minor auto-corrections)
- `duration_bars: int` — maximum integer `@n` value found across all measures; stored as `movement.duration_bars`

The ingest pipeline calls `normalize_mei()` after schema validation. If `report.warnings` is non-empty, the ingestion report surfaced to the admin includes those warnings. Files with warnings are stored with structured warnings written to `movement.normalization_warnings` (JSONB; null when clean). The tagging tool reads this column and surfaces a status indicator to annotators when it is non-null, so they can interpret unexpected ghost behaviour in context.

**Duration metadata.** `normalize_mei()` also returns the **maximum integer `@n` value found across all measures in the document** (inside and outside `<ending>` elements) as `NormalizationReport.duration_bars`. The ingest pipeline stores this as `movement.duration_bars`. Using the maximum rather than the last `@n` outside endings is necessary because pieces frequently end inside a final or second ending; the "last outside endings" value would give the bar before the endings begin, not the actual last bar. Pickup bars (`@n="0"`) are excluded by being the minimum; split measure complements are counted because both halves carry distinct sequential integers.

---

---

## § Verovio bar-range selection: observed behaviour

*Initial spike: 2026-04-23 (verovio 4.3.1). Re-run: 2026-04-23 (verovio 6.1.0). Spike bug identified and corrected: 2026-04-23. Script: `scripts/spike_verovio_incipit.py`.*

This section documents the findings of the Component 2 Step 1 spike, run against the `k331-movement-1.mei` integration fixture (6 measures, 6/8, no pickup bar) and an inline pickup-bar fixture (4/4, `@n="0"` anacrusis). The spike was run first against 4.3.1, then re-run after the upgrade to 6.1.0. A subsequent code review found a bug in the spike script that invalidated Findings 1 and 2 from both runs; the corrected findings are documented below. Findings inform the `generate_incipit` Celery task (Component 2, Step 3) and Component 3's fragment rendering implementation.

### Finding 1 — `setOptions({"select": ...})` is unsupported; `tk.select()` + `tk.redoLayout()` is the correct API

> **⚠ The original Finding 1 result was INVALIDATED** by the spike bug (missing `tk.redoLayout()` call). The corrected finding is documented below.

The `select` option is **not a `setOptions` key** in any tested version:

```
[Error] Unsupported option 'select'
```

`setOptions({"select": [{"measureRange": "1-4"}]})` is silently ignored in both 4.3.1 and 6.1.0.

The correct API is the `tk.select()` method — but the spike script was calling it **without the required `tk.redoLayout()` call**. The consequence was that `select()` marked a selection, but `renderToSVG()` rendered the layout computed by `loadData()` (the full score), which had never been invalidated. This caused both 4.3.1 and 6.1.0 to appear non-functional.

**Correct call sequence (6.1.0):**

```python
tk = verovio.toolkit()
tk.setOptions(options)
tk.loadData(mei_bytes.decode("utf-8"))
tk.select({"measureRange": "1-4"})   # marks the selection; does NOT re-layout
tk.redoLayout()                       # re-runs layout with the selection applied
svg = tk.renderToSVG(1)              # renders page 1 of the selected content
```

`redoLayout()` is available in the Python bindings (`verovio.py`, line 377). Without it, `select()` is a no-op from the rendering perspective.

**Important: `measureRange` uses 1-based position index, not `@n` values.** The Verovio Reference Book documents: *"The position value is the index position of the measure and not the measure `@n` value."* This means:
- Position 1 = first measure in document order (regardless of its `@n`)
- Position 2 = second measure, etc.
- A pickup bar at `@n="0"` sits at position index 1.

**This call sequence is empirically confirmed in 6.1.0.** Spike verification (2026-04-23, k331 fixture, 6 measures): `measureRange "1-4"` with `redoLayout()` produced **4 measure elements at 504×124px** (scale=35), versus 720×124px for the full 6-measure render (A1 baseline). `select()` without `redoLayout()` produced the same output as the full render — confirming that `redoLayout()` is the required step.

**Consequence for the incipit task:** the `generate_incipit` task uses the smart-break page-1 approach (Finding 5), which does not require `select`. See Finding 5. For Component 3 (mid-score fragment rendering), the corrected `select()` + `redoLayout()` sequence is the recommended approach; see "Implications for Component 3" below.

### Finding 2 — Pickup bar (`@n="0"`) addressing via `measureRange`: original results invalid

> **⚠ The original Finding 2 result was INVALIDATED** by the spike bug (missing `tk.redoLayout()` call). The corrected finding is documented below.

The original spike compared `measureRange "0-4"` and `measureRange "1-4"` and found they produced identical 6-measure output. That result was an artefact of the missing `redoLayout()` call — neither range was actually doing anything, so both rendered the full score.

The corrected understanding, based on the Verovio Reference Book's position-index documentation:

- `measureRange` is 1-based and position-indexed, not `@n`-indexed.
- A pickup bar at `@n="0"` is at position index 1.
- `measureRange "1-4"` therefore gives the pickup bar plus the first three full measures — not four full measures.
- To render the pickup bar plus four full measures, use `measureRange "1-5"`.
- `measureRange "0-x"` is likely treated as starting from position 0 (before the first measure) and behaves unpredictably; avoid it.

**Empirically verified (2026-04-23, pickup fixture: 4/4, `@n="0"` anacrusis + measures @n=1–5):**

- `measureRange "0-4"` → Verovio warning: *"Measure range start for selection '0-4' could not be found"* → falls back to full render (6 measures). **Position 0 is invalid.**
- `measureRange "1-4"` → **4 measures**: position 1 = pickup bar (@n="0"), positions 2–4 = measures @n=1,2,3. The pickup bar is included automatically because it is at position index 1.
- Confirmed: `measureRange` indices are 1-based position indices, not `@n` values. The pickup bar (`@n="0"`) sits at position 1.
- **To render the pickup bar plus four full measures:** use `measureRange "1-5"`.
- **`measureRange "0-x"` is invalid** — position 0 does not exist; the selection is silently discarded and the full score is rendered.

**Practical consequence for the incipit task:** the smart-break page-1 approach (Finding 5) naturally includes any pickup bar without needing to know its position index. It remains the recommended incipit strategy for this reason.

### Finding 3 — XML comments before the root element cause `loadData` failure (persists in 6.1.0)

Both 4.3.1 and 6.1.0 fail to parse MEI when an XML comment appears before the `<mei>` root element:

```
[Error] No <music> element found in the MEI data
loadData returned: False
```

This is a parser bug — standard XML allows processing instructions and comments before the root element. It affects test fixture files that include comment headers (e.g. `k331-movement-1.mei`). **Normalized MEI produced by the ingestion pipeline via `lxml` does not contain comments**, so this bug does not affect production use. The spike script strips comments before loading (`re.sub(r"<!--.*?-->", "", mei_str, flags=re.DOTALL)`). The `generate_incipit` task operates on normalized MEI from object storage and does not need this workaround.

### Finding 4 — SVG output is not byte-for-byte stable (confirmed 6.1.0)

`xml:id` values in the SVG output (element IDs and SMuFL glyph symbol references) are randomly generated on each render call. Two identical `loadData` + `renderToSVG` calls produce SVGs that differ at every `id=` and `class=` attribute using random suffixes. `resetXmlIdSeed(0)` does **not** fix this in either version — the IDs remain non-deterministic.

**Practical consequence for caching:** the `generate_incipit` task stores the SVG once at a deterministic object key (`{composer}/{corpus}/{work}/{movement}/incipit.svg`). Re-ingesting a movement overwrites the existing object. The browse API returns a signed URL for the stored object. **Never use SVG content hash as a cache key**; use the movement's `incipit_object_key` (presence of the key = incipit exists).

### Finding 5 — Original approach: `breaks="smart"`, narrow `pageWidth`, take page 1

> **Superseded by Findings 6–9 (2026-05-04).** The `generate_incipit` task now uses `select({"measureRange": "start-4"}) + redoLayout()` (see §"Verovio `measureRange` keyword syntax" below). Finding 5 is retained as historical context.

Since `measureRange` selection appeared non-functional at the time of this spike (due to the missing `redoLayout()` call described in Finding 1), the incipit was generated by rendering the full score with a narrow `pageWidth` that causes Verovio's smart line-breaking algorithm to fit roughly the first system onto page 1. Page 1 is then the incipit.

Observed at `scale=35` on the k331 fixture (6/8, minimal notation without beaming). Numbers updated to reflect 6.1.0's slightly different layout algorithm (5.3 SVG structure change):

| `pageWidth` | pages | measures on page 1 | SVG dims (page 1) |
|---|---|---|---|
| 400 | 2 | 3 | 140×275px |
| 600 | 2 | 3 | 210×275px |
| 800 | 2 | 5 | 280×275px |
| 1200 | 1 | 6 (all) | 420×199px |

The k331 fixture is a sparse test MEI without beaming; real DCML Mozart MEI will have denser notation and should produce 3–4 measures per system at `pageWidth=800`.

**Recommended options for `generate_incipit`:**

```python
tk.setOptions({
    "pageWidth": 800,
    "pageHeight": 800,
    "adjustPageHeight": True,
    "breaks": "smart",
    "scale": 35,
})
tk.loadData(mei_bytes.decode("utf-8"))
svg = tk.renderToSVG(1)   # page 1 = first system = incipit
```

This must be verified against real DCML Mozart MEI before Step 3 is committed (the fixture is too sparse to be conclusive about real-world measure counts). If the first system of a real movement contains fewer than 3 measures at these settings, increase `pageWidth` incrementally (900, 1000) until 3–4 measures appear on page 1.

### Dimensions summary

**Full-score render** — `breaks="none"`, `pageWidth=2200` (all 6 measures, one long system), empirically confirmed in 6.1.0 (A1 baseline):

| scale | SVG width | SVG height |
|---|---|---|
| 35 | 720px | 124px |

**Select-based render** — `breaks="none"`, `pageWidth=2200`, `measureRange "1-4"` + `redoLayout()` (4 measures selected from the k331 fixture), empirically confirmed in 6.1.0 (Section C):

| scale | SVG width | SVG height |
|---|---|---|
| 30 | 432px | 106px |
| 35 | 504px | 124px |
| 40 | 576px | 141px |

At `scale=35`, `breaks="smart"`, `pageWidth=800` (6.1.0): approximately 280×275px for a 5-measure system on the k331 fixture. Actual dimensions will vary with note density and clef/key/time-signature area.

### Implications for Component 3 (fragment rendering)

Component 3 requires rendering a score segment identified by a bar range (e.g. bars 12–16 in the middle of a movement). The corrected spike finding is that `tk.select()` **does** work when followed by `tk.redoLayout()`. The recommended strategy for Component 3:

**Strategy 1 (recommended): `select()` + `redoLayout()` with position-index range**

```python
tk = verovio.toolkit()
tk.setOptions({
    "pageWidth": 2200,
    "adjustPageHeight": True,
    "breaks": "none",
    "scale": 35,
})
tk.loadData(mei_bytes.decode("utf-8"))
tk.select({"measureRange": f"{mc_start}-{mc_end}"})  # 1-based position index = mc
tk.redoLayout()
svg = tk.renderToSVG(1)
```

`mc_start` and `mc_end` are the 1-based document-order position indices stored on the `fragment` row (ADR-015). They map directly to `measureRange` operands; no conversion is needed. The `bar_start`/`bar_end` values (which are `@n` values) are used for display labels only and are never passed to `select`.

**Fallback Strategy 2: SVG `viewBox` clipping**

Render the full score with `breaks: "none"`, parse the SVG to locate the x-coordinates of the target measure barlines, and clip the `viewBox`. This is safe for any contiguous bar range but requires SVG DOM parsing and is significantly more complex. Use only if Strategy 1 proves unreliable after real-data verification.

**Fallback Strategy 3: page-based rendering**

Compute which page a target measure falls on using `getPageWithElement()`, render that page, then post-process to crop to the target measures. Requires multiple render calls for fragments that span a page break.

The incipit approach (page 1 of a smart-break render) is not applicable to mid-score fragment rendering because the target measures could be on any page. Strategy 1 is the correct solution for Component 3.

---

## Relation to other documents

- `docs/roadmap/phase-1.md` — Component 1 (MEI Corpus Ingestion) specifies normalization as a required step before storage.
- `docs/architecture/prototype-tagging-tool.md` — Beat boundary computation and edge cases section describes what the tagging tool assumes about the normalized MEI it receives.
- `docs/architecture/fragment-schema.md` — The dual coordinate system (`bar_start`/`bar_end` as `@n` values, `mc_start`/`mc_end` as document-order position indices) relies on the `@n` conventions established here.
- `docs/adr/ADR-005-sub-measure-precision.md` — The edge cases table references normalization outcomes (e.g. pickup bars normalized to `@n="0"`).
- `docs/adr/ADR-015-dual-measure-coordinate-system.md` — Defines the relationship between `@n` values, DCML `mc`, and Verovio position indices. The `_build_measure_map` function in `backend/services/tasks/ingest_analysis.py` now returns `{position_index: MeasureEntry(n_raw, volta, xml_id)}` keyed by 1-based document-order position index (the same counter as DCML `mc`). Non-integer `@n` values (e.g. `X1`, `X2`) are preserved in `n_raw` rather than dropped. The alignment check in `_parse_dcml_harmonies` keys on `ev["mc"]` directly, eliminating the spurious warnings caused by non-integer `@n` values in the Mozart staging corpus.

---

## § Verovio version: root cause and upgrade decision

*Researched: 2026-04-23. See also `docs/adr/ADR-013-verovio-version-policy.md`.*

### Root cause of `select` appearing non-functional in both 4.3.1 and 6.1.0

The `select` toolkit function was introduced in **Verovio 3.10** (May 2022). Both the 4.3.1 spike and the 6.1.0 re-spike found `setOptions({"select": [...]})` rejected and `tk.select()` appearing to have no effect on rendering.

The actual root cause is a **bug in the spike script**: `tk.select()` was called after `loadData()` but `tk.redoLayout()` was never called afterwards. `loadData()` computes the full-score layout. `select()` marks a selection but does not invalidate the layout. Without `redoLayout()`, `renderToSVG()` renders the full-score layout unchanged, making `select()` appear to be a no-op. Both 4.3.1 and 6.1.0 showed identical results because the spike was measuring the wrong thing in both runs.

`select()` is functional in 6.1.0 when followed by `redoLayout()`. The 6.1.0 Python bindings expose both methods. The 4.3.1 pin carries no ADR; it was the current stable release when `requirements.txt` was first committed.

### Version timeline relevant to this project

| Version | Date | Change relevant to Doppia |
|---|---|---|
| 3.10 | May 2022 | `select` toolkit function introduced |
| 3.13 | Nov 2022 | Python bindings: options now accept Python dicts; JSON no longer needs to be stringified |
| 4.0 | Sep 2023 | First release based on MEI 5.0 |
| **4.3.1** | **~early 2024** | **Pinned in `requirements.txt`; `select` non-functional** |
| 5.3 | May 2025 | SVG glyph structure refactored — breaks snapshot baselines |
| 5.4 | Jul 2025 | Time map JSON key names changed — affects `getTimesForElement()` callers |
| 6.0 | Jan 2026 | Repetitions expanded by default in MIDI/timemap output |
| **6.1.0** | **Mar 2026** | **Current release; `select()` + `redoLayout()` works; spike script bug now corrected** |

### MEI 5.x and the corpus

MEI 5.0 was released September 2023 (focused on guidelines, MEI Basic customisation, and consistency). MEI 5.1 followed with tablature enhancements. The DCML Mozart Piano Sonatas corpus files are encoded in MEI 4 format. Verovio 6.1 reads MEI 4 and MEI 5/5.1 without issue. The ingest normalizer operates via `lxml` and is schema-version-agnostic for the elements it manipulates (measure `@n`, `@metcon`, `<meterSig>`, repeat barlines). **No corpus re-encoding or normalizer changes are required** when upgrading Verovio.

### MuseScore 4 and future corpus expansion

The DCML corpus is pre-encoded MEI and does not involve MuseScore exports, so MuseScore 4 is not a concern for Phase 1. For context: MuseScore 4 exports MusicXML 4.0 (not MEI natively); the RISM/DCML-developed MuseScore-MEI plugin targets MEI Basic (the MEI 5.0 customisation), but MuseScore 4 has documented MusicXML export instability as of 4.4.x (hidden rest injection in multi-voice measures, occasional crashes, backward-incompatible format changes from MuseScore 3). **A MuseScore 4 ingest path should be deferred to Phase 2** and gated on an explicit stability baseline, not adopted in Phase 1.

### Implications for Component 3

The spike script bug (missing `redoLayout()`) has been corrected. `tk.select()` is functional in 6.1.0 when the correct sequence is used: `loadData()` → `select()` → `redoLayout()` → `renderToSVG()`. Strategy 1 (`select`-based rendering) is the recommended approach for Component 3. See "Implications for Component 3" in the spike findings above for the full code pattern and the `@n`-to-position-index mapping requirement.

### Upgrade checklist — completion status (2026-04-23)

`verovio==6.1.0` merged into `requirements.txt` and installed. Each checklist item resolved:

1. **Re-spike `select`** — ✅ **Done.** `tk.select()` + `tk.redoLayout()` is empirically confirmed functional in 6.1.0. A3: `measureRange "1-4"` → 4 measure elements at 504×124px (scale=35), vs. full render at 720×124px. Position-index model confirmed. Pickup bar (`@n="0"`) sits at position 1; `measureRange "0-4"` is invalid (Verovio warning + full-render fallback); `measureRange "1-5"` is the correct range for pickup + 4 full measures. See Findings 1 and 2 for full details.
2. **Time map audit** — ✅ **N/A.** `grep -r getTimesForElement backend/` returns no matches. No callers exist; nothing to audit.
3. **MIDI repetition default** — ✅ **N/A.** No MIDI playback Celery task has been implemented yet (ADR-012 references future Phase 1/2 work). No code relies on the previous non-expansion behaviour.
4. **Regenerate snapshot baselines** — ✅ **N/A.** `backend/tests/snapshots/` contains only an empty `__init__.py`; no baselines exist to regenerate. The 5.3 SVG structure change is noted but has no current impact.
5. **Backfill incipits** — ✅ **Done.** The `generate_incipit` task (Component 2 Step 3) has been implemented and backfilled for all 15 staging movements. See §"Known incipit rendering quality issues" below for observations.
6. **Client/server version parity** — ✅ **N/A.** No frontend Verovio WASM is integrated yet (Component 3). The parity requirement applies when Component 3 introduces the WASM viewer.

---

## § Known DCML encoding quirks: Mozart staging ingest (2026-04-24)

*Source: ingestion report from `scripts/dcml_corpora/mozart-browser-staging.toml` (K.279, 280, 283, 331, 332 — 15 movements). All movements were accepted; these are warnings, not rejections.*

The following patterns appear across the Mozart corpus and are artefacts of how MuseScore 3.6 encodes repeats and how verovio converts them to MEI. They do not affect musical content or incipit rendering and are flagged by the normalizer as warnings only.

### `@n='X1'`, `'X2'`, … on measures outside `<ending>`

Affects: K.279/2–3, K.280/3, K.283/1, K.331/1,3, K.332/3 (and others).

MuseScore encodes certain repeated sections by writing out repeat-end measures with non-integer `@n` values (`X1`, `X2`, …) rather than using `<ending>` wrappers. These values are not valid as measure numbers outside `<ending>` elements. The normalizer flags them but cannot auto-correct them without knowing the intended bar numbering.

**Future fix:** A dedicated normalizer pass that detects `X`-prefixed `@n` values, infers whether they belong inside an `<ending>` wrapper, and either rewrites the structure or strips the `X` prefix and renumbers accordingly. K.331/movement-1 is the representative case.

### Duplicate `@n` on all measures outside `<ending>` (K.331/movement-2)

K.331/movement-2 (Menuetto) has every measure `@n` duplicated (1–48 twice). This is the worst case in the staging set: the movement appears to have been written out twice by MuseScore rather than using repeat barlines, producing a full duplicate of the bar sequence. The normalizer warns on all 48 duplicates.

**Future fix:** Investigate whether the MuseScore source (`K331-2.mscx`) contains a structural duplication and whether it can be collapsed into a repeat structure before MEI conversion.

### Non-sequential `<ending> @n` values (K.283/2, K.331/1)

Endings are numbered `[1, 1, 2, 2]` (K.283/2) and `[1, 1, 1, 2, 2, 2]` (K.331/1) rather than sequentially. These are paired endings across multiple repetitions; the MEI encoding repeats the same ending number for each volta occurrence rather than using unique identifiers.

### Unpaired `rptend` (K.331/movement-2)

Two `rptend` barlines without matching `rptstart` in K.331/movement-2, consistent with the duplicate-bar issue above.

---

## § Known incipit rendering quality issues (2026-04-24)

*Observed after running `generate_incipit` across all 15 staging movements using `pageWidth=800`, `breaks="smart"`, `scale=35`.*

The page-1 / smart-break strategy (Finding 5) works correctly for the majority of movements, but two quality issues affect a subset:

### Single-bar incipits

Some movements render only one bar on page 1. This happens when the first measure is unusually wide — typically due to many notes, ornaments, or a very short time-signature denominator (e.g. 3/8 with many 32nd notes). Verovio's smart-break algorithm places the line break after bar 1 because bar 1 alone already fills the 800px width at scale 35.

**Potential fix:** Increase `pageWidth` (e.g. to 1200px) to allow more bars per system, at the cost of a wider SVG. Alternatively, use `measureRange "1-4"` (the select-based approach from Finding 2) to guarantee a fixed bar count regardless of width — but this requires a fallback for movements without a pickup bar. This is worth revisiting when the corpus browser UI is under active development (Component 2 Step 8).

### Illegible incipits due to crowded spacing

A few movements produce incipits where notes are packed so tightly they overlap or are visually unreadable. This is the converse of the above: many bars fit in 800px but at scale 35 the notation is too compressed.

**Potential fix:** A higher `scale` value (e.g. 40–45) increases note spacing and glyph size. This trades off against fitting fewer bars on the first system. Testing with `scale=40` and `pageWidth=1000` on the affected movements (primarily K.331/movement-1 and K.279/movement-2) is recommended before finalising the incipit parameters.

---

## § Verovio `measureRange` keyword syntax: observed behaviour (2026-05-04)

*Spike script: `scripts/spike_verovio_measurerange.py`. Verovio version: 6.1.0. Fixtures: `k331-movement-1.mei` (6 measures, no endings), inline `PICKUP_MEI` (pickup at `@n="0"` + 5 full measures), `volta-movement.mei` (4 positions, `@n="2"` shared across two `<ending>` elements).*

These findings answer the four questions left open by the April 2026 spike and govern the incipit implementation and `mc_start`/`mc_end` fragment rendering described in `docs/roadmap/measure-number-redesign-plan.md`.

### Finding 6 — `"start-N"` syntax works and is equivalent to `"1-N"`

`measureRange: "start-4"` produces exactly the same SVG as `measureRange: "1-4"` on a movement with no pickup bar (identical measure count and pixel dimensions). `"start-N"` with N equal to the total measure count renders all measures. This syntax is safe to adopt as the production incipit range.

| Sub-test | `measureRange` | Measures rendered | Dimensions |
|---|---|---|---|
| baseline | `"1-4"` | 4 | 504×124 px |
| `start-N` | `"start-4"` | 4 | 504×124 px |
| `start-N` all | `"start-6"` | 6 | 720×124 px |

### Finding 7 — `"start-N"` includes the pickup bar automatically

On the pickup fixture (pickup at `@n="0"` occupying position 1), `"start-4"` and `"1-4"` both render 4 measures (positions 1–4: the pickup + the first 3 full bars). They produce identical SVG dimensions (415×124 px). No special casing is required for movements with pickup bars: `"start-4"` is correct in all cases.

### Finding 8 — Position-index addressing is correct under volta endings

`measureRange` uses document-order position indices even when `@n` values repeat across `<ending>` elements. On the volta fixture (positions: n=1, ending1/n=2, ending2/n=2, n=3):

| `measureRange` | Measures rendered | Meaning |
|---|---|---|
| full render | 4 | all positions |
| `"1-2"` | 2 | n=1 + ending1/n=2 |
| `"3-4"` | 2 | ending2/n=2 + n=3 |
| `"2-3"` | 2 | ending1/n=2 + ending2/n=2 (both `@n="2"`) |

Verovio correctly isolates the individual `<ending>` elements by document order. This confirms that `mc_start`/`mc_end` (1-based document-order position indices, same counter as DCML `mc`) can be passed directly as `measureRange` operands for fragment rendering without any coordinate conversion.

### Finding 9 — `"end"` keyword works; `"start-100"` clamps gracefully

`"3-end"` on the 6-measure k331 fixture renders positions 3–6 (4 measures, 492×124 px). `"start-end"` renders all 6 measures (identical to the full render). `"start-100"` on a 6-measure piece clamps to the last measure and renders all 6 measures correctly (720×124 px). Verovio emits a warning to stderr (`Measure range end for selection 'start-100' could not be found`) but `tk.getLog()` returns empty — the render succeeds. Use `"start-end"` rather than `"start-{large_N}"` when a full render fallback is needed; it is cleaner and silent.

**Production recommendation:** Update `generate_incipit.py` to use `select({measureRange: "start-4"}) + redoLayout()` with `pageWidth=2200` and `breaks="none"`. This guarantees exactly 4 bars regardless of notation density or measure width, includes pickup bars automatically, and replaces the `breaks="smart"` / page-1 approach whose quality problems are documented above. For movements with fewer than 4 measures, use `"start-end"` as the fallback range (guard with `movement.duration_bars < 4`).
