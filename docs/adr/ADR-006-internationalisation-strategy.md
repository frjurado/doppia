# ADR-006 — Internationalisation Strategy

**Status:** Accepted  
**Date:** 2026-04-12

---

## Context

The system contains four distinct categories of translatable content, each with different authorship patterns and update lifecycles:

**UI strings.** Labels, navigation, error messages, and button text rendered by the frontend. Standard fare for any web application.

**Structured knowledge content.** Concept nodes in Neo4j carry `name`, `aliases`, and `definition` fields that are language-specific. PropertySchema and PropertyValue nodes carry `name` and `description` fields. The graph *structure* — the edges, the ontology, the relationship vocabulary — is entirely language-agnostic, and the `id` field (PascalCase, no spaces) was designed as such from the start.

**Long-form prose.** Fragment prose annotations and blog posts are expert-authored natural-language content. They are not computed from structured data and cannot be translated mechanically without editorial review.

**AI-generated responses (Phase 3).** If a Phase 3 reasoning layer is built, it will produce natural-language explanations referencing concept names, fragment features, and theoretical relationships. This content is generated on demand and cannot be pre-translated.

Each category requires a different strategy, but they share a common requirement: English must be the canonical language, concept `id` values must remain language-agnostic, and the system must degrade gracefully when a translation is absent rather than failing or returning empty strings.

A further complication specific to this domain: music theory pedagogy is not terminologically uniform across linguistic traditions. German Funktionstheorie, French solfège-based pedagogy, and English Roman numeral analysis describe overlapping phenomena with different vocabulary and conceptual emphasis. Translating concept *names* is usually straightforward; translating concept *definitions* faithfully may require cultural adaptation, not word-for-word rendering. The translation infrastructure must accommodate this distinction.

---

## Decisions

### 1. English as canonical; language-agnostic IDs everywhere

English is the language of record for all concept definitions, fragment annotations, and blog posts. Concept `id` values (`PerfectAuthenticCadence`, `DescendingFifthSequence`, etc.) are and must remain language-agnostic PascalCase identifiers. This is already the convention; this ADR makes it a documented invariant.

No language-specific text may appear in an `id` field at any layer of the system. The `name` field is a localised label that can change; the `id` is a permanent key that cannot.

### 2. UI strings: standard i18n tooling

Frontend UI strings are managed via `i18next` (or an equivalent). No string is hardcoded into a component. This is standard practice and requires no further architectural specification here.

### 3. Structured knowledge content: translation overlay in PostgreSQL, graph untouched

Translations of Neo4j concept data are stored in PostgreSQL, not in Neo4j. The graph holds English values only; a set of translation tables keyed by `id + language` carry localised content. The service layer fetches the canonical node from Neo4j, then overlays the translation for the requested locale.

```sql
CREATE TABLE concept_translation (
    concept_id    TEXT NOT NULL,       -- references Concept.id in Neo4j
    language      TEXT NOT NULL,       -- BCP 47: 'es', 'de', 'fr'
    name          TEXT NOT NULL,
    aliases       TEXT[],
    definition    TEXT,
    status        TEXT NOT NULL DEFAULT 'machine',
    source_hash   TEXT,
    translated_at TIMESTAMPTZ,
    translator_id UUID REFERENCES app_user(id),
    PRIMARY KEY (concept_id, language)
);

CREATE TABLE property_schema_translation (
    schema_id     TEXT NOT NULL,
    language      TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'machine',
    source_hash   TEXT,
    PRIMARY KEY (schema_id, language)
);

CREATE TABLE property_value_translation (
    value_id      TEXT NOT NULL,
    language      TEXT NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'machine',
    source_hash   TEXT,
    PRIMARY KEY (value_id, language)
);
```

The `source_hash` column stores a hash of the English source text at the time of translation. A background job compares current English content against stored hashes and marks translations stale when the source has changed. Without this, translated definitions silently diverge from their source over time.

**The seeding script populates English records in these tables** for every concept it seeds. English is the first entry in the translation table, not a special-cased column. This means the service layer's translation overlay logic works identically for all languages, including English.

### 4. Long-form prose: sibling records with status tracking

**Blog posts:** a translated post is a sibling record, not a column on the original. The `blog_post` table gains `language` (default `'en'`) and `source_post_id` (self-referencing foreign key, null if original). Translated posts can be editorially adapted, not just mechanically rendered.

**Fragment annotations:** translations are stored in a separate table rather than as nullable columns on `fragment`:

```sql
CREATE TABLE fragment_annotation_translation (
    fragment_id         UUID REFERENCES fragment(id),
    language            TEXT NOT NULL,
    prose_annotation    TEXT,
    status              TEXT NOT NULL DEFAULT 'machine',
    source_hash         TEXT,
    translated_at       TIMESTAMPTZ,
    translator_id       UUID REFERENCES app_user(id),
    PRIMARY KEY (fragment_id, language)
);
```

The `fragment` table itself gains a `language` column (default `'en'`) recording the language in which the original annotation was authored.

### 5. AI-generated content: prompt in the target language; serve localised concept names

AI-generated responses are not pre-translated. The user's locale is stored in their user profile and would be included in the system prompt for every reasoning request. The service layer applies the translation overlay before passing concept data to the AI, so it receives localised concept names and uses them in its response. The AI reasons over the canonical graph structure (via language-agnostic `id` values) but speaks in the user's language.

No additional architecture is required for this layer beyond consistent application of the translation overlay at the API boundary.

### 6. API contract: `Accept-Language` from Phase 1

All API endpoints that return concept data, fragment metadata, or annotation content accept a `language` parameter or honour the `Accept-Language` HTTP header from Phase 1. In Phase 1, the only valid language is `'en'`, but the overlay logic runs regardless, returning English values for all locales. Adding a new language is then a data migration and a seed file, not a code change.

**Fallback behaviour:** if a translation record is absent for the requested locale, the API returns the English value with a `translation_missing: true` flag in the response envelope. It does not return an error or an empty string. The frontend may use this flag to render a visual indicator (e.g. a faint "EN" badge), but this is a UI decision deferred to when a second language is introduced.

### 7. Translation status and staleness

Every translation record carries a `status` field with three levels:

| Status | Meaning |
|---|---|
| `machine` | Machine-generated (e.g. via AI translation); not reviewed |
| `reviewed` | Reviewed by a human translator; fit for display |
| `authoritative` | Reviewed and approved by a domain expert; reflects adaptation for the target theoretical tradition, not just word-for-word translation |

The `authoritative` level exists specifically to accommodate the cross-tradition terminology problem: a German translation of a cadence definition may need to reflect Funktionstheorie conventions rather than being a literal rendering of the English Roman numeral framing. Only translations at this level are considered fully correct for pedagogical use.

A staleness detection job runs periodically, comparing `source_hash` values against the current English content. Stale translations are downgraded to `reviewed` (if previously `authoritative`) or flagged for re-translation.

### 8. Translator role

The `editor`/`admin` role model introduced in Phase 1 is extended with a `translator` permission. Translators may edit translation records for their assigned languages but may not modify canonical English content or concept definitions. Admins promote translations from `reviewed` to `authoritative`.

This permission is implemented as a capability on the existing role system, not as a new top-level role, so it does not require changes to the authentication middleware.

---

## What Gets Built When

**Phase 1 (immediately):**
- `language` column added to `fragment`, `blog_post`, and any future prose-bearing tables; default `'en'`
- Translation tables for concept, schema, and value nodes scaffolded in PostgreSQL
- Seeding script populates English records in translation tables for every concept seeded
- Service layer applies translation overlay on all concept-returning API calls; language parameter accepted but only `'en'` is valid
- `Accept-Language` header honoured by API from first endpoint written
- `fragment_annotation_translation` table scaffolded; populated with English records when annotations are submitted

**Before launching a second language:**
- Translation editorial UI (table view of translation records with edit and status controls)
- Staleness detection job (`source_hash` comparison)
- Fallback rendering in the frontend (`translation_missing` flag handling)
- Translator permission granted to first translators
- Documentation for translators covering the `authoritative` standard and the cross-tradition terminology conventions

**Phase 3 (AI layer):**
- Student locale read from user profile and injected into AI system prompt
- Translation overlay applied before concept data is passed to the AI reasoning tools
- No additional infrastructure required

---

## Consequences

**Positive.** The graph remains purely structural and language-agnostic; adding a language never requires touching Neo4j. The service layer API contract is stable from Phase 1; no endpoint signature changes when a language is added. English is just the first language in the translation tables, not a hard-coded special case.

**Negative.** The seeding script is slightly more complex: it must write both the Neo4j concept node and the corresponding English translation record in PostgreSQL as a unit. These two writes must be treated as logically atomic (wrap in a transaction on the PostgreSQL side; the Neo4j MERGE is idempotent and can be re-run safely).

**Neutral.** All prose content in Phase 1 will be English only. The translation tables will exist but contain only English records. This is intentional: scaffolding them now costs almost nothing and avoids a schema migration when the first second-language content is introduced.

---

## Alternatives Considered

**Store translations directly on Neo4j nodes as language-keyed properties** (e.g. `name_es`, `name_de`). Rejected: it pollutes the graph schema with language concerns, makes adding a new language a graph migration rather than a data migration, and prevents querying translation status or staleness within the relational layer.

**A dedicated translation management service or third-party TMS.** Not rejected in principle, but premature. The status and staleness tracking described here covers Phase 1 and Phase 2 needs adequately. If the corpus reaches a scale where a professional TMS (e.g. Phrase, Lokalise) is warranted, the `status` and `source_hash` fields in the translation tables are the natural integration points.

**Machine-translate everything at launch and flag for review later.** Viable as a content strategy but not an architectural decision. The infrastructure described here supports this approach if chosen; it does not mandate it.
