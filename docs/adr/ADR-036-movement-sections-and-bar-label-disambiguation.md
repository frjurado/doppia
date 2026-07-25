# ADR-036: Movement sections and bar-label disambiguation

**Date:** 2026-07-25
**Status:** Accepted — decided with Francisco 2026-07-25 during Component 11
Step 9 (M12). Implemented in `movement_section` +
`services/fragments.py` + `frontend/src/utils/fragmentRange.ts`. Evidence base:
[`docs/reports/component-11-reports/step-9a-duplicate-bar-number-survey.md`](../reports/component-11-reports/step-9a-duplicate-bar-number-survey.md).

---

## Context

ADR-015 established the dual measure-coordinate system: `mc` (document-order
position index) is the machine coordinate and is always unique; `bar_start` /
`bar_end` (the MEI `@n` value) is the human coordinate, the number a musician
reads off the score. That ADR's 2026-06-16 amendment accepted **duplicate `@n`**
as a human-coordinate ambiguity and deferred display-time disambiguation.

Component 11 makes fragments public, so the deferral came due: a stranger
reading "mm. 12–15" on a glossary example must be able to tell *which* mm. 12–15.

The § 9A survey of all 54 ingested movements established what is actually there:

- **One movement restarts its bar numbers.** `k331/movement-2` — Menuetto at
  `mc` 1–48 (`@n` 1–48), Trio at `mc` 49–101 (`@n` 1–52, then `X1`). The MEI
  marks the structure itself: `dir:MENUETTO` at mc 1, `dir:Fine` at mc 48,
  `dir:TRIO` at mc 49, `dir:Menuetto da capo` at mc 101. **The Trio restarting
  the count is the cause**, and the reprise is an instruction, not written-out
  bars — correcting the ADR-015 amendment, which describes a written-out repeat
  and gives the runs as "1–48 twice".
- **`k282/movement-2` has the same two-section shape but continuous numbering**
  (Menuetto I `mc` 1–34, Menuetto II `mc` 35–76). The NMA restarts at Menuetto II
  and the DCML encoding does not, so this is a source erratum, repaired
  separately (Component 11 Step 13).
- **Volta endings produce no duplicate labels in this corpus.** Nine movements
  carry `<ending>` elements; in every one the second ending's measure has an
  X-prefixed `@n` (`X1`, `X2`, …), never a repeat of the first ending's number.
  ADR-015 and `mei-ingest-normalization.md` §6 both document the opposite
  convention; that is a documentation erratum.
- **Neither affected movement carries fragments**, so no stored human coordinate
  drifts as a result of this work.

## Decision

### 1. A `movement_section` table carries editorial section spans

```
movement_section
    id           uuid    PK
    movement_id  uuid    FK → movement(id) ON DELETE CASCADE
    ordinal      int     1-based position within the movement
    name         text    display name ("Menuetto", "Trio")
    mc_start     int     inclusive, 1-based document-order index
    mc_end       int     inclusive
    UNIQUE (movement_id, ordinal)
    INDEX  (movement_id)
```

**Keyed on `mc`, never on `@n`.** `mc` is document order and survives a
re-ingest; `@n` is the very coordinate being disambiguated and cannot key its own
disambiguation.

**Bounds span `<ending>` measures.** K331/ii's Trio ends at `mc` 101, not 99: its
last two measures sit inside a volta ending. A walk over bare measures alone
would orphan any fragment tagged there.

**A movement with fewer than two sections has no rows**, so the ~52 unaffected
movements are untouched and the read path short-circuits on an empty result.

### 2. Section names are editorial, but derived from the score

The names are not invented: they are the `<dir>` text sitting at each boundary
in the MEI. The editorial act is *confirming and casing* a proposed name
("MENUETTO" → "Menuetto"), which is why a table of curated rows is defensible
rather than arbitrary. Populated by a script in `backend/data_migrations/`.

### 3. Detection is a validation guard, not persisted state

A script in the shape of `scripts/validate_graph.py` walks every movement's MEI,
computes the increasing runs of `@n`, and **fails when a movement whose numbering
restarts has no `movement_section` rows**. This is what stops a future corpus
from silently regressing to unqualified duplicate labels.

It deliberately persists nothing. The obvious home,
`movement.normalization_warnings`, is `null` for 52 of 54 movements — the
normalizer computes advisories and the ingest path drops them (Track M M15) — so
depending on that column would build on sand, and adding a second column to
duplicate it would entrench the problem.

### 4. The display convention

One formatter, applied everywhere a bar reference reaches a reader:

| Case | Rendering |
|---|---|
| Unsectioned movement, no repeat context | `mm. 12–15` (unchanged) |
| Sectioned movement | `Trio, mm. 12–15` |
| Volta | `mm. 12–15 (1st ending)` |
| Both | `Trio, mm. 12–15 (1st ending)` |

**Both sections are qualified, not only the second.** In a sectioned movement an
unqualified label is itself ambiguous — the reader cannot know whether its
absence means "first section" or "not applicable".

**The volta suffix is prose, not the stored enum.** `repeat_context` reaches the
UI today as the raw string `first_ending`. The survey demoted this from a
correctness fix to a cosmetic one — no volta is ambiguous in this corpus — but it
is retained: a label that reads as standard musical text is this decision's whole
point, and an enum leaking into the UI fails that regardless of ambiguity.

### 5. `section_label` is resolved server-side

The service resolves a fragment's section by `mc` containment and exposes
`section_label: str | None` on the fragment read models — including
`ConceptBrowseItem`, the model behind public browse cards *and* glossary example
captions, which carries no machine coordinate at all and therefore cannot
disambiguate client-side.

Resolution is server-side because the section spans are server data, because the
public card model would otherwise have to grow `mc_start`/`mc_end` purely for
display, and because every consumer must reach the same answer.

## Consequences

- ADR-015's amendment is corrected on three points of fact (the cause of
  K331/ii's duplication, the extent of its runs, and the volta convention), and
  its "duplicate `@n` … is never used as a join key, so no data is at risk" is
  narrowed: it holds for rendering and fragment ranges, not for the harmony
  layer, whose event identity `(mn, volta, beat)` collides across a restart. That
  fix is scoped separately (Component 11 Step 10, with M6, since it shares a
  function with M6's slice-precision bug).
- `mei-ingest-normalization.md` §6's duplicate-`@n`-in-endings convention is
  corrected to the X-complement shape the corpus actually has.
- A re-ingest that changes document order would invalidate `mc_start`/`mc_end`
  here exactly as it would invalidate `fragment.mc_start`/`mc_end`. The
  mc-stability check that already guards re-ingest covers both.
- Editorial burden is four rows across two movements. If a future corpus brings
  many sectioned movements, the § 3 guard is what surfaces them; the names still
  need a human, which is the intended trade.

## Alternatives considered

**Derive a pass ordinal automatically ("m. 12, 2nd pass").** Rejected: no
editorial input needed, but the label is musically mute where the score itself
supplies "Trio". The detection machinery it would have required is kept, as § 3's
guard.

**Show the machine coordinate when ambiguous ("mm. 12–15 · mc 60–63").**
Rejected: cheapest, but it puts an internal coordinate in front of a public
reader.

**A movement-level note only ("bar numbers restart at the Trio").** Rejected: it
does not disambiguate two cards side by side in a list, which is the case this
exists for.

**JSONB `sections` column on `movement`.** Rejected in favour of the table: the
read path resolves a section for every fragment on a page of browse cards, which
is one indexed join versus a per-row JSON scan, and the rows are curated
editorial content worth constraining.

**Store the qualifier per fragment at tag time** (the ADR-015 pattern of writing
both coordinates at tag time). Rejected: it duplicates information derivable from
`mc` plus movement structure, needs a backfill per fragment rather than per
movement, and puts a structural question to the annotator on every tag.
