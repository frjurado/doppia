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

**Convention:** Standard notation allows the first `:|` in a piece to appear without a preceding `|:` — the implied repeat goes back to the beginning of the score. This is valid and must not be flagged. Any `:|` after the first one must have a matching `|:` earlier in the document. A `|:` with no subsequent `:|` is always an error.

**Policy:** The normalizer applies the following checks:
- The first `:|` encountered in document order is allowed to be unpaired (implied repeat from the start). It is not flagged.
- Every subsequent `:|` must have a matching `|:` after the previous `:|` (or after the start of the piece if this is the second `:|` and the first was unpaired). If no matching `|:` is found, this is flagged in the ingestion report.
- Any `|:` with no subsequent `:|` before the end of the document is flagged.

Flagged files are stored with a `normalization_warnings` entry. The tagging tool's barrier detection must treat every `:|` as a barrier regardless of pairing status, and log a console warning during ghost construction when a `:|` is found to be unpaired beyond the first.

### 5. `@n` uniqueness within the non-repeat body

**Problem:** Outside of `<ending>` elements, `@n` values should be unique and sequential. Some encoders produce duplicate `@n` values or non-integer values (e.g. `@n="12a"` for an editorially inserted measure).

**Fix applied:**
- Non-integer `@n` values (e.g. `"12a"`) are flagged in the ingestion report. The normalizer does not auto-correct these because the right renumbering is editorially ambiguous.
- Duplicate `@n` values outside `<ending>` elements are flagged and the file is stored with warnings.
- Gaps in `@n` sequences (e.g. jumping from 4 to 6) are allowed — some editions number measures inconsistently for historical reasons — and are only flagged if the gap exceeds 10 (likely an error rather than an editorial convention).

---

## What the normalizer does NOT change

- **Musical content**: pitches, durations, dynamics, articulations, text underlay, and all other content nodes are never touched.
- **`xml:id` values**: these are globally unique identifiers relied on by Verovio. The normalizer never reassigns them.
- **`<ending>` measure content**: measures inside `<ending>` elements are not renumbered or restructured (except for the `@n` sequential assignment described above).
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

The ingest pipeline calls `normalize_mei()` after schema validation. If `report.warnings` is non-empty, the ingestion report surfaced to the admin includes those warnings. Files with warnings are stored but tagged with a `normalization_status = "warnings"` field in the `movement` metadata table; the tagging tool displays this status to annotators so they can interpret unexpected ghost behaviour in context.

---

## Relation to other documents

- `docs/roadmap/phase-1.md` — Component 1 (MEI Corpus Ingestion) specifies normalization as a required step before storage.
- `docs/architecture/prototype-tagging-tool.md` — Beat boundary computation and edge cases section describes what the tagging tool assumes about the normalized MEI it receives.
- `docs/architecture/fragment-schema.md` — The `bar_start`/`bar_end` coordinate system relies on the `@n` conventions established here.
- `docs/adr/ADR-005-sub-measure-precision.md` — The edge cases table references normalization outcomes (e.g. pickup bars normalized to `@n="0"`).
