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
- When a measure has `@right="rptend"` or `@right="rptboth"` and is metrically incomplete (`@metcon="false"`, or contains fewer beats than the prevailing meter), the normalizer searches for its complement: the first metrically incomplete measure found after the matching `rptstart` or `rptboth`-as-open in the same structural scope.
- If the complement is identified but lacks `@metcon="false"`, the normalizer sets it and records the change in `changes_applied`.
- If no complement can be identified, the file is flagged with a warning. Ingest proceeds; ghost construction will produce fewer ghosts than `beatCount` for that measure, which is correct behavior for an incomplete bar.
- The `@join` attribute is treated as informational and is not required. If present but referencing a non-existent `xml:id`, it is flagged.
- Both halves are subject to §5's integer uniqueness rules: each must carry a unique integer `@n`.

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

The ingest pipeline calls `normalize_mei()` after schema validation. If `report.warnings` is non-empty, the ingestion report surfaced to the admin includes those warnings. Files with warnings are stored but tagged with a `normalization_status = "warnings"` field in the `movement` metadata table; the tagging tool displays this status to annotators so they can interpret unexpected ghost behaviour in context.

**Duration metadata.** `normalize_mei()` also returns the **maximum integer `@n` value found across all measures in the document** (inside and outside `<ending>` elements) as `NormalizationReport.duration_bars`. The ingest pipeline stores this as `movement.duration_bars`. Using the maximum rather than the last `@n` outside endings is necessary because pieces frequently end inside a final or second ending; the "last outside endings" value would give the bar before the endings begin, not the actual last bar. Pickup bars (`@n="0"`) are excluded by being the minimum; split measure complements are counted because both halves carry distinct sequential integers.

---

## Relation to other documents

- `docs/roadmap/phase-1.md` — Component 1 (MEI Corpus Ingestion) specifies normalization as a required step before storage.
- `docs/architecture/prototype-tagging-tool.md` — Beat boundary computation and edge cases section describes what the tagging tool assumes about the normalized MEI it receives.
- `docs/architecture/fragment-schema.md` — The `bar_start`/`bar_end` coordinate system relies on the `@n` conventions established here.
- `docs/adr/ADR-005-sub-measure-precision.md` — The edge cases table references normalization outcomes (e.g. pickup bars normalized to `@n="0"`).
