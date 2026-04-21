# Corpus and Analysis Sources

## Design Reference for the Music Theory Tutor System

---

## Score Sources

### Priority order

**1. OpenScore** — primary source for scores

- Collections: Lieder (~1,300 songs), String Quartets (~100 multi-movement works), Orchestral (~100 movements)
- Repertoire: predominantly 19th-century tonal music, ideally suited to the harmonic pedagogy focus
- Format: MusicXML (`.mxl`) and compressed MuseScore (`.mscz`) on the fourscoreandmore mirror; uncompressed MuseScore (`.mscx`) on GitHub
- Licence: **CC0** — no attribution required, no ShareAlike restriction, unrestricted commercial and derivative use
- MEI pipeline: MusicXML → MEI via Verovio CLI (single hop)
- Limitation: does not include Mozart or Beethoven piano sonatas; coverage is Lieder and chamber music

**2. DCML Corpora** — secondary source where OpenScore has no coverage

- Collections: Beethoven piano sonatas, Beethoven string quartets (ABC), Mozart piano sonatas, Chopin mazurkas, Corelli trio sonatas, Grieg Lyric Pieces, Schubert, Schumann, Dvořák, Liszt, Tchaikovsky, Medtner, Debussy
- Format: uncompressed MuseScore 3 (`.mscx`)
- Licence: **CC BY-SA 4.0** for most corpora; **CC BY-NC-SA 4.0** for the ABC (Beethoven string quartets) — the NonCommercial restriction must be flagged in an ADR before public API launch
- MEI pipeline: MuseScore → MusicXML via `mscore` CLI → MEI via Verovio CLI (two hops)
- Advantage: scores and expert harmonic annotations are co-located in the same repository and derived from the same files

**3. KernScores / music21 built-in corpus** — fallback only

- KernScores: ~108,000 files in Humdrum `**kern` format; licensing is heterogeneous and partly restricted; requires two-hop conversion (`**kern` → MusicXML → MEI)
- music21 corpus: incomplete holdings, mixed licensing, not appropriate as a primary archival source
- Use only for repertoire not available through OpenScore or DCML, on a case-by-case basis with explicit licence verification

---

## Analysis Sources

Expert harmonic annotations are preferred over music21 auto-analysis wherever they exist. Provenance is tracked at the **event level** on each row of `movement_analysis.events` via a `source` field (`"DCML"`, `"WhenInRome"`, `"music21_auto"`, or `"manual"`). Fragment `summary` JSONB does not carry a top-level `harmony_source`; harmonic data lives in `movement_analysis` and is sliced by bar/beat at read time. See `docs/architecture/fragment-schema.md` § "Harmonic analysis: movement-level single source of truth".

| Source | Format | Notation standard | Coverage |
|---|---|---|---|
| **DCML TSV** | Tab-separated values (`harmonies.tsv` per movement) | DCML harmony annotation standard | Corpora published by DCMLab |
| **When in Rome** | RomanText (`.txt`), parseable by music21 | RomanText | ~2,000 analyses of ~1,500 works, aggregated from DCML and other sources |
| **music21 auto** | Programmatic output | Standard Roman numerals | Any score parseable by music21 |
| **Manual** | Entered via tagging tool | Project-internal | Any fragment |

### Priority order

**1. DCML `harmonies.tsv`** — use directly for any movement in a DCML corpus

- One row per harmony label, with onset, measure number, beat, key context, Roman numeral, inversion, chord extensions, suspensions, and phrase boundary markers (`{` / `}`)
- Phrase markers provide candidate fragment boundaries, reducing the annotator's task to confirmation and concept tagging rather than hunting from a blank score
- Maps directly to `movement_analysis.events` rows (one event per harmony label) without an intermediate text-parsing step
- Each ingested event carries `source: "DCML"`, `auto: false`, `reviewed: false`

**2. When in Rome** — use for repertoire not in DCML but covered by the When in Rome meta-corpus

- Aggregates DCML analyses (already converted), TAVERN, BPS-FH, Tymoczko/TAOM analyses, and new analyses by Gotham and colleagues
- For DCML-origin corpora, prefer the DCML TSV directly (same data, fewer conversion steps)
- For non-DCML works (Monteverdi madrigals, Bach chorales, Haydn Op. 20 quartets, Schubert song cycles, etc.), When in Rome may be the only structured expert source
- Requires parsing via music21's `romanText` module and normalisation to the `movement_analysis.events` event shape
- Each ingested event carries `source: "WhenInRome"`, `auto: false`, `reviewed: false`

**3. music21 auto-analysis** — fallback for movements with no expert annotation coverage

- Probabilistic; reliability is medium for Roman numerals, high for key and meter
- All auto-generated events carry `auto: true` and `source: "music21_auto"`, and are flagged in the tagging UI as requiring annotator review before fragment approval

**4. Manual** — any event corrected, inserted, or replaced by a human annotator through the tagging tool

- Edits write back into `movement_analysis.events` directly; the affected event's `source` is set to `"manual"`, `auto` to `false`, and `reviewed` to `true`

### Per-event `source` field

Every row in `movement_analysis.events` carries a `source` value (`"DCML"`, `"WhenInRome"`, `"music21_auto"`, or `"manual"`). This field governs display in the tagging UI (authoritative vs. review-required), supports quality filtering in corpus queries, and identifies which events need reprocessing when upstream annotation sources are updated. Because events are per-beat, a single movement can mix provenances (e.g. most events `"DCML"`, a handful `"manual"` after tagging-time correction).

```json
{
  "mc": 4,
  "mn": 3,
  "volta": null,
  "beat": 1.0,
  "local_key": "A major",
  "root": 2,
  "quality": "minor",
  "inversion": 1,
  "numeral": "ii6",
  "root_accidental": null,
  "applied_to": null,
  "extensions": [],
  "bass_pitch": null,
  "soprano_pitch": null,
  "source": "DCML",
  "auto": false,
  "reviewed": false
}
```

---

## DCML Notation Normalisation

Both DCML TSV and When in Rome analyses use notation conventions that differ in detail from each other and from the fragment JSON schema. A normalisation script is required before either source can populate the `harmony` array. Key mappings:

- DCML extended chord syntax: `V7(9)` → `{ numeral: "V7", extensions: ["9"] }`
- Secondary functions: `V/V` → `{ numeral: "V", applied_to: "V" }`
- Phrase markers: `{` / `}` in the DCML harmonies layer → candidate `bar_start` / `bar_end` for fragment records (passed to annotator as pre-suggestions, not committed automatically)
- Flat/sharp prefix on numerals: `bVII`, `#IV` → `{ numeral: "VII", root_accidental: "flat" }`, `{ numeral: "IV", root_accidental: "sharp" }`. The prefix is an observed notational fact — whether the chord is analytically "borrowed from the parallel mode" is a downstream interpretation that requires tonal context and is not encoded at ingestion time. Chords like minor iv in a major context are borrowed without carrying any prefix, and that label belongs in the knowledge graph, not the event store.
- `bass_pitch` and `soprano_pitch` are not present in DCML TSV files. These fields are always `null` for DCML-sourced events. They may be populated by a later music21 top-up pass without changing `source`.

The normalisation script must be validated against at least one complete movement before corpus-wide ingestion. The Mozart piano sonatas are the natural first test case.

---

## First Case: Mozart Piano Sonatas

### Scores

**Source: DCML `mozart_piano_sonatas` repository**

- All 18 sonatas, complete movements, in uncompressed MuseScore 3 (`.mscx`)
- Licence: CC BY-SA 4.0
- Not available in OpenScore (outside its collection scope)

**Ingestion pipeline:**

```
DCML mozart_piano_sonatas
  └── MS3/*.mscx
        → mscore CLI (MuseScore 3.6.2)
        → .mxl
        → Verovio CLI
        → .mei  →  object storage (R2)
```

Measure-number fidelity must be verified at both conversion steps before any tagging begins. The standard MEI validation suite (well-formed XML, measure `@n` integrity, staff count consistency) runs on every output `.mei` file.

### Analysis

**Source: DCML `mozart_piano_sonatas` — `harmonies/*.tsv`**

The When in Rome repository includes Mozart sonata analyses, but these are explicitly converted from the same DCML source. The DCML TSVs are preferred because:

- They are the upstream source — no intermediate format conversion or information loss
- The tabular structure maps directly to the fragment `harmony` array
- Phrase boundary markers (`{` / `}`) are preserved in their original structured form

**Analysis ingestion pipeline:**

```
DCML mozart_piano_sonatas
  └── harmonies/*.tsv
        → normalisation script
        → movement_analysis.events  (one row per harmony label; source: "DCML")
```

### Licence note (for ADR)

The CC BY-SA 4.0 licence on the DCML Mozart corpus means any published derivative of the annotations — including the fragment database and its API — must carry the same licence or a compatible one. This applies to the annotation data; it does not restrict the knowledge graph or prose annotations authored by the project. An ADR recording this constraint must be written before the public read-only API launches.
