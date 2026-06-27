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

e.g. `mozart__mozart-piano-sonatas.yaml`. A corpus with no overlay file (the
common case) simply gets no corrections — Pass 0 is a no-op.

## File format

```yaml
composer: mozart                       # informational; the filename is authoritative
corpus: mozart-piano-sonatas
corrections:
  - movement: k331/movement-2          # {work_slug}/{movement_slug} — the scope key
    target:
      xml_id: m1a2b3c4                  # xml:id of the affected <note> or <measure>
      fallback: "mc=49 staff=2 layer=1 (trio start)"   # advisory only, never resolved
    field: repeat-start                # one of: accid, accid.ges, repeat-start, repeat-end
    expected: null                     # current (wrong) value; null = attribute absent
    corrected: rptstart                # value to write; null = remove the attribute
    rationale: "DCML source omits the trio's start-repeat; NMA prints |:."
    class: errata                      # errata (objective, PR-worthy) | editorial (local preference)
    upstream: none                     # none | submitted (+ PR URL) | merged | superseded
    source_sha: 0123abcdef...          # DCML source git SHA this entry was authored against
    added: "2026-06-28 Francisco"
```

### Fields

| Field | Meaning |
|---|---|
| `movement` | `{work_slug}/{movement_slug}`; the loader filters on this. |
| `target.xml_id` | Authoritative locator — the MEI `xml:id` of the element. Stable per movement. |
| `target.fallback` | Human-readable `(mc, staff, layer, beat, pname, oct)`; used by a reviewer when an `xml_id` drifts. Never resolved mechanically. |
| `field` | What is corrected. Supported: `accid`/`accid.ges` (on the note's `<accid>` child), `repeat-start`/`repeat-end` (the measure's `@left`/`@right`). |
| `expected` | The current **wrong** value (pre-state). `null` = attribute currently absent. Load-bearing: the correction only fires when the element still holds this. |
| `corrected` | The value to write. `null` = remove the attribute. Must differ from `expected`. |
| `rationale` | Why it is wrong, **citing the reference edition**. |
| `class` | `errata` (objective error vs. a reference edition) or `editorial` (a defensible variant we prefer, kept local). |
| `upstream` | Upstream-PR status. |
| `source_sha` | DCML source git SHA the entry was authored against. |
| `added` | Date + author. |

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
