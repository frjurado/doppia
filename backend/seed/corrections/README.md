# MEI source-corrections overlays

This directory holds **corrections overlays** — versioned, attributed lists of
known errors in the *source data* (DCML/MuseScore export), applied by
`mei_normalizer` **Pass 0** at ingest, before the structural normalization
passes run. See **ADR-027** and `docs/architecture/mei-ingest-normalization.md`
§0 for the rationale and the full mechanism.

These are *data*, not code: adding or editing a correction never requires a
normalizer change (unless you introduce a brand-new `field` type).

## File naming

One YAML file per corpus:

```
{composer_slug}__{corpus_slug}.yaml
```

e.g. `mozart__piano-sonatas.yaml` — `composer_slug` and `corpus_slug` are the
slugs the ingestion service passes (`metadata.composer.slug` /
`metadata.corpus.slug`), i.e. the same slugs in the `mozart/piano-sonatas/`
object keys and the `/composers/mozart/corpora/piano-sonatas/` API path. The
filename must match those exactly or Pass 0 silently finds no overlay. A corpus
with no overlay file (the common case) simply gets no corrections — Pass 0 is a
no-op.

## File format

```yaml
composer: mozart                       # informational; the filename is authoritative
corpus: piano-sonatas                  # the corpus slug (matches the filename + object keys)
corrections:
  - movement: k331/movement-2          # {work_slug}/{movement_slug} — the scope key
    target:                            # COORDINATE locator (stable across re-encodes)
      mc: 65                           # document-order measure index (ADR-015) — the only field a measure target needs
      # for a NOTE target add: staff, (layer,) pname, oct, (occurrence)
      note: "Trio second strain, first measure"   # advisory description
    field: repeat-start                # one of: accid, accid.ges, repeat-start, repeat-end
    expected: null                     # current (wrong) value; null = attribute absent
    corrected: rptstart                # value to write; null = remove the attribute
    rationale: "DCML source omits the trio's start-repeat; NMA prints |:."
    class: errata                      # errata (objective, PR-worthy) | editorial (local preference)
    upstream: none                     # none | submitted (+ PR URL) | merged | superseded
    source_sha: 0123abcdef...          # DCML source git SHA this entry was authored against
    added: "2026-06-28 Francisco"
```

A **note**-level correction (e.g. an accidental) adds the voice/pitch coordinates:

```yaml
    target:
      mc: 24                           # measure (document order)
      staff: 1                         # <staff @n>
      layer: 1                         # <layer @n> (optional; omitted = search all layers)
      pname: c                         # pitch name a–g
      oct: 5                           # octave
      occurrence: 3                    # 1-based Nth note matching (pname, oct) in that (mc, staff, layer); default 1
      note: "beat-4 C5 (3rd of four C5s)"
    field: accid
```

### Fields

| Field | Meaning |
|---|---|
| `movement` | `{work_slug}/{movement_slug}`; the loader filters on this. |
| `target.mc` | **Locator** — the 1-based document-order measure index (DCML `mc` / Verovio position index, ADR-015). The *only* field a measure-level target (`repeat-start`/`repeat-end`) needs. Stable across a re-encode of the same music. |
| `target.staff` / `layer` | For a note target: the `<staff>`/`<layer>` `@n`. `layer` is optional (omitted = search every layer of the staff in document order). |
| `target.pname` / `oct` | For a note target: pitch name (`a`–`g`) + octave. Their presence marks the target as note-level. |
| `target.occurrence` | For a note target: the 1-based Nth note matching `(pname, oct)` in the located `(mc, staff, layer)`, document order. Defaults to `1`. |
| `target.note` | Optional human-readable description of the spot (advisory only). |
| `field` | What is corrected. Supported: `accid`/`accid.ges` (on the note's `<accid>` child), `repeat-start`/`repeat-end` (the measure's `@left`/`@right`). |
| `expected` | The current **wrong** value (pre-state). `null` = attribute currently absent. Load-bearing: the correction only fires when the element still holds this. |
| `corrected` | The value to write. `null` = remove the attribute. Must differ from `expected`. |
| `rationale` | Why it is wrong, **citing the reference edition**. |
| `class` | `errata` (objective error vs. a reference edition) or `editorial` (a defensible variant we prefer, kept local). |
| `upstream` | Upstream-PR status. |
| `source_sha` | DCML source git SHA the entry was authored against. |
| `added` | Date + author. |

## Notes for authors

- **Correcting an accidental:** author a single `field: accid` entry (the printed
  glyph — the actual difference from the reference edition). You do **not** need a
  paired `accid.ges` entry: Pass 9 drops any gestural that contradicts the
  corrected printed accidental, so the MIDI follows the print automatically
  (ADR-028). Keeping it one entry also keeps the `errata` set a clean upstream-PR
  backlog.
- **Why coordinates, not `xml:id`:** an earlier version located targets by
  `xml:id` (made reproducible per-prep by `xmlIdChecksum`, ADR-030). Verovio's
  ids are deterministic *run-to-run*, but they are reassigned by any change to
  the toolchain or the prep — so a pinned id silently stops resolving with no
  data change (every entry logged `CORRECTION_TARGET_MISSING` at the 2026-07-01
  re-ingest). `mc` + voice/pitch coordinates are invariant under a re-encode of
  the same music, so the overlay survives. Read the coordinates from the prepped
  MEI (or the DCML score) for the `source_sha` you pin.
- **Counting `occurrence`:** for a note target, count the matching `(pname, oct)`
  notes in the located `(mc, staff, layer)` in document (time) order; the entry
  resolves to the Nth. Naming the `layer` makes the count unambiguous.

## Merge-back / idempotence

The `expected` pre-state makes Pass 0 self-retiring (ADR-027 §3):

- Element already holds `corrected` → logged `CORRECTION_SUPERSEDED` (info), no-op.
  When this happens on a re-ingest, upstream has fixed it: set `upstream: merged`,
  bump `source_sha`, and move the entry to a corrections-changelog.
- Element holds `expected` → applied (audited in the ingestion report).
- Element holds neither → `CORRECTION_PRESTATE_MISMATCH` (warning): a human decides
  whether to retire or re-target.

## Upstream PRs

Filtering `class: errata` produces the upstream-PR backlog against the DCML
repository; the `rationale` + citation is most of the PR body already written.
`class: editorial` entries stay local.
