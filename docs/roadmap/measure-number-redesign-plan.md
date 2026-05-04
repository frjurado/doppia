# Measure Number System Re-design — Planning Document

## The Issue & Solution

The codebase has three measure-identification systems with no defined bridge between them:

- **MEI `@n`** — the notated bar number. Human-readable, but fragile: can be non-integer (`X1`, `X2` in MuseScore exports), repeats across volta endings, pickup bars use `@n="0"`. Currently used as the key in `_build_measure_map` and as the stored value in `fragment.bar_start`/`bar_end`.
- **DCML `mc`** — 1-based, monotonically increasing, always integer, assigned by the annotator in document order. Stable machine identifier. Currently used only in `events[].mc` and as the smart-merge key.
- **Verovio position index** — 1-based document order, as used by `measureRange` in `tk.select()`. Currently undocumented as a first-class concept.

The key insight: **`mc` and Verovio position index are the same counter.** Both are 1-based document-order ranks over `<measure>` elements. The existing `_build_measure_map` fails silently on non-integer `@n` (the Mozart staging corpus already produces spurious alignment warnings for this reason), and there is no defined path from `bar_start`/`bar_end` to the position index Verovio needs for fragment rendering.

**The solution:** make the dual role of each coordinate explicit. `mc` / position index is the machine coordinate, stored as `mc_start`/`mc_end` on the fragment. `@n` is the human coordinate, retained as `bar_start`/`bar_end`. Both are written at tag time (the tagging tool has the MEI in memory and can supply both without an extra round-trip). Reads need no lookups — the row is self-contained.

---

## The Plan

**Draft → Spike → Implement → Incipits → Component 3**

The draft defines the schema and code changes. The spike validates the Verovio behaviour the draft depends on before any schema migration is committed. Implementation applies the design. Incipits are fixed using the new select approach. Component 3 inherits the clean coordinate system.

---

## Draft: What Changes

### Schema (`fragment` table)

Add two columns:

```sql
mc_start  INTEGER NOT NULL,   -- position index; maps directly to Verovio measureRange
mc_end    INTEGER NOT NULL,   -- position index; maps directly to Verovio measureRange
```

`bar_start` and `bar_end` **keep their existing semantics** (`@n` values, human-readable bar numbers). No migration of existing data is required — the new columns are additive. `repeat_context` is retained but becomes display-only ("first ending", "second ending"); it is no longer needed for measure disambiguation since `mc_start`/`mc_end` already identify the physical measures unambiguously.

A new Alembic migration adds the columns with `NOT NULL` and a sensible temporary default (e.g. `bar_start`) for any existing rows, to be backfilled on next re-tag.

### Backend code

**`_build_measure_map`** — redesign to return `{position_index: MeasureEntry}` instead of `{(mn, volta): xml_id}`. `MeasureEntry` holds `n_raw` (the raw `@n` string, not parsed), `volta`, and `xml_id`. Non-integer `@n` values are no longer silently dropped — the entry is still added with the raw string preserved.

**Alignment check in `_parse_dcml_harmonies`** — replace `(ev["mn"], ev["volta"]) not in measure_map` with `ev["mc"] not in measure_map`. Simpler, and correct even when `@n` is non-integer.

**Fragment write path** (ingestion service / tagging tool API) — must accept and store `mc_start`/`mc_end` alongside `bar_start`/`bar_end`. The tagging tool computes both from the MEI it already holds.

**Fragment read path** (browse/render endpoints) — `mc_start`/`mc_end` are returned in the API response and used directly as the `measureRange` operands when constructing Verovio render calls.

### Tests

- `test_ingest_analysis.py`: update `_build_measure_map` tests for the new return structure; flip `X1`/`X2` tests from "silently dropped" to "entry present with raw string"; update alignment-check tests to use `mc` keying.
- Fragment model tests: add `mc_start`/`mc_end` to valid-construction cases.
- A new Alembic migration test (if the pattern exists) or a note in the migration file.

### Docs

- `docs/architecture/fragment-schema.md` — update `bar_start`/`bar_end` description; add `mc_start`/`mc_end` spec; update `repeat_context` to display-only.
- `docs/architecture/mei-ingest-normalization.md` — update the `_build_measure_map` description in any section that references it.
- New ADR-015 (see separate document).

---

## Interlude: The `_FLAT_KEY_TONICS` Bug

**[SOLVED]**

**File:** `backend/services/tasks/ingest_analysis.py`
**Function:** `_parse_global_key` (around line 185)

**The bug.** `_FLAT_KEY_TONICS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"}` is tested against `letter`, which is always a single character extracted from the input string. The multi-character entries (`"Bb"`, `"Eb"`, etc.) can never match a single character. Only `"F"` ever fires. As a result, `_parse_global_key("Bb")` returns `use_flats=False`, and any Roman-numeral resolution relative to a Bb-major (or Eb, Ab, Db, Gb, Cb) global key produces sharp spellings instead of flat ones.

**The fix.** `note = letter.upper() + acc` is already computed earlier in the function. Replace the buggy line with:

```python
# Before:
use_flats = letter in _FLAT_KEY_TONICS or (not acc and letter == "F")

# After:
use_flats = note in _FLAT_KEY_TONICS
```

The `or (not acc and letter == "F")` clause is redundant after this change because `"F"` is already in `_FLAT_KEY_TONICS` and `note` for a plain F input is `"F"`.

**Tests to update.** `test_bb_major_use_flats_false` and `test_eb_major_use_flats_false` currently pin the broken behaviour as known limitations. After the fix, both should be renamed (e.g. `test_bb_major_use_flats`) and their assertions flipped to `assert use_flats is True`. Add equivalent cases for `Eb`, `Ab`, `Db`, `Gb`, `Cb`. Verify that `_resolve_key("IV", "Bb")` returns `"Eb major"` (not `"D# major"`) as a downstream integration check.

---

## Spike: What We're Looking For

The existing spike (see `docs/architecture/mei-ingest-normalization.md`) confirmed `tk.select()` + `tk.redoLayout()` works in Verovio 6.1.0 and that `measureRange` uses 1-based position indices. What it did **not** test:

1. **`"start-N"` syntax for incipits.** Does `measureRange: "start-4"` correctly render the first four measures, including a pickup bar at `@n="0"` at position 1? Expected: pickup bar included automatically, four measures total, same output as `measureRange: "1-4"` on a pickup fixture.

2. **Mid-score position index correctness.** Does `measureRange: "3-5"` on the volta fixture (where position 2 is inside `<ending n="1">` and position 3 is inside `<ending n="2">`) select the expected measures? Expected: exactly the measures at those document-order positions, not confused by the shared `@n="2"`.

3. **`"end"` keyword behaviour.** Does `measureRange: "3-end"` render from position 3 to the last measure? Expected: yes; useful as a sanity check and for the incipit fallback.

4. **Behaviour when `N` exceeds the movement length.** Does `measureRange: "start-100"` on a 6-measure piece fall back gracefully? Expected: renders all measures without error.

The spike script should run against `k331-movement-1.mei` (6 measures, no endings), `volta-movement.mei` (4 positions, two sharing `@n="2"`), and the pickup fixture (anacrusis + 5 full measures). Output: SVG measure counts and pixel dimensions at `scale=35`, compared against the baseline from the previous spike. Findings go into `docs/architecture/mei-ingest-normalization.md` as a new section.

---

## Implementation

All decisions are settled by the draft and the spike. No open questions remain. The steps below are ordered so that each one compiles and passes tests before the next begins.

### Step 1 — Alembic migration (`0004_fragment_mc_columns.py`)

Create `backend/migrations/versions/0004_fragment_mc_columns.py`. The migration adds `mc_start` and `mc_end` as `INTEGER NOT NULL` with a temporary server default of `bar_start` so that the column can be added without violating the `NOT NULL` constraint on existing rows. The default is a stopgap only; all existing rows are stale until re-tagged.

```python
"""Add mc_start and mc_end position-index columns to fragment.

mc_start and mc_end are 1-based document-order position indices over
<measure> elements in the MEI source. They map directly to Verovio's
measureRange operands. bar_start/bar_end retain their existing semantics
(@n values, human-readable bar numbers) and are not changed.

Existing rows receive mc_start = bar_start, mc_end = bar_end as a
temporary default. These values are incorrect for any fragment that
crosses a non-integer @n measure or a repeat ending; they will be
corrected on next re-tag. Do not use mc_start/mc_end from existing
rows for rendering until the movement has been re-ingested.

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-04
"""

from __future__ import annotations
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Temporary server_default lets us add NOT NULL columns to a populated table.
    # The default is intentionally wrong (bar_start ≠ mc_start in general);
    # existing rows must be re-tagged to get correct values.
    op.add_column(
        "fragment",
        sa.Column(
            "mc_start",
            sa.Integer,
            nullable=False,
            server_default=sa.text("bar_start"),
        ),
    )
    op.add_column(
        "fragment",
        sa.Column(
            "mc_end",
            sa.Integer,
            nullable=False,
            server_default=sa.text("bar_end"),
        ),
    )
    # Drop server defaults after backfill — they must not persist in the schema.
    op.alter_column("fragment", "mc_start", server_default=None)
    op.alter_column("fragment", "mc_end", server_default=None)


def downgrade() -> None:
    op.drop_column("fragment", "mc_end")
    op.drop_column("fragment", "mc_start")
```

### Step 2 — SQLAlchemy model (`backend/models/fragment.py`)

Add two mapped columns to `Fragment`, immediately after `bar_end`. Update the class docstring to describe both coordinate systems. Mark `repeat_context` as display-only.

```python
# In the Fragment class, after bar_end:

mc_start: Mapped[int] = mapped_column(Integer, nullable=False)
mc_end: Mapped[int] = mapped_column(Integer, nullable=False)
```

Update the class docstring: replace the existing paragraph about `bar_start`/`bar_end` with the following.

> Bar positions use two coordinate systems. `bar_start`/`bar_end` are `<measure @n>` values from the MEI source — human-readable, but fragile (non-integer in some exports, repeating across volta endings). `mc_start`/`mc_end` are 1-based document-order position indices over `<measure>` elements — machine-stable, directly usable as `measureRange` operands in Verovio. Both coordinates are written at tag time by the tagging tool, which has the MEI in memory. `repeat_context` is display-only ("first ending", "second ending") and is no longer needed for measure disambiguation.

### Step 3 — `_build_measure_map` redesign (`backend/services/tasks/ingest_analysis.py`)

Replace the existing function with the new design. The key changes are: the return type becomes `dict[int, MeasureEntry]` keyed by 1-based position index; non-integer `@n` values are no longer silently dropped; `MeasureEntry` carries `n_raw`, `volta`, and `xml_id`.

Add `MeasureEntry` as a module-level dataclass near the top of the file, alongside the other small data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class MeasureEntry:
    """One measure's metadata, keyed in the measure map by position index (mc).

    n_raw is the raw @n attribute string — not parsed to int, so non-integer
    values like "X1" or "12a" are preserved rather than dropped.
    volta is the integer @n of the enclosing <ending>, or None if the measure
    is not inside any <ending>.
    xml_id is the measure's xml:id, or '' if none is present.
    """
    n_raw: str
    volta: int | None
    xml_id: str
```

Replace `_build_measure_map` with:

```python
def _build_measure_map(mei_bytes: bytes) -> dict[int, MeasureEntry]:
    """Build a ``position_index → MeasureEntry`` map by walking the normalized MEI.

    The position index is 1-based document order over all ``<measure>`` elements
    in the file — the same counter as DCML ``mc`` and Verovio's ``measureRange``
    operand. Non-integer ``@n`` values are preserved as ``n_raw``; they no longer
    cause the entry to be silently dropped.

    Used to verify that every TSV row's ``mc`` value resolves to a known measure
    in the MEI source. Returns an empty dict on XML parse failure so alignment
    verification degrades gracefully.

    Args:
        mei_bytes: Normalized MEI bytes fetched from object storage.

    Returns:
        Dict mapping 1-based position indices to MeasureEntry instances.
    """
    try:
        root = lxml.etree.fromstring(mei_bytes)
    except lxml.etree.XMLSyntaxError:
        return {}

    measure_map: dict[int, MeasureEntry] = {}
    position = 0
    for measure in root.iter(f"{{{_MEI_NS}}}measure"):
        position += 1
        n_raw = measure.get("n", "")
        xml_id = measure.get(f"{{{_XML_NS}}}id", "")

        volta: int | None = None
        parent = measure.getparent()
        while parent is not None:
            if parent.tag == f"{{{_MEI_NS}}}ending":
                v = parent.get("n")
                try:
                    volta = int(v) if v else None
                except (ValueError, TypeError):
                    volta = None
                break
            parent = parent.getparent()

        measure_map[position] = MeasureEntry(n_raw=n_raw, volta=volta, xml_id=xml_id)

    return measure_map
```

### Step 4 — Alignment check in `_parse_dcml_harmonies`

Replace the `(mn, volta)` keyed check at the bottom of `_parse_dcml_harmonies` with `mc` keying. The relevant block currently reads:

```python
# current (to be replaced):
measure_map = _build_measure_map(mei_bytes)
for ev in events:
    key = (ev["mn"], ev["volta"])
    if key not in measure_map:
        alignment_warnings.append(
            f"TSV event at mn={ev['mn']} volta={ev['volta']} "
            f"(mc={ev['mc']}) has no matching measure in MEI."
        )
```

Replace with:

```python
# new:
measure_map = _build_measure_map(mei_bytes)
for ev in events:
    mc = ev["mc"]
    if mc is None or mc not in measure_map:
        alignment_warnings.append(
            f"TSV event at mc={mc} mn={ev['mn']} volta={ev['volta']} "
            f"has no matching measure in MEI."
        )
```

`mc` is already present on every event dict (parsed earlier in the function). `mc=None` covers rows where the TSV `mc` column is NaN; those rows are also flagged because they cannot be located in the MEI by position index.

### Step 5 — Fragment write path

The fragment write path is in the tagging tool (Component 3, not yet implemented). In preparation, the `FragmentCreate` Pydantic model (to be defined in `backend/models/fragment.py` when the tagging API is built) must include `mc_start: int` and `mc_end: int` as required fields alongside `bar_start` and `bar_end`. The service layer must write all four columns. The tagging tool has the MEI in memory and computes `mc_start`/`mc_end` by calling the position-index walk (effectively the same iteration as the new `_build_measure_map`) over the measures it already has.

For now, document this as a constraint in the existing `FragmentCreate` placeholder if one exists, or leave a `# TODO(tagging-tool): mc_start, mc_end required at write time` comment in `models/fragment.py` near the new columns.

### Step 6 — Fragment read path

Any endpoint that returns fragment data must include `mc_start` and `mc_end` in its response schema. Check all Pydantic response models in `backend/models/` that reference `bar_start` or `bar_end` and add the two new fields with the same types. The browse API (`backend/api/routes/browse.py`) is the most immediate case — verify that any fragment serialization there exposes `mc_start`/`mc_end` so the frontend can use them as `measureRange` operands in Component 3.

### Step 7 — `generate_incipit.py`

Replace the `breaks="smart"` / page-1 approach with the `select` + `redoLayout` approach confirmed by the spike (Finding 6–9, `mei-ingest-normalization.md §2026-05-04`).

The core Verovio call block currently reads:

```python
tk.setOptions({
    "pageWidth": 800,
    "pageHeight": 800,
    "adjustPageHeight": True,
    "breaks": "smart",
    "scale": 35,
})
ok = tk.loadData(mei_text)
if not ok:
    raise RuntimeError(...)
svg = tk.renderToSVG(1)
```

Replace with:

```python
_INCIPIT_BARS = 4

tk.setOptions(
    {
        "pageWidth": 2200,
        "adjustPageHeight": True,
        "breaks": "none",
        "scale": 35,
    }
)
ok = tk.loadData(mei_text)
if not ok:
    raise RuntimeError(
        f"Verovio failed to load MEI for movement {movement_id}. "
        f"Log: {tk.getLog()}"
    )

duration_bars: int | None = row.duration_bars
if duration_bars is not None and duration_bars < _INCIPIT_BARS:
    measure_range = "start-end"
else:
    measure_range = f"start-{_INCIPIT_BARS}"

tk.select({"measureRange": measure_range})
tk.redoLayout()
svg = tk.renderToSVG(1)
```

`row.duration_bars` requires adding `mv.duration_bars` to the `SELECT` in the existing SQL query in `_generate_incipit_async`. The `_INCIPIT_BARS = 4` constant sits at module level; if per-corpus configurability is needed later, it can be promoted to an environment variable without touching the call site.

Also remove the `pageHeight: 800` key — it is meaningless when `adjustPageHeight` is true and `breaks="none"` produces a single-page layout.

### Step 8 — Tests

**`test_ingest_analysis.py` — `TestBuildMeasureMap`**

The entire `TestBuildMeasureMap` class must be rewritten for the new return type. Key changes:

- All assertions against `{(mn, volta): xml_id}` dicts become assertions against `{position_index: MeasureEntry(n_raw=..., volta=..., xml_id=...)}` dicts.
- `test_non_integer_n_silently_dropped` and `test_real_world_x1_x2_labels_dropped` and `test_n_with_alpha_suffix_dropped` are renamed to `test_non_integer_n_preserved_in_n_raw`, `test_real_world_x1_x2_labels_preserved`, and `test_n_with_alpha_suffix_preserved`. Their assertions flip: the entries must now *be present* in the map, with `n_raw` holding the raw string.
- `test_simple_linear_score`: assert `{1: MeasureEntry("1", None, "m1"), 2: MeasureEntry("2", None, "m2"), 3: MeasureEntry("3", None, "m3")}`.
- `test_volta_endings_produce_distinct_keys`: assert `{1: MeasureEntry("1", None, "m1"), 2: MeasureEntry("2", 1, "m2v1"), 3: MeasureEntry("2", 2, "m2v2"), 4: MeasureEntry("3", None, "m3")}`. Note position indices are now contiguous even across endings.
- Add a new test `test_x1_x2_position_indices_are_stable`: given a sequence `X1, 1, X2, 2`, assert that position 1 has `n_raw="X1"`, position 2 has `n_raw="1"`, position 3 has `n_raw="X2"`, position 4 has `n_raw="2"`. This directly documents the fix for the Mozart staging alignment warnings.
- `test_missing_n_attr_silently_skipped` becomes `test_missing_n_attr_n_raw_is_empty_string`: assert entry is present with `n_raw=""`.

**`test_ingest_analysis.py` — alignment check tests**

In `TestParseDcmlHarmonies.test_alignment_warning_on_unknown_measure` and `test_no_alignment_warning_on_known_measure`, update the assertion messages (which now say `mc=...` rather than `mn=... volta=...`) and update the fixture MEI so the measure map is keyed by position index. The tests using `mc=99` as an unknown position still produce a warning; ensure the fixture TSV emits `mc=99`.

**Fragment model tests**

Add `mc_start` and `mc_end` to any `Fragment` construction fixtures in unit tests. If a factory helper exists, add the two fields there.

**`test_generate_incipit.py`**

Update the integration test to expect the new Verovio call sequence: `select` called with `{"measureRange": "start-4"}` (or `"start-end"` for short movements), `redoLayout` called before `renderToSVG`. If the test mocks the `verovio.toolkit` object, add assertions that `mock_tk.select.called` and `mock_tk.redoLayout.called` are true, and that `mock_tk.setOptions` was called with `breaks="none"` rather than `breaks="smart"`.

### Step 9 — Docs

**`docs/architecture/fragment-schema.md`**

- In the schema table near the top, add rows for `mc_start INTEGER NOT NULL` and `mc_end INTEGER NOT NULL` immediately after `bar_end`, with descriptions: "1-based document-order position index; maps directly to Verovio `measureRange` start/end operand".
- Update the `bar_start`/`bar_end` prose section to explain that these remain `@n` values (human-readable) while `mc_start`/`mc_end` are the machine coordinates. Add a cross-reference: "See `docs/adr/ADR-015-dual-measure-coordinate-system.md` for the rationale and alternatives considered."
- Add a new `mc_start`/`mc_end` prose section immediately after, explaining the position-index semantics and the direct Verovio `measureRange` mapping.
- Update the `repeat_context` description from its current form to: display-only ("first ending", "second ending"); no longer needed for rendering disambiguation since `mc_start`/`mc_end` identify the physical measure unambiguously. Note that it remains in use for harmony event range filtering until that query is migrated to `mc`-based filtering in Component 3 (see ADR-015).
- In the "Things that belong in the fragment table columns" enumeration (the passage listing `bar_start`, `bar_end`, `status`, etc.), add `mc_start` and `mc_end` to the list.
- In the approval-gate harmony range query description (§ approval gate, the block describing how events are filtered by `(mn, volta)` + `repeat_context`): add a note that the cleaner long-term approach filters by `mc` range directly, and that this simplification is deferred to Component 3 — see ADR-015.

**`docs/architecture/mei-ingest-normalization.md`**

- In the `_build_measure_map` description (§ "Measure `@n` conventions"), replace the current description of the `{(mn, volta): xml_id}` return structure with a description of the new `{position_index: MeasureEntry}` structure. Note that non-integer `@n` values are now preserved. Add: "See `docs/adr/ADR-015-dual-measure-coordinate-system.md`."
- Add a cross-reference to Finding 6–9 from the 2026-05-04 spike as the basis for the `"start-N"` incipit syntax.

---

## Incipits

The current approach (smart-break, page-1, `pageWidth=800`) has documented quality problems: single-bar incipits when the first measure is wide, and illegible crowded incipits on dense movements. Both are symptoms of letting Verovio's layout algorithm decide how many bars to show.

The new plan reverts to the originally intended approach, now confirmed working: `select({measureRange: "start-4"})` + `redoLayout()`. This guarantees a fixed bar count regardless of notation density or measure width.

Open questions to resolve during this step:

- What is the right default N? Probably 4, possibly configurable per corpus. Needs a quick visual check against the 15 staged movements.
- What if a movement has fewer than N measures? Use `"start-end"` or `"start-{duration_bars}"` as fallback; `movement.duration_bars` is already stored.
- Does the resulting SVG width need adjustment? The previous spike found `pageWidth=2200, breaks="none"` for select-based rendering. Verify this produces readable output across the staged movements before committing.

The `generate_incipit` Celery task is the only file that changes. Backfill required for all staged movements after the task is updated.

---

## Component 3

No implementation decisions yet. Points to carry in:

- Fragment rendering uses `mc_start`/`mc_end` directly as `measureRange` operands — no coordinate conversion needed at render time.
- Vitest setup is part of this component (flagged as a known gap since Report 7 Issue 1).
- All open frontend issues from Reports 5 and 6 are to be addressed during this component, not before. They have been deliberately deferred here.
