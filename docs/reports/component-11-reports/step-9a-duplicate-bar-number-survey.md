# Step 9A — Duplicate bar-number survey of the ingested corpus

*Component 11, Step 9 (M12). Run 2026-07-25 against the local stack, which
carries the full 54-movement re-ingest.*

This is the survey § 9A of the Component 11 plan requires before any of Step 9's
design is committed to. It answers: **which movements actually carry ambiguous
bar labels, and what does the ambiguity look like?**

The short answer: **one movement, K331/ii** — and the volta family the plan
assumed exists **does not exist in this corpus at all**. Both findings change the
plan; see § Consequences.

---

## Method

The intended source — `movement.normalization_warnings` — turned out to be
**unusable**: it is `null` for **52 of 54** movements, including K331/ii. Only
`k333/movement-1` and one other row carry anything. The 54-movement re-ingest
(2026-07-05) evidently did not persist normalizer advisories, so the column
records almost nothing about the corpus it describes. **This is a defect in its
own right** (see § Consequences).

The survey therefore went to the authoritative source: every movement's
normalised MEI, read from object storage via `mei_object_key`, walking
`<measure>` elements in document order and recording, per measure, its `mc`
(1-based document-order rank), its `@n`, and whether it sits inside an `<ending>`.
Per movement it computes:

- **increasing runs of `@n`** over measures outside `<ending>` — more than one
  run means the numbering restarts;
- `@n` values repeated outside `<ending>` that are *not* part of a clean restart;
- `@n` values shared across sibling `<ending>` elements;
- non-integer `@n`;

joined against fragment counts per movement (a movement carrying fragments is one
where a renumbering would need a data migration).

Cross-checked against `<dir>`/`<tempo>` text to locate and name section
boundaries.

---

## Results

### Family A — restarting bar numbers: exactly one movement

**`k331/movement-2` (Menuetto)** — 101 measures, two runs:

| Section | `mc` | `@n` | Evidence in the MEI |
|---|---|---|---|
| Menuetto | 1–48 | 1–48 | `dir:MENUETTO` at mc 1; `dir:Fine` at mc 48 |
| Trio | 49–101 | 1–52, then `X1` | `dir:TRIO` at mc 49; `dir:Menuetto da capo` at mc 101 |

No fragments (`fragments=0, approved=0`).

Three corrections to what the docs say about this movement:

1. **The cause is the Trio restarting the count** — `dir:TRIO` sits exactly at
   the restart, and the movement ends with `dir:Menuetto da capo`, i.e. the
   reprise is an instruction, not written-out bars. The ADR-015 amendment's
   "a written-out repeat … *not* the minuet+trio renumbering" is wrong on both
   halves.
2. **The runs are 1–48 and 1–52, not "1–48 twice"** (also ADR-015).
3. **The Trio's section ends at mc 101, not mc 99.** Its last two measures
   (mc 100 `@n=52`, mc 101 `@n=X1`) are inside a volta ending, so any analysis
   that walks only bare measures — including the normalizer's current run
   computation — stops short of the true section end. **Section bounds must be
   computed over all measures, ending measures included.**

### Family B — `@n` shared across sibling endings: zero movements

Nine movements carry `<ending>` elements (24 in-ending measures in total). In
**every** one of them the second ending's measure carries an **X-prefixed `@n`**,
never a repeat of the first ending's number:

| Movement | First ending | Second ending |
|---|---|---|
| k283/movement-2 | mc 14 `@n=14` | mc 15 `@n=X1` |
| k331/movement-1 | mc 98 `@n=98` | mc 99 `@n=X1` |
| k331/movement-2 | mc 100 `@n=52` | mc 101 `@n=X1` |
| k310/movement-3 | mc 174 `@n=174` | mc 175 `@n=175` |
| … 5 more | same shape | same shape |

**So volta endings produce no ambiguous bar labels in this corpus.** The
convention documented in `mei-ingest-normalization.md` §6 — *"The first ending's
bar 12 and the second ending's bar 12 both carry `@n="12"`"* — and the same claim
in ADR-015 ("it repeats across volta endings (both endings share `@n="3"`)")
**do not describe the corpus we actually have**. This is a documentation erratum,
not a data defect.

Five fragments carry `repeat_context = first_ending`, all on `k331/movement-1`,
none approved. No fragment sits in a second ending.

### The X-prefixed `@n` family — 16 movements, and not an ambiguity

X-prefixed `@n` is far more widespread than either family above (up to 26
occurrences in `k284/movement-3`). The local context is identical everywhere:

```
mc= 13 @n='12'  metcon='false'
mc= 14 @n='X1'  metcon='false'   <<<
mc= 15 @n='13'  metcon='false'
```

An X measure is the **second half of a bar split across a repeat boundary**, not
a bar in its own right. It shares its notated bar number with its predecessor, so
it creates no *label* ambiguity — two fragments both reading "m. 12" are in the
same notated bar, and their beats distinguish them, which is exactly what
`formatFragmentRange` already renders.

One latent gap worth recording rather than acting on: `fragment.bar_start` is an
`INTEGER` column and cannot represent `X1`, so a selection whose first measure is
an X complement (or a second volta ending, which is always an X measure here) has
no faithful human coordinate to store. No such fragment exists today. **Decided
2026-07-25: documented and deferred as Track M M16**, for whoever next touches
selection bounds.

### K282/ii — the source erratum is confirmed

`k282/movement-2` — 76 measures, `@n` running 0–72 **continuously**, no restart:

| Section | `mc` | `@n` | Evidence |
|---|---|---|---|
| Menuetto I | 1–34 | 0–32 (+`X1` at mc 14) | `dir:Menuetto I` at mc 1; `dir:Fine` at mc 34 |
| Menuetto II | 35–76 | `X2`, 33–72 (+`X3` at mc 52) | `dir:Menuetto II` at mc 35; `dir:Menuetto I da capo` at mc 76 |

So the movement has the same shape as K331/ii — two sections plus a *da capo*
instruction — but its numbering does **not** restart, which is what Francisco
identified as a divergence from the NMA. Confirmed.

Two facts that make the Step 13 repair cheap: **the movement carries no
fragments**, so no `bar_start`/`bar_end` migration is needed; and the boundary is
unambiguous (mc 35). One wrinkle: mc 35 is itself an `X2` split complement — the
anacrusis into Menuetto II — so the renumbering has to decide what that measure
becomes (the pickup convention is `@n="0"`, `metcon="false"`).

### Fragment inventory (context for any renumbering)

65 fragments total, 9 approved, on 8 movements: k279/i (9, 1 approved), k280/i
(8, 2), k280/ii (4, 0), k283/i (13, 3), k330/i (5, 1), k331/i (18, 1),
k331/iii (4, 1), k332/i (4, 0). **Neither K331/ii nor K282/ii carries any.**

---

## Consequences for the Step 9 plan

1. **Family B drops out of the ambiguity work.** There is nothing to disambiguate
   — no two measures in this corpus share a bar label because of a volta. What
   remains of the volta item is cosmetic: the detail panel prints the raw enum
   `first_ending`, which should read as prose. **Decided 2026-07-25: it stays in
   Step 9** — the step's standard is a label that reads as standard, musically
   meaningful text, and an enum leaking into the UI fails that whether or not it
   is ambiguous. It gates nothing, so it is the first thing to cut if the step
   runs long.
2. **The scale is one movement, with one more (K282/ii) arriving in Step 13.**
   The editorial section model is still the right shape — but "few and alike" is
   now measured, not assumed, and the editorial data is two movements × two
   sections.
3. **Section names are already in the score.** `MENUETTO`/`TRIO` and
   `Menuetto I`/`Menuetto II` come from `<dir>` elements at exactly the section
   boundaries. The editorial step is *confirming and casing* a proposed name, not
   inventing one — and § 9B's detection can propose both the bounds and the name.
   This makes the `movement_section` seed defensible rather than arbitrary.
4. **Section bounds must include `<ending>` measures.** K331/ii's Trio would
   otherwise be recorded as mc 49–99 instead of 49–101, and a fragment in the
   Trio's second ending would resolve to no section at all.
5. **`movement.normalization_warnings` cannot be relied on.** It is null for 52
   of 54 movements, so § 9B's plan to persist structured runs *there* would write
   into a column nothing currently populates. A normalizer that reports 51
   advisories for K331/ii and stores none of them is a reporting gap well beyond
   M12. **Decided 2026-07-25: documented and deferred as Track M M15**; § 9B
   persists nothing and ships its detection as a validation script instead, so
   Step 9 does not depend on the broken column or add a second one.
6. **Neither repair needs a data migration.** No fragments exist on either
   affected movement, so the K282/ii renumbering (Step 13) and the K331/ii
   sectioning (Step 9) are both free of the `bar_start` drift ADR-015 warns about
   — provided they land before anything is tagged there.

## Docs this survey contradicts

- **ADR-015 § Amendment** — the K331/ii account (written-out repeat; "1–48
  twice"); and the volta claim that endings share `@n`.
- **`mei-ingest-normalization.md` §6** — the documented duplicate-`@n`-in-endings
  convention does not match the corpus.

Both are corrected as part of Step 9 (§ Docs to update in the plan).

## Reproducing

The survey is a read-only walk of `movement` + the MEI objects; it was run as a
throwaway script rather than committed tooling, since § 9B moves the detection
into the normalizer where it belongs. To re-run it, join `movement` to `work`,
read each `mei_object_key` through `services.object_storage.make_storage_client`,
and walk `<measure>` elements recording `(mc, @n, enclosing <ending> @n)`.
