# i18n Surface Inventory (Component 12, Step 19 — M13)

**Date:** 2026-09-06
**Status:** Inventory complete; decisions taken 2026-09-06 (Francisco) and
recorded in § E. **Step 19b delivered them** the same day — §§ B, C.1 and C.3
are closed; § C.2 and the annotation-prose policy remain open by decision.
**See also:** [`../../adr/ADR-006-internationalisation-strategy.md`](../../adr/ADR-006-internationalisation-strategy.md),
[`../../adr/ADR-039-property-value-labelling.md`](../../adr/ADR-039-property-value-labelling.md),
[`../../roadmap/component-12-user-infrastructure.md`](../../roadmap/component-12-user-infrastructure.md)

---

## The headline

**UI chrome is done. The data layer is English-only.**

Every user-facing string written into a component goes through `t()`. A scan of
all `.tsx` under `src/` (excluding tests) for JSX text nodes and literal
`aria-label` / `placeholder` / `title` / `alt` attributes returned exactly one
real hit, in a dev-only route. The 12 namespaces carry 519 keys in both `en` and
`es`, and CI enforces key parity.

The untranslated surfaces are therefore **not** in the frontend. They are the
editorial content coming out of the databases: concept names and definitions,
property schema and value labels, and annotator prose. The ADR-006 machinery for
that content exists — four tables, a `machine`/`reviewed`/`authoritative` status
ladder, `source_hash` for staleness — and holds **zero Spanish rows**.

So a reader who switches to Spanish today gets a fully Spanish interface wrapped
around entirely English musical content. That is the single fact that should
drive the decision session.

> **No longer true as of Step 19b (2026-09-06).** The concept, schema and value
> tables now carry Spanish — 34, 13 and 22 rows, `status: reviewed`. The one
> table still English-only is `fragment_annotation_translation`, which § E.5
> deliberately deferred.

---

## A. UI chrome — complete

| Namespace | Keys | Notes |
|---|---:|---|
| `score` | 224 | Tagging surface; the largest by far |
| `public` | 59 | Public reading path |
| `auth` | 56 | Added by this component |
| `admin` | 33 | Added by this component |
| `common` | 30 | |
| `profile` | 28 | Added by this component |
| `fragments` | 24 | |
| `nav` | 23 | |
| `browse` | 17 | |
| `landing` | 12 | Added by Step 14b |
| `review` | 11 | |
| `errors` | 2 | See § C.1 — thin for a reason worth checking |
| **Total** | **519** | `en` + `es`, parity enforced in CI |

**One loose end:** `src/routes/spike/HorizontalRenderSpike.tsx:239` has a literal
`placeholder="UUID of a movement"`. A development spike route, not on any user
path. Trivial to fix or to delete along with the spike.

---

## B. Editorial content — the actual gap

All four tables exist and are wired. **Three now carry Spanish** (Step 19b);
the fourth is deferred by decision.

| Table | Translatable columns | `en` | `es` | Status |
|---|---|---:|---:|---|
| `concept_translation` | `name`, `aliases`, `definition` | 34 | 34 | ✅ `reviewed` |
| `property_schema_translation` | `name`, `description` | 13 | 13 | ✅ `reviewed` |
| `property_value_translation` | `name`, `short_name`, `description` | 22 | 22 | ✅ `reviewed` |
| `fragment_annotation_translation` | `prose_annotation` | 2 | 0 | ⏸ deferred (§ E.5) |

Populating Spanish rows was **data entry against existing machinery**, not
engineering — it needed one new seed file (`backend/seed/translations/es.yaml`)
and a loader, which is exactly what ADR-006 anticipated when it said adding a
language is "a data migration and a seed file, not a code change".

Note the asymmetry in volume. 34 concepts and 13 schemas are a bounded,
tractable editorial task. `fragment_annotation_translation` is unbounded — it
grows with every annotated fragment — and is the one genuinely open-ended
commitment here.

---

## C. Structural gaps — fields no table can carry

These need a schema change before any translation can be entered, so they are
engineering work, however small.

### C.1 Property value `short_name` and `description`

`property_value_translation` carries `name` only. ADR-039 added `short_name` and
`description` to `PropertyValue` in Step 15 and recorded them as deliberately
untranslated for now. A Spanish tagger reads "On Scale Degree 4" and
"IV, ii, ii6, …" in English.

**Cost:** two nullable columns plus the overlay read path. Small.
**Urgency:** rises the moment § B is populated — it would be the only English
text left inside an otherwise Spanish property form, which reads as a bug rather
than as untranslated content.

> **Closed in Step 19b.** Migration `0015` adds both columns; the overlay reads
> them and falls back **per field**, so a row that localises only the name keeps
> the English short form rather than blanking it. ADR-039 § 4 marked superseded.

### C.2 Property schema **group** labels

`closure` and `other` (Step 16) are free-form strings on the
`HAS_PROPERTY_SCHEMA` edge, rendered verbatim and uppercased in CSS. There is no
translation table for them and no id to key one on — the label *is* the value.

**Cost:** larger than it looks. Either promote group labels to keyed entities
with their own translations, or treat them as i18n keys resolved client-side and
accept that the seed then carries keys rather than labels.
**Urgency:** low — two labels, both short. But it is a design decision, not a
data-entry task, so it wants deciding before more groups are added.

### C.3 Backend error messages

The error envelope's `message` is written in English at the raise site
(`backend/models/errors.py` and callers). The `errors` namespace has only 2 keys
because the frontend surfaces the server's prose rather than mapping `code` to a
local string.

**Cost:** medium. The clean fix is for the frontend to translate on `code` and
treat `message` as a developer-facing detail; that means an `errors` namespace
entry per code and a decision about what to show for unmapped codes.
**Urgency:** medium. Any real error puts English in front of a Spanish reader,
and errors are exactly when clarity matters most.

> **Closed in Step 19b.** `apiErrorMessage` translates on `code`, with all 47
> codes in both locales. The message is not simply discarded: codes whose text
> carries specifics an editor needs — which sub-part fell outside its parent —
> interpolate `{{message}}`, so the translated frame wraps the English detail.
> An unmapped code degrades to the fallback rather than rendering the raw key,
> which is what i18next returns for a missing string.

---

## D. Not translatable, by nature

Recorded so they are not mistaken for gaps: composer names, work and movement
titles, and other corpus metadata are proper nouns from the source editions.
Concept **ids** are join keys and immutable by invariant — never user-visible,
never translated.

---

## E. Decisions (Francisco, 2026-09-06)

The five questions below were put as a suggested order for the decision
session. All five are now answered. **Scheduled work becomes Step 19b**, taken
before Step 20.

### 1. The ambition — **Spanish is a real second language**

Content translation is in scope, not just the interface. Everything else
follows from this, and it settles the framing the headline warned about: the
current state (Spanish UI, English corpus) is a gap to close, not the intended
product.

### 2. § B + § C.1 — **do now, in Step 19b**

Populate the four translation tables with Spanish rows, and add `short_name`
and `description` to `property_value_translation` so the property form can be
fully Spanish rather than nearly so.

### 3. § C.3 backend error messages — **do now, in Step 19b**

Agreed as soon as possible, before Step 20. The frontend should translate on
`code` and treat the server's `message` as developer-facing detail.

### 4. § C.2 group labels — **deferred, but the strategy is decided**

Implementation waits, since two short labels do not justify the mechanism yet.
The approach is settled now while the investigation is fresh, so whoever picks
it up is not re-deciding from cold: **promote group labels to keyed entities
with their own translations**, rather than treating them as client-side i18n
keys carried in the seed.

Francisco's reasoning, and the reason to prefer it: keys in the seed put
display strings in two places and make the YAML depend on a frontend
translation file. Keyed entities keep the seed authoritative and reuse the
overlay pattern the other three tables already use. The cost is a table and an
id; the trigger to build it is the third group label.

### 5. `fragment_annotation_translation` — **policy first, implementation deferred**

The only unbounded commitment on the list, and it will grow: annotations are
being written in English today, but Spanish ones are expected, and having them
translated is desirable.

**Working assumption: machine translation**, with the existing
`machine`/`reviewed`/`authoritative` ladder carrying the provenance — which is
what that ladder was designed for. Deliberately *not* closed as a design:
Francisco's read is that this is medium-to-large, so it wants its own scoping
pass rather than a decision made in passing. Not part of Step 19b.

**What this leaves open, to be settled when it is scoped:** whether translation
runs at write time or in a batch; which provider, and whether musical
terminology needs a glossary to avoid mistranslating analytical vocabulary;
whether an annotator can opt out per fragment; and what a reader sees while a
translation is pending or has gone stale against `source_hash`.
