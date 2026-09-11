# ADR-040 — Cross-Language Concept Search

**Status:** Accepted
**Date:** 2026-09-11
**See also:** `docs/adr/ADR-006-internationalisation-strategy.md` (§ 3 — the translation overlay this ADR must not undermine), `docs/adr/ADR-020-cadence-prerequisite-edges.md` (`PREREQUISITE_FOR`, whose depth is the sort key this reuses), `docs/reports/component-12-reports/i18n-untranslated-surfaces.md` (§ D2 — where the defect was recorded and the options first written down), `docs/roadmap/component-12-user-infrastructure.md` (§ Step 21)

---

## Context

Typing "cadencia" into the tagging tool's concept picker returns nothing.

The picker searches a Neo4j full-text index declared
`FOR (c:Concept) ON EACH [c.name, c.aliases]`. Those properties are English by
ADR-006 § 1 — the graph holds canonical English, and Spanish lives in
PostgreSQL's `concept_translation`. So a Spanish-locale tagger reads a Spanish
interface, sees Spanish concept names in every list Component 12 Step 19c
reached, and then cannot find any of them by typing what they see.

This is the sharpest of the gaps that survived 19c, and sharper in kind than the
ones it closed. A label in the wrong language is read past. A search that
returns nothing stops the work, and gives the user no way to tell a missing
concept from a missing translation.

**The overlay is not negotiable.** ADR-006 § 3 puts translated text in
PostgreSQL and keeps the graph English precisely so that translated content has
one home. Any fix that writes `name_es` onto the Concept nodes to get them into
the Lucene index ends that commitment: translated text would live in two stores,
with a seed pipeline and a review workflow that disagree about which is
authoritative. That option was rejected on those grounds, not on cost.

The live question was therefore narrower, and it is not a question about
mechanism: **should an English term still find its concept for a Spanish-locale
tagger?** Searching `concept_translation` alone says no — a locale searches its
own language. Searching both and merging says yes.

### Two measurements that decided it

**The Lucene score is the third sort key, not the first.** The picker's ordering (`_SEARCH_CONCEPTS`, `backend/graph/queries/concepts.py`) is

```
ORDER BY complexity_rank ASC, prereq_depth ASC, score DESC, node.name ASC
```

and the two keys that dominate it — pedagogical complexity band and prerequisite
depth — are graph properties, independent of the language the query was typed
in. The relevance score only breaks ties inside a
`(complexity_rank, prereq_depth)` bucket. This matters twice. It shrinks the
objection to a PostgreSQL-only search (its ranking would diverge from Neo4j's
only within a bucket), and, more usefully, it means merging two result sets does
**not** require reconciling two scorers: union the matched ids, then apply the
one graph-side ordering to the union. The expensive-sounding part of "search
both and merge" does not exist.

**Coverage is total today and structurally cannot stay that way.** Every concept
in the graph has a reviewed Spanish row — 34 of 34, including all 8 that carry
aliases. So a Spanish-only search would hide nothing at this instant. But
concepts are seeded English-first: a `seed:` commit adds them to the graph, and
the Spanish overlay follows in a separate pass. Every new concept therefore has
a window, of unbounded length, in which it exists in English only. A
Spanish-only search makes those concepts **unfindable** for the whole of that
window — reintroducing the exact failure this ADR exists to remove, at the exact
moment the vocabulary is growing.

That asymmetry is the decision. A merged search degrades to "found it by its
English name"; a locale-only search degrades to "no results".

---

## Decision

**Search both stores and merge, for non-English locales only.**

### 1. English is unchanged

A request whose negotiated language is English takes exactly the path it takes
today: the Neo4j full-text query, its existing ordering, its existing cursor.
No new code runs, so the common path carries no regression risk.

### 2. A non-English locale matches in both stores, and the union is the result

For a non-English locale the service runs two matches and unions the concept ids
they produce:

- the existing `concept_search` full-text query over `Concept.name` and
  `Concept.aliases`; and
- a match against `concept_translation` rows for that language, over `name` and
  `aliases`.

A concept found by either is a result. A concept found by both appears once.

### 3. The union is ordered by the existing key, with the translated name last

The merged id set is ordered by the key the picker already uses —
`complexity_rank ASC`, then `prereq_depth ASC` (the count of distinct
`PREREQUISITE_FOR` ancestors, ADR-020) — and then by the **translated** name,
accent-folded, ascending.

The relevance score is dropped from the merged path rather than approximated.
Two scores from two engines over two languages are not comparable, and inventing
a blend would be a fiction with a number attached; the two keys that actually
determine the order are graph properties that both paths share. Within a
`(complexity_rank, prereq_depth)` bucket the merged path is therefore ordered
alphabetically in the reader's own alphabet, which is a rule that can be stated
to a user, unlike a blended score.

This also corrects a defect rather than only adding a feature: `search` was the
one surface Step 19c overlaid without re-sorting, so Spanish results were until
now tie-broken on the **English** name. The accent-folded translated-name sort
is the same one `get_public_index` and `_get_tree_structure` already use.

### 4. Nothing is written to Neo4j

`concept_translation` remains the single source of translated text. The graph
keeps English. ADR-006 § 3 is untouched, which is the constraint that ruled out
the alternative of indexing translated names on the nodes.

### 5. A result matched only on English is not marked as such

The picker shows results in the reader's language, with no badge, footnote or
ordering penalty distinguishing how a row was matched (Francisco, 2026-09-11).
The user typed an English term and got a Spanish label; nothing about that needs
explaining, and a "matched in English" marker would draw attention to an
implementation detail at the moment the user is trying to choose a concept.

### 6. Merged pagination slices in the service, with a stated ceiling

The existing cursor is a `SKIP` offset pushed into Cypher. That cannot survive a
union — an offset into one store's results names nothing in the merged order —
so on the merged path the service collects the full match set, orders it, and
slices. The cursor stays an opaque offset into the merged order, so the API
contract does not change.

This is honest at the present size (34 concepts, of which 10 are searchable) and
it is not a general solution. **The ceiling is the searchable-concept count, and
the threshold to revisit at is roughly 2,000**: below it, fetching every match
costs a single indexed read per store and a sort of a few hundred rows; above
it, a keyset cursor over a materialised merged ordering is the replacement. The
number is recorded so the decision to revisit is triggered by a measurement
rather than by someone's unease.

---

## Consequences

### Positive

- The reported defect is gone: "cadencia" finds Cadencia, and so does "cadence".
- Recall never depends on translation coverage. A concept seeded today is
  findable today, in either language, before anyone has translated it.
- No new place for translated text to live; ADR-006's single-source commitment
  survives intact.
- The merged path is ordered alphabetically in the reader's alphabet within each
  pedagogical band — a rule that can be explained, where a cross-engine score
  blend could not.
- The 19c re-sort omission in `search` is fixed on the way.

### Negative

- Two matches per non-English query instead of one. At this scale both are
  indexed reads and the cost is not measurable; at a larger scale § 6's ceiling
  applies before this does.
- Relevance ranking is weaker on the merged path than on the English one, since
  the score is dropped. This is a real difference between locales, accepted
  because the score was only ever a third-order tie-break.
- The merged path holds the whole match set in memory to sort it. Bounded by
  § 6's ceiling and explicitly not a general design.
- A Spanish tagger can be shown a concept they matched by an English term they
  may not have meant. The alternative — hiding it — is what this ADR rejects.

### Neutral

- `concept_translation` needs an index supporting the match. The table is keyed
  `(concept_id, language)` and carries a `language` index; the match adds a
  text-search index over `name` and `aliases` per language.
- The behaviour is per-locale, so adding a third language adds no new decision:
  it inherits § 2 automatically.

---

## Alternatives considered

**Write translated names onto the Concept nodes (`name_es`) and index them.**
Rejected on principle rather than cost. It would put translated text in two
stores and end the overlay's role as the single source of truth — an ADR-006 § 3
commitment — and would give the seed pipeline and the translation review
workflow two disagreeing authorities over the same string. The cost is
genuinely the lowest of the three; that is not enough.

**Search `concept_translation` alone for non-English locales.** The cleanest
rule to state — a locale searches its own language — and the reason it loses is
in § Context: it fails closed. Any concept without a row in the requested
language becomes invisible rather than merely untranslated, and English-first
seeding guarantees a supply of exactly those concepts. A tagger cannot
distinguish "this concept does not exist" from "nobody has translated it yet",
which is the failure mode the ADR set out to remove.

**Blend the two relevance scores.** Considered and dropped in favour of § 3's
alphabetical tie-break. Lucene scores and PostgreSQL text-match ranks are not on
a common scale, and any mapping between them would be arbitrary while looking
principled. Since the score only orders within a `(complexity_rank,
prereq_depth)` bucket, the blend would buy an unexplainable order in place of an
explainable one.
