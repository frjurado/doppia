# Untranslated Surfaces After Step 19b — Analysis for Step 19c

**Date:** 2026-09-07
**Status:** Analysis; **C1–C4 all implemented 2026-09-07**. The causes and the
symptom map below are kept as written — they are the record of what was wrong —
with what landed noted per section. Two further items (§ D1, § D2) were found
while testing the Spanish path and need slots of their own.
**Supersedes the coverage claim in:** [`i18n-surface-inventory.md`](i18n-surface-inventory.md) § A
**See also:** [`../../adr/ADR-006-internationalisation-strategy.md`](../../adr/ADR-006-internationalisation-strategy.md)

---

## Why this exists

Step 19b seeded Spanish content and Step 19's inventory said the interface was
already complete, so the expectation was that Spanish would appear everywhere.
It appears in one place: the tagging tool's concept picker and property form.
Francisco listed the surfaces where it does not, and each one has a different
cause.

**The Step 19 inventory was wrong about § A, and wrong in a specific way worth
recording.** Its scan looked only at `.tsx` files, only at JSX text nodes and
four literal attributes, and only at capitalised text. It therefore could not
see: strings in `.ts` utilities, template literals, single-character labels, and
lowercase text. It also never asked *which endpoints apply the overlay*, which
is where most of the real gap turned out to be. "UI chrome is done, the gap is
data" was a conclusion drawn from a scan that could not have found the
counter-evidence.

---

## The three causes

### Cause A — endpoints that never accept a language

`Depends(get_language)` appears on **4 of 55** endpoints, all in
`api/routes/concepts.py` (the editorial concept API). Every other route module
ignores language entirely, including every route a reader touches.

| Route module | Endpoints | Honour `language` |
|---|---:|---:|
| `concepts` (editorial) | 4 | **4** |
| `public_concepts` | 3 | 0 |
| `fragments` | 8 | 0 |
| `public` | 2 | 0 |
| `browse`, `movements`, `reviews`, `admin`, `auth`, `users`, `corpora`, `health` | 38 | 0 |

The frontend is not at fault: `apiFetch` already sends `Accept-Language` from
the active UI language on every call, and the backend's negotiation handles it.
The header simply arrives at routes that never read it.

Two service methods are documented as English-only by an earlier decision —
`get_public_detail` and `get_public_index` both say *"English-only: the public
glossary carries no translation overlay in Phase 2 (i18n is deferred to Track M
/ Component 12)"*. That deferral was to **this** component.

### Cause B — fields never overlaid, even on translated endpoints

`hierarchy_path` is taken straight from Neo4j in every one of its six
assembly sites, including inside `search` and `_get_tree_structure`, which
overlay `name` and `aliases` two lines earlier.

It is not an oversight that can be fixed in the service alone: the Cypher
returns *names*, not ids —
`RETURN [n IN reverse(nodes(p)) | n.name] AS hierarchy_path`, in three
queries — so there is no key to look a translation up by. The queries must
return ids alongside.

Fragment payloads have the same shape of problem at four hydration sites in
`FragmentService` — `get`, `list_for_movement`, `list_for_review`,
`_hydrate_browse_items` — each calling `get_concepts_by_ids` and using the raw
Neo4j `name` and `aliases[0]`. This is why the alias reads "PAC" everywhere
except the concept picker: the picker asks the editorial concept API (which
overlays), while every stored fragment carries an alias hydrated straight from
the graph.

### Cause C — hardcoded strings the first scan could not see

| Location | String | Why the scan missed it |
|---|---|---|
| `utils/fragmentRange.ts` | `m.`, `mm.`, `beat`, `beats` | `.ts` file, template literals |
| `components/score/FragmentNotation.tsx:80` | `{35:'S', 45:'M', 55:'L'}` | bare object literal, 1-char values |
| `components/score/FragmentOverlay.tsx:217` | `` `Part ${index + 1}` `` | template literal |
| `components/score/FragmentDetailPanel.tsx:186` | `` `m.${e.mn} b${beat}` `` | template literal |
| `components/score/HarmonyPanel.tsx` | `` `root ${acc}${e.root}` ``, `` `b${beat}` `` | template literal |
| `routes/spike/HorizontalRenderSpike.tsx:239` | `placeholder="UUID of a movement"` | dev-only route (already known) |

`fragmentRange.ts` is the widest-reaching: it renders the range on every
fragment card, every detail panel and every stage row.

---

## Symptom → cause

| Francisco's report | Cause | Where |
|---|---|---|
| `/fragments` concept tree untranslated | A | `get_public_index` — the default path uses the public index even for editors; only `?root` uses the translated tree |
| `/fragments` fragment items untranslated | A + B | `_hydrate_browse_items` |
| `/fragments/<id>` concept & hierarchy | A + B | `ConceptTagDetail.name` / `.hierarchy_path` via `FragmentService.get` |
| `/fragments/<id>` stage names | A + B | sub-part concept names, same hydration |
| `/fragments/<id>` measure/beat | C | `fragmentRange.ts` |
| `/fragments/<id>` S/M/L | C | `FragmentNotation.tsx:80` |
| Aliases English outside the tagging tool | B | fragment hydration uses raw `aliases[0]` |
| Tagging tool hierarchy English | B | `hierarchy_path` never overlaid |
| Glossary untranslated | A | `get_public_detail` / `get_public_index` |

---

## Proposed Step 19c

Ordered so each piece is independently shippable and testable.

**C1 — frontend strings (smallest, no API change). ✅ Done.**
The six sites now go through `t()`. `fragmentRange.ts` takes an optional
`RangeLabels`, defaulting to English so no call site had to change to keep
working — injection matching what that file already did for volta prose.
Spanish: `c.`/`cc.` for compás/compases, `tiempo`/`tiempos`, `P`/`M`/`G` for
the size control.

Two things the list above had wrong. `formatBarRange` is a **second** hardcoded
formatter, used by the browse cards and glossary captions — easy to miss when
converting the detail one. And the harmony vocabulary is bigger than two
labels: `QUALITY_DISPLAY` and `INVERSION_DISPLAY` sit inside the same strings
as `root` and `ext`, and their Spanish forms are neither translations of the
English words nor derivable from them ("dim" → "dism", "1st inv" → "1ª inv"),
so the whole cluster is keyed rather than half of it.

**C2 — public glossary honours language. ✅ Done.**
`get_language` on the three `public_concepts` routes, threaded through
`get_public_detail` and `get_public_index`. The detail page batches one overlay
read for every concept it names — itself, its ancestors, its parent, its
children, every relationship target — so a page cannot come back half
translated. Both "English-only" docstrings are gone, and
`ConceptDetailResponse` gained `translation_missing` like its siblings.

It also surfaced a bug the analysis had not predicted: **overlaying a list
breaks its ordering.** The Cypher sorts by the *English* name, so the Spanish
forest came back Abandonada, Auténtica, (Realizada), Cadencia, Rota — a list
documented as alphabetical, in an alphabet the reader is not seeing. The public
index and the editorial tree now re-sort on the translated name, accent-folded
so "Época" does not file after "Zarzuela".

**C3 — `hierarchy_path` becomes translatable. ✅ Done.**
**Four** Cypher queries, not three — the concept-detail query carries its own
copy of the subquery. Each now returns `hierarchy_path_ids` alongside the
names, and `_localise_hierarchy_path` overlays element by element, falling back
per element rather than per path: the cadence hierarchy mixes translated
concepts with stubs, so a path-level fallback would show English for paths that
are almost entirely translated.

**C4 — fragment payloads carry translated concept text. ✅ Done.**
`language` on the `fragments`, `public`, `reviews` and `movements` routes plus
glossary examples; the four hydration sites now share one `_localised_concepts`
helper rather than each reading the raw graph values inline. Aliases read "CAP"
everywhere, and stage names, breadcrumbs and bracket labels are Spanish on every
fragment surface.

**Not proposed:** annotation prose (deferred by decision, § E.5 of the
inventory), and group labels (§ C.2, deferred with its strategy settled).

### Sizing

C1 is an afternoon. C2 and C3 are each a focused change with clear seams. C4 is
the largest — four hydration sites, three route modules — but mechanical once
C3 has established the overlay-by-id pattern. None of them is architecturally
risky: the overlay, the negotiation and the fallback all exist and are tested;
what is missing is that they were never wired to these callers.

## Found during 19c, out of its scope — needing a slot

Neither is overlay wiring, which is what 19c is. Both were found by testing the
Spanish path rather than by the original analysis, and both leave the Spanish
experience incomplete in a way a reader or tagger will hit.

### D1 — Property schema and value labels are raw ids on the public path

A public reader sees `Stage2SD4` where an editor sees "Sobre el Grado 4".

Not a regression and not an i18n bug: `FragmentDetail` passes
`disableSchemaFetch={isPublic}` because `getConceptSchemas` is editor-only, and
the prop's own docstring calls this "an acceptable degradation on the public
surface **until a public concept endpoint exists**". A public *concept* endpoint
now exists (Step 19c), but it returns concept detail, not property schemas.

**Needs:** a public property-schemas endpoint — read-only, anonymous,
rate-limited like its siblings — plus removing the `disableSchemaFetch` branch.
The service method already exists and already takes a language; what is missing
is a public route and its auth/rate-limit treatment.

**Slot: Component 13** (Francisco, 2026-09-08). Public-reading-path work,
which is that component's subject, and small. Nothing in Component 12 depends
on it.

### D2 — Concept search matches English only

Typing "cadencia" into the tagging tool's concept picker returns nothing. The
Neo4j full-text index is `FOR (c:Concept) ON EACH [c.name, c.aliases]`, and
those properties are English; Spanish lives in PostgreSQL.

This is the sharper of the two. A label in the wrong language is read past; a
search that returns nothing stops the work. It affects the **editorial** path,
so it is not Component 13's subject.

**Needs a decision before it needs code**, because the options differ in kind:

| | Cost | Trade-off |
|---|---|---|
| (a) Write translated names onto Concept nodes (`name_es`) and index them | Seed + index change | Puts translated text in two stores; the overlay stops being the single source |
| (b) Search `concept_translation` in PostgreSQL for non-English locales | New query path, two ranking implementations | Keeps one source of truth; ranking will not match the Neo4j scorer, so results differ subtly by language |
| (c) Search both and merge | Highest | Best recall; most moving parts |

**Slot: the last step of Component 12** (Francisco, 2026-09-08) — Step 21,
after the meter-rule work. Not folded into a wiring step: whichever option wins
changes where translated text is allowed to live, which is an ADR-006 question
and wants an ADR.

**Resolved 2026-09-11 — (c), search both and merge.** Recorded as
[`../../adr/ADR-040-cross-language-concept-search.md`](../../adr/ADR-040-cross-language-concept-search.md)
and implemented in Step 21.

The cost column above overstated (c) and understated nothing. The Lucene score
is the *third* sort key, behind complexity band and prerequisite depth, so
merging never required two rankers reconciled — union the ids and apply the one
graph-side ordering. What decided it was the other way round: (b) **fails
closed**. Concepts are seeded English-first and translated later, so a
locale-only search makes every newly seeded concept invisible for the length of
that window, rather than merely untranslated — the failure this section opens
by naming. A merged search degrades to "found it by its English name".

Also decided: a hit matched only on English is **not** marked as such
(Francisco) — the picker shows results in the reader's language, and how a row
was matched is not the reader's problem.

---

### The check that should have existed — deferred to C4

Every gap here shares one shape: a payload carrying concept-derived text whose
endpoint never asked for a language. That is mechanically detectable — a test
asserting that every response model with a concept-derived field is served by a
route that takes `get_language`. Worth adding with **C4** rather than now: the fragment
routes it would assert over are exactly what C4 changes, so writing it before
that means writing it red.
