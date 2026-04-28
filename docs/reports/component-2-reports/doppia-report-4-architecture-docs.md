# Doppia Code Review — Report 4: `docs/architecture/`

## Summary

**Scope.** This report covers the 17 documents in `docs/architecture/` (~313K total): `project-architecture.md` (the top-level overview), `tech-stack-and-database-reference.md` (database inventory and SQL schemas), `error-handling.md` (exception strategy), `security-model.md` (auth, CORS, signed URLs), `fragment-schema.md` (fragment + movement_analysis schema spec), `mei-ingest-normalization.md` (the normalizer rules and Verovio research), `corpus-and-analysis-sources.md` (provenance and licensing for ingestion), `knowledge-graph-design-reference.md` (the three-layer graph spec), `knowledge-graph-domain-map.md`, `edge-vocabulary-reference.md`, `tagging-tool-design.md`, `prototype-tagging-tool.md`, `capture_extensions.md`, `bloom-setup.md`, `extended-features.md`, and `real-audio-playback-research.md`. It evaluates: internal consistency within each doc, mutual consistency across docs, consistency with the actual code, and completeness of cross-references.

**General view.** This is the most extensive part of the documentation set and on average the highest-quality writing in the project. Each document is internally well-organized, the modelling sections (`knowledge-graph-design-reference.md`, `fragment-schema.md`, `corpus-and-analysis-sources.md`) think through edge cases that won't surface in code for months, and the research notes (`real-audio-playback-research.md`, the spike sections in `mei-ingest-normalization.md`) capture the kind of context that's normally lost. Several docs are clearly written for a future reader who'll have to make a decision without the original author present — that's exactly what architecture docs are for.

The problems concentrate in two specific kinds of drift. **First**, `error-handling.md` describes an entire typed-exception architecture (`DoppiaError`, `InfrastructureError`, `FragmentNotFoundError`, etc., a status-mapping table, repository-vs-service-vs-route rules) that **does not exist in the code at all**. It's the most thorough doc-vs-code gap in the project — and compounds the bugs already noted in Reports 1 and 2 (404 → INTERNAL_SERVER_ERROR, double-wrapped 422s). **Second**, four lower-severity drift patterns: stale file paths in code samples (e.g. `backend/api/app.py` instead of `backend/main.py`), TTL numbers in `security-model.md` that don't match any of the three different TTLs in the actual code, a Cypher query in `knowledge-graph-design-reference.md` that uses an edge type the architecture explicitly rejects, and several "Phase 2 addition" items already implemented in Phase 1.

The good news: the modelling docs (graph design, fragment schema, corpus-and-analysis-sources) are mutually consistent, and the corpus/analysis pipeline has been the most carefully kept current. ADR-009's licensing decisions, `corpus-and-analysis-sources.md`'s provenance taxonomy, and `fragment-schema.md`'s `movement_analysis` event shape all align with each other and with the actual `ingest_analysis.py` dispatch — that's a load-bearing chain and it holds.

---

## Issue 1: `error-handling.md` describes an exception architecture that doesn't exist

**[SOLVED]**

**Issue.** `docs/architecture/error-handling.md` (442 lines) is the most heavily cross-referenced architecture document — CONTRIBUTING.md links to it for "the full error propagation strategy", CLAUDE.md lists it under "Important Documentation", and `models/errors.py` itself references it as the canonical source. The document describes:

- A base `DoppiaError` exception class with a hierarchy of subclasses (`InfrastructureError`, `Neo4jUnavailableError`, `PostgresUnavailableError`, `RedisUnavailableError`, `NotFoundError`, `FragmentNotFoundError`, `ConceptNotFoundError`, `CollectionNotFoundError`, `UserNotFoundError`, `ConflictError`, `FragmentAlreadyApprovedError`, `HarmonyNotReviewedError`, `AuthorizationError`, `GraphIntegrityError`).
- Repository-layer rules: catch all driver exceptions, wrap into typed exceptions.
- Service-layer rules: raise `DoppiaError` subclasses, never `HTTPException`.
- Route-handler rules: do not catch `DoppiaError` — let exception handlers catch them.
- A status-code mapping table with codes like `GRAPH_SERVICE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `CACHE_SERVICE_UNAVAILABLE`, `COLLECTION_NOT_FOUND`, `FRAGMENT_ALREADY_APPROVED`, `HARMONY_NOT_REVIEWED`, `GRAPH_INTEGRITY_ERROR`.

**None of this exists in code.**

- `backend/errors.py` does not exist. (`grep -rn "DoppiaError\|InfrastructureError\|Neo4jUnavailableError" backend/` returns zero matches.)
- The `ErrorCode` enum in `models/errors.py` has `FRAGMENT_STATE_CONFLICT`, `UNREVIEWED_HARMONY`, `SELF_REVIEW_FORBIDDEN` — different names from the doc's mapping table.
- Code values the doc mentions (`GRAPH_SERVICE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `CACHE_SERVICE_UNAVAILABLE`, `GRAPH_INTEGRITY_ERROR`) don't exist in the enum.
- Every actual route handler in `routes/browse.py` raises `HTTPException(404, ...)` directly — exactly what the doc says **not** to do.
- There is no `backend/api/exception_handlers.py`. The handlers live in `backend/api/middleware/errors.py` and don't recognise any typed exceptions.

This is the most consequential doc-vs-code gap I've found in this project. It also explains the route-layer bypass and the 404→INTERNAL_SERVER_ERROR bug from earlier reports: the doc describes the architecture that *should* prevent those bugs, and the architecture wasn't built.

**Solution.** Two paths, each with a clear endpoint:

1. **Implement the architecture the doc describes.** Create `backend/errors.py` with the hierarchy. Update the `ErrorCode` enum to use the names from the doc's status-mapping table. Refactor `backend/api/middleware/errors.py` into typed-exception handlers. Update route handlers to raise typed exceptions. Refactor `services/ingestion.py`'s `_raise_422` to use typed exceptions instead of bare `HTTPException`. This fixes Reports 1, 2, and this Report's Issue 1 simultaneously.

2. **Demote `error-handling.md` to "Proposed: not yet implemented"** and write a much smaller current-state doc describing what's actually there: the bare `HTTPException` pattern, the middleware that wraps it, and the `ErrorResponse` envelope. Mark the typed-exception architecture as the Phase 1 target.

Recommendation: **option 1**. The implementation is one or two days of focused work, fixes multiple bugs, and brings the codebase into alignment with what every contributor reads in CONTRIBUTING.md. Option 2 is the smaller change but leaves the existing bugs in place.

**Verification.**

- After option 1: every reference to a typed exception in `error-handling.md` resolves to a class in `backend/errors.py`. Every status code in the mapping table exists in `ErrorCode`. Every route-handler error path uses typed exceptions. Integration tests assert on response shape (`code`, `message`, `detail`).
- After option 2: doc opens with a "Status: Proposed" header and a sentence pointing to the current implementation.

---

## Issue 2: Stale file paths in `security-model.md` code samples

**[SOLVED]**

**Issue.** Two places in `security-model.md` cite file paths that don't exist:

- Line 35: `# backend/api/app.py` — the actual application factory is in `backend/main.py`.
- Line 390: `# backend/middleware/auth.py` — the actual file is `backend/api/middleware/auth.py`.

A new contributor following the document to find the cited code will get a `find: backend/api/app.py: No such file or directory`.

**Solution.** Update the path comments to match the real file locations. Add a CI lint that walks every code-block comment of the form `# backend/...` and verifies the path exists.

**Verification.** `grep -rn "backend/api/app.py\|backend/middleware/auth.py" docs/` returns no results.

---

## Issue 3: Signed-URL TTL numbers don't match anywhere

**[SOLVED]**

**Issue.** `security-model.md` line 305–311 has a TTL policy table:

| Access pattern | TTL |
|---|---|
| Client-facing: frontend fetching MEI for rendering | **1 hour** (3600s) |
| Client-facing: fragment SVG preview images | **1 hour** (3600s) |
| Backend-to-backend: music21 processing | **15 minutes** (900s) |
| Backend-to-backend: Verovio server-side rendering | **15 minutes** (900s) |

Actual code:

- `services/object_storage.py` line 155: `signed_url(key, expires_in=300)` — default is **5 minutes**, not 1 hour.
- `services/browse.py` line 30: `_INCIPIT_URL_TTL_SECONDS = 900` — incipits use **15 minutes**, not 1 hour. The comment cites "ADR-002" but ADR-002 doesn't actually specify a TTL; this is the doc-vs-doc gap.

So three different TTL values exist (300s, 900s, 3600s) and none of them are consistently applied. Worse, the incipit case is conceptually a "client-facing fragment SVG preview" per the doc's table — which would mandate 1 hour — but the code uses 15 minutes. The signed-URL default is 5 minutes, meaning anyone calling `storage.signed_url(key)` without an explicit `expires_in` gets the wrong number per the doc.

**Solution.** Decide what the actual policy is and apply it consistently. The doc's reasoning ("Long enough for any reasonable rendering or playback session; short enough to limit exposure if a URL leaks") is sound for the 1-hour client-facing default. Then:

1. Change the default `expires_in` in `signed_url` from 300 to 3600 (per the doc).
2. Promote `_INCIPIT_URL_TTL_SECONDS = 900` to a module-level constant in `services/object_storage.py` — `INCIPIT_URL_TTL = 3600` (matching client-facing policy) or document why incipits get 15 minutes specifically.
3. Add a constant `BACKEND_PROCESSING_TTL = 900` for music21 / Verovio consumers.
4. Add an ADR (or extend ADR-002) documenting the TTL decisions and rationale.

**Verification.** Integration test asserting on signed-URL expiration headers/parameters; doc's TTL table matches the constants in `object_storage.py`.

---

## Issue 4: `security-model.md` AUTH bypass uses `RuntimeError` (refuse to start); code returns 401 (per request)

**[SOLVED]**

**Issue.** `security-model.md` line 405–410 specifies that misconfiguring the dev auth bypass — setting `AUTH_MODE=local` without `ENVIRONMENT=local` — should make the application **refuse to start**:

```python
if environment != "local":
    raise RuntimeError(
        "AUTH_MODE=local is set but ENVIRONMENT is not 'local'. "
        "This configuration is invalid and the application will not start. ..."
    )
```

Line 421 explicitly comments: *"the application **refuses to start** if `AUTH_MODE=local` is combined with any non-local environment. This makes the misconfiguration loud and immediately visible rather than silently dangerous."*

The actual code in `backend/api/middleware/auth.py` line 84–88 does the opposite — runs per-request, returns a 401 JSON body:

```python
if auth_mode == "local":
    if environment != "local":
        return _make_401(
            "AUTH_MODE=local is not permitted outside ENVIRONMENT=local."
        )
```

Result: the app starts up cleanly even with the misconfiguration, and every authenticated request returns 401. This is the opposite of "loud and immediately visible" — it's silent until someone actually tries to use the API. In production, this would be a midnight pager incident rather than a deploy-time abort.

The doc's design is materially safer than the code. The code's design is what got built.

**Solution.** Move the check out of the per-request dispatch and into application startup. In `main.py`'s `lifespan`:

```python
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    auth_mode = os.environ.get("AUTH_MODE", "supabase")
    environment = os.environ.get("ENVIRONMENT", "production")
    if auth_mode == "local" and environment != "local":
        raise RuntimeError(
            "AUTH_MODE=local is set but ENVIRONMENT={environment!r}. "
            "Refusing to start: dev auth bypass is only permitted in local."
        )
    # ... rest of startup ...
```

The middleware's per-request check can stay as belt-and-suspenders, but the startup check is the load-bearing one.

**Verification.** Set `AUTH_MODE=local` and `ENVIRONMENT=production` in `.env`. Before fix: app starts, requests return 401. After fix: app refuses to start with a clear error message.

---

## Issue 5: `security-model.md` lists MEI schema validation as a Phase 2 addition; it's already implemented in Phase 1

**[SOLVED]**

**Issue.** `security-model.md` line 464 (Phase 2 additions section):

> **MEI schema validation.** Upgrade the XML parse check in section 3.5 to full MEI schema validation using an RNG or XSD file. The lxml parse with `resolve_entities=False` is sufficient for Phase 1; full schema validation catches malformed MEI that would cause silent rendering errors.

But `backend/services/mei_validator.py` lines 46–73 already implements full RelaxNG schema validation against `backend/resources/mei-CMN.rng` (MEI 5.0.0 CMN profile). It runs as Check 2 of the validation pipeline and is on the upload path today via `services/ingestion.py` line 189. The "Phase 2 addition" is already done in Phase 1.

**Solution.** Move that bullet from "Phase 2 additions" to "Phase 1: implemented" or simply delete it. Add a sentence to section 3.5 confirming that full RelaxNG schema validation is in place.

**Verification.** Doc review against `services/mei_validator.py`.

---

## Issue 6: `knowledge-graph-design-reference.md` uses a Cypher pattern with an edge type the architecture rejects

**[SOLVED]**

**Issue.** `knowledge-graph-design-reference.md` line 547–557 shows this Cypher example:

```cypher
MATCH (c:Concept {id: $id})
OPTIONAL MATCH (c)<-[:APPEARS_IN]-(f:Fragment)
OPTIONAL MATCH (c)<-[:VALUE_REFERENCES]-(:PropertyValue)
              <-[:HAS_VALUE]-(:PropertySchema)
              <-[:HAS_PROPERTY_SCHEMA]-(:Concept)
              <-[:APPEARS_IN]-(f2:Fragment)
RETURN collect(distinct f) + collect(distinct f2)
```

This treats `APPEARS_IN` as a Neo4j edge from a `:Fragment` node to a `:Concept` node. But `project-architecture.md` line 53 and `tech-stack-and-database-reference.md` line 37 both explicitly reject this:

> `APPEARS_IN` (concept → fragment) is **not** stored as a Neo4j edge; it is resolved at the application layer via the PostgreSQL `fragment_concept_tag` table.

A reader following this Cypher pattern would get empty results because there are no `Fragment` nodes in Neo4j — fragments live in PostgreSQL.

**Solution.** Replace the Cypher example with the two-step pattern that's actually used (also documented in `tech-stack-and-database-reference.md` lines 60–69):

```cypher
-- Step 1 (Neo4j): expand concept to all related concept IDs.
MATCH (c:Concept {id: $id})
OPTIONAL MATCH (c)<-[:VALUE_REFERENCES]-(:PropertyValue)
              <-[:HAS_VALUE]-(:PropertySchema)
              <-[:HAS_PROPERTY_SCHEMA]-(related:Concept)
RETURN $id AS direct_id, collect(distinct related.id) AS via_property_ids
```

Then in PostgreSQL:

```sql
-- Step 2 (PostgreSQL): query fragments tagged with any of those concepts.
SELECT fragment_id FROM fragment_concept_tag
WHERE concept_id = ANY(:direct_id || :via_property_ids)
```

**Verification.** `grep -rn "APPEARS_IN" docs/` — every match should be either (a) a description of why this edge does **not** exist as a Neo4j edge, or (b) a comment in a query example explaining the cross-database resolution. No remaining matches should treat it as a valid Cypher edge.

---

## Issue 7: `mei-ingest-normalization.md` references a `normalization_status` field that doesn't exist

**[SOLVED]**

**Issue.** `mei-ingest-normalization.md` line 133 says:

> Files with warnings are stored but tagged with a `normalization_status = "warnings"` field in the `movement` metadata table; the tagging tool displays this status to annotators so they can interpret unexpected ghost behaviour in context.

The `movement` table has no `normalization_status` column. It has `normalization_warnings` (a `JSONB` column) — see `tech-stack-and-database-reference.md` line 153 and the actual migration. The tagging tool can read this JSONB to know whether warnings exist (`is null` vs not), but the doc's specification of a separate status field doesn't match.

**Solution.** Update `mei-ingest-normalization.md` line 133 to:

> Files with warnings are stored with structured warnings written to `movement.normalization_warnings` (JSONB; null when clean). The tagging tool reads this column and surfaces a status indicator to annotators when it is non-null, so they can interpret unexpected ghost behaviour in context.

**Verification.** Doc review against the migration and `services/ingestion.py`'s `_upsert_movement` function (line 491–494).

---

## Issue 8: `project-architecture.md` overview describes a music21 pipeline that's been deprioritised

**[SOLVED]**

**Issue.** `project-architecture.md` is the top-of-funnel doc — likely the first thing a new contributor reads. Its Phase 1 deliverable list (line 203–209) and the "How the Components Relate" diagram (line 146) describe music21 as the analysis pipeline. The diagram has:

```
├──► Preprocessing pipeline (music21)
│     └── Auto-extracted harmonic/structural features
```

But, as covered in Report 3 Issue 7, the actual Phase 1 implementation is **DCML-first** (see `corpus-and-analysis-sources.md` and the dispatch in `ingest_analysis.py`). music21_auto is a deferred branch (`NotImplementedError` until Component 6). DCML harmony parsing — not music21 — is what runs on MEI upload today.

**Solution.** Update the diagram and the Phase 1 deliverable list to reflect the actual analysis-source taxonomy:

```
├──► Analysis ingestion pipeline (per corpus.analysis_source)
│     ├── DCML TSV parsing (primary; Phase 1)
│     ├── When in Rome RomanText (deferred to first non-DCML corpus)
│     └── music21 auto-analysis (deferred to Component 6)
│     → movement_analysis.events
```

Add a one-paragraph note in the "Core Components → Fragment Database" section pointing at `corpus-and-analysis-sources.md` and `fragment-schema.md` § "Harmonic analysis: movement-level single source of truth" for the actual provenance and storage pattern. Currently a reader has to follow ADR-009 + the corpus doc + the fragment-schema doc to piece together what the actual pipeline looks like.

**Verification.** A new contributor reading only `project-architecture.md` should come away with a mental model that matches the analysis dispatch in `ingest_analysis.py`.

---

## Issue 9: `tech-stack-and-database-reference.md` fragment "sketch" omits load-bearing columns

**[SOLVED]**

**Issue.** `tech-stack-and-database-reference.md` line 169–191 has a "Fragment table (core schema sketch)" that lists `id`, `movement_id`, `bar_start`, `bar_end`, `summary`, and timestamps — and explicitly says the sketch is "intentionally minimal."

But the **actual** fragment table (per migration and `fragment-schema.md`) has nine more columns: `beat_start`, `beat_end`, `repeat_context`, `parent_fragment_id`, `prose_annotation`, `data_licence`, `status`, `created_by`, plus a `CHECK (status IN (...))` constraint. The doc is supposed to be the authoritative database reference — being "intentionally minimal" while pointing to `fragment-schema.md` for the rest leaves the reader uncertain what they can rely on.

**Solution.** Either:

1. **Promote the sketch to the full schema** (copy-paste from `fragment-schema.md`). Risks divergence between the two docs over time — the deliberate decision to keep them in two places suggests this trade-off was already considered.
2. **Remove the SQL sketch entirely** and replace it with a one-paragraph link to `fragment-schema.md`. Less risk of divergence, less convenient for the reader.
3. **Keep the sketch but mark its role explicitly** — e.g. *"This sketch shows the MEI-pointer columns and the JSONB summary field, the parts that distinguish fragment-table design at the database level. The full schema, including the peer-review state machine and per-fragment licence, is in `fragment-schema.md`."*

Recommendation: option 3. Less work, makes the partial coverage explicit instead of just "minimal".

**Verification.** Doc review.

---

## Issue 10: `tagging-tool-design.md` and ADR-011 both reference a missing "historical artefact" file

**[SOLVED]**

**Issue.** Already noted in Report 3 Issue 8 for ADR-011. The same dangling reference appears in `tagging-tool-design.md` line 4:

```
**Supersedes:** `docs/architecture/multi-level-tagging-draft.md`
```

The file does not exist. Two documents are pointing at it.

**Solution.** Same fix as Report 3 Issue 8: remove the supersession reference from both `tagging-tool-design.md` and ADR-011. Or restore the draft if it was deleted by mistake.

**Verification.** `grep -rn "multi-level-tagging-draft" docs/` returns nothing.

---

## Issue 11: `fragment-schema.md` mentions a migration directory that doesn't exist

**[SOLVED]**

**Issue.** Same finding as Report 1 Issue 6, surfacing again in this doc. Line 9 of `fragment-schema.md`:

> When any breaking change is made: increment `version`, write a migration script in `scripts/migrations/`, update this document, and run the migration in staging before production.

`scripts/migrations/` does not exist. Migrations live in `backend/migrations/` (Alembic). The migration step described here is **summary-JSONB version migration** (data migration of fragment.summary records), not Alembic schema migration — they're different things, but the directory specified for the data migration is also wrong.

**Solution.** Two parts:

1. Create `scripts/migrations/` with a `README.md` explaining its purpose: per-version data migrations of `fragment.summary` JSONB. Or pick a different location like `backend/data_migrations/` if the working preference is to keep all migration concerns under `backend/`.
2. Update `fragment-schema.md` line 9 to reference the chosen location.

**Verification.** A reader following the instructions can find the directory.

---

## Issue 12: `fragment-schema.md` `bass_pitch` / `soprano_pitch` perpetually null for DCML corpora

**[SOLVED]**

**Issue.** This is a code-level observation surfaced by the doc. `fragment-schema.md` line 392:

> `bass_pitch` and `soprano_pitch` are not populated for DCML-sourced events and are always `null` until a music21 top-up pass fills them in.

But the music21_auto branch is `NotImplementedError` (`ingest_analysis.py` lines 812–815). Until music21 is implemented, **DCML corpora will never get bass/soprano pitches**. A reader of `fragment-schema.md` may assume the top-up pass exists and is just not running yet; in fact, it doesn't exist at all.

**Solution.** Either:

1. Add a sentence to `fragment-schema.md` line 392: *"As of Phase 1, no music21 top-up pass exists, so for DCML-sourced events these fields remain null indefinitely. Component 6 introduces the top-up; until then, fragment querying that depends on `bass_pitch` / `soprano_pitch` should expect null on every DCML event."*
2. Implement a minimal music21 top-up pass for bass and soprano pitches (since these are the easy parts of music21's analysis output — they're directly available from the score). This decouples bass/soprano-pitch availability from the much larger Roman-numeral-analysis work that's deferred to Component 6.

Recommendation: option 1 for now, option 2 if any consumer of `bass_pitch` / `soprano_pitch` is built before Component 6.

**Verification.** Doc review; or, if option 2, a fragment query that filters on `bass_pitch IS NOT NULL` returns events.

---

## Issue 13: `security-model.md` shows a module-global cached S3 client; code uses per-call clients

**[SOLVED]**

**Issue.** `security-model.md` lines 321–333 show a code sample using a module-global cached `_S3_CLIENT`:

```python
_S3_CLIENT = None

async def get_s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        session = aioboto3.Session()
        _S3_CLIENT = await session.client(
            "s3",
            ...
        ).__aenter__()
    return _S3_CLIENT
```

This pattern has two problems independent of the doc-vs-code drift: `__aenter__()` outside an `async with` block is a resource-lifecycle smell (the corresponding `__aexit__` never runs), and the cached client is bound to whatever event loop first triggered the cache miss (the same class of bug noted in Report 2 Issue 1 for `ingest_analysis.py`).

The actual code in `services/object_storage.py` does the opposite: short-lived clients per call (`async with self._session.client("s3", ...) as s3:`). The decision is documented at line 41–43: *"Each public method opens a short-lived `aioboto3` client for the duration of the call. This is correct for Phase 1 request volumes; a persistent connection pool can be added later if latency measurements warrant it."* This is the right pattern.

But a contributor reading `security-model.md` will see the wrong pattern modeled and might copy it.

**Solution.** Replace the code sample in `security-model.md` with the actual pattern from `services/object_storage.py`. Add a note explaining why: *"Short-lived clients are correct for Phase 1 request volumes. A persistent client requires careful event-loop scoping (see `services/tasks/generate_incipit.py` for the explicit comment on this trade-off)."*

**Verification.** `grep -rn "_S3_CLIENT\|__aenter__" docs/` returns nothing. The doc's code sample uses the same `async with` pattern as the production code.

---

## Issue 14: Multiple "deferred to Phase 2" items in `security-model.md` are blocked on Phase 1 work that's done

**[SOLVED]**

**Issue.** `security-model.md` section 6 lists several Phase 2 additions. Most are correctly deferred (rate limiting, CSP, HSTS). Two are worth flagging:

- **CORS preview environments** (line 466) — the recommended approach is reading a comma-separated `ALLOWED_ORIGINS` env var. This is a 5-line change to `main.py` and requires no Phase 2 infrastructure. Given that staging is already deployed (per ADR-002 / `fly.toml`) and the static `_ALLOWED_ORIGINS` dict is already tightly coupled to the three known environments, doing this opportunistically saves a future ADR.
- **Dependency scanning** (line 468) — `pip-audit` and `npm audit` are CI add-ons that can be wired up before Phase 2. Phase 1's package.json and requirements.txt already exist.

This isn't a bug — it's just that the "Phase 2" framing is loose and a few items would be cheap to land now.

**Solution.** Move "CORS preview environments" and "Dependency scanning" to a separate "Could be done in Phase 1" subsection. Treat them as opportunistic rather than gated.

**Verification.** Optional. Doc reorganisation only.

---

## Issue 15: `mei-ingest-normalization.md` still has spike findings that have been corrected

**[SOLVED]**

**Issue.** `mei-ingest-normalization.md` § "Verovio bar-range selection: observed behaviour" (line 141 onward) documents the Component 2 Step 1 spike. Line 145 says: *"A subsequent code review found a bug in the spike script that invalidated Findings 1 and 2 from both runs; the corrected findings are documented below."*

The doc retains both the original (invalidated) findings and the corrected ones. This is good practice for a research log — the historical record matters. But a reader skimming the section can easily read the wrong (invalidated) finding first and miss the correction.

**Solution.** Two options:

1. **Add a banner at the top** of each invalidated finding: *"⚠ INVALIDATED — see corrected finding below."*
2. **Move the invalidated findings to an appendix** at the end of the section, with a clear "Historical: invalidated findings" header.

Recommendation: option 1 if the historical context is integral to understanding the corrected finding; option 2 if it's just preservation. Looking at the doc's structure, option 1 seems right — the corrections build on the wrong attempts.

**Verification.** Doc review. A reader skimming top-down should never read an invalidated claim before reading the correction.

---

## What `docs/architecture/` gets right (the load-bearing positives)

The modelling-and-data axis is in much better shape than the implementation-detail axis. Specifically:

- **`fragment-schema.md` ↔ `corpus-and-analysis-sources.md` ↔ `ADR-009` ↔ `ingest_analysis.py`** form an internally consistent chain. The `movement_analysis.events` shape, the per-event `source` discriminator, the licensing derivation, and the actual code dispatch all match. This is the most important axis to keep coherent and it is.
- **`knowledge-graph-design-reference.md`** and **`edge-vocabulary-reference.md`** are mutually consistent on edge types, with the single exception flagged in Issue 6.
- **`extended-features.md`** is properly scoped. Line 3 states explicitly: *"This document is not a specification and does not belong to the Phase 1 build."* Brainstorm docs in mature codebases have a tendency to drift toward looking like specs; this one resists that.
- **Research notes preserve their assumptions.** `real-audio-playback-research.md` is dated and marked "Research note (future consideration)". `mei-ingest-normalization.md` keeps its spike scripts cited (Issue 15 notwithstanding). When a future maintainer revisits a decision, they can trace the reasoning.
- **Cross-references mostly work.** Apart from the missing `multi-level-tagging-draft.md` (Issues 10 + Report 3 Issue 8), every doc-to-doc reference I followed resolved to an existing path.
- **`bloom-setup.md`** is unusually well-pitched: it's specifically a guide for the non-developer audience (musicologists, annotators, reviewers), and it stays in that register throughout. Worth treating as a model for any other audience-specific doc the project produces.

---

## Summary of action items

**Critical (compounds with bugs from Reports 1–2):**
- Issue 1: Implement the typed-exception architecture from `error-handling.md`, **or** demote the doc to "Proposed".
- Issue 4: Move dev-auth-bypass misconfig check to startup so the app refuses to start.

**Doc-vs-code drift (fix at next pass):**
- Issue 2: Stale paths in `security-model.md` code samples.
- Issue 3: Reconcile signed-URL TTLs across doc and code (three different numbers exist).
- Issue 6: Replace the `APPEARS_IN`-as-Neo4j-edge Cypher example with the cross-DB pattern.
- Issue 7: `normalization_status` field reference → `normalization_warnings`.
- Issue 8: Update `project-architecture.md` to reflect DCML-first analysis pipeline.
- Issue 11: Create `scripts/migrations/` or update the path reference.
- Issue 13: Replace the wrong S3-client pattern in `security-model.md`.

**Cleanup:**
- Issue 5: Remove "MEI schema validation" from Phase 2 additions list — it's done.
- Issue 9: Mark the fragment "sketch" in `tech-stack-and-database-reference.md` as deliberately partial.
- Issue 10: Remove dead `multi-level-tagging-draft.md` references.
- Issue 12: Note that `bass_pitch` / `soprano_pitch` are perpetually null for DCML in Phase 1.
- Issue 14: Re-categorise two Phase 2 items as "could be done in Phase 1".
- Issue 15: Banner the invalidated spike findings in `mei-ingest-normalization.md`.
