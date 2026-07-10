# Step 30 — Code, Test & Dependency Review

**Date:** 2026-07-09
**Scope:** Component 9 Part 9 close-out review, per
`component-9-corpus-population-and-hardening.md` § Step 30: conventions sweep,
dead-code/TODO sweep, invariants spot-audit, test-coverage review, dependency
audit, Verovio version policy check.

**Outcome at a glance:** conventions and invariants all pass; two stale code
comments fixed; frontend vulnerabilities fixed to zero; three safe backend
security bumps applied and test-verified; **four items recorded for decision**
(§5.3) — headlined by the fastapi/starlette advisory set.

---

## 1. Conventions sweep — pass

| Convention | Result | Evidence |
|---|---|---|
| black / isort / ruff | ✅ clean | `black --check` (125 files unchanged), `isort --check-only`, `ruff check` — all pass |
| `from __future__ import annotations` | ✅ everywhere | Only `__init__.py` files lack it (acceptable); an apparent miss in `mei_normalizer.py` was a false positive (import sits below a ~95-line module docstring) |
| Route handlers `async def` | ✅ | Every top-level `def` in `backend/api/` is a DI factory or helper (`get_*_service`, `require_role`, `get_language`, `get_storage`), never a route handler |
| No magic relationship strings | ✅ | `graph/queries/relationships.py` is the constants module; services reference edge names only in docstrings; static Cypher literals are permitted per the module's documented usage rule |
| Error envelope | ✅ | All four handler tiers in `api/middleware/errors.py` produce the envelope, including bare `HTTPException` from middleware (mapped via `_HTTP_STATUS_TO_ERROR_CODE`) and the 500 catch-all |
| Cursor pagination | ✅ | No `offset` parameter anywhere in `backend/api/` |
| Docstrings | ✅ (spot) | Google-style present on the modules spot-checked (`dependencies.py`, `errors.py`, `relationships.py`, `fragment.py`, task modules) |

## 2. Dead-code and TODO sweep

- **Frontend `src/`: zero** TODO/FIXME/XXX/HACK markers.
- **Backend: one** TODO, at `models/fragment.py:546` — stale: it demanded that
  the tagging tool supply `mc_start`/`mc_end` at write time, which shipped long
  ago (and misattributed the tool to Component 3). Rewritten as a statement of
  the invariant (never derive mc from bar numbers). A second stale comment on
  the same model ("`beat_start`/`beat_end` null in Phase 1 until beat-level
  extraction is implemented" — contradicted ADR-005 as implemented) was
  corrected to the actual null semantics ("full extent of the measure range").
- No dead modules found in `backend/` (every service/queries module has
  importers); `tests/snapshots/` is intentionally empty (deferred to Phase 2,
  documented in CLAUDE.md). Repo-level cleanup (stale branches, spike outputs)
  is Step 32's remit.

## 3. Invariants spot-audit — all six hold

| Invariant | Evidence |
|---|---|
| Concept `id` immutability | `scripts/seed.py` diffs live Neo4j ids against the loaded YAML and warns loudly (dedicated exit code 3 when the operator aborts on the warning) |
| `MERGE`-only seeds | `graph/queries/seed.py`: every write is `MERGE` + `ON CREATE SET`; the only `CREATE` is `CREATE FULLTEXT INDEX ... IF NOT EXISTS` (schema, not data) |
| Pydantic before every write | Upload path: `IngestMetadata.model_validate` (`services/ingestion.py:151`); fragment path: `FragmentSummary` with `Literal[1]` version discriminator + `validate_concept_existence` against the graph before any DB write |
| `require_role()` only | Zero inline role comparisons (`.role ==` etc.) outside `api/dependencies.py` |
| `summary` versioning | `FragmentSummary.version: Literal[1]`, `extra="forbid"` — any other version fails validation until a v2 schema exists |
| Object key, never URL | No URL is persisted; the only literal URLs in services are XML namespaces, docstring examples, and the CC-licence *display* links in the ADR-009 serialiser (returned, not stored) |

## 4. Tests and coverage

- **Backend unit:** 786 passed (18.7s), zero failures.
- **Frontend:** 827 passed, 3 skipped, ESLint `--max-warnings 0` clean.
- **Source-only unit coverage:** 76% (4,379 stmts / 1,030 missed).
- **Low-coverage files are the integration tier's surface, by design:**
  `services/fragments.py` (29%), `services/analysis.py` (23%), `main.py` (0%),
  `graph/queries/validation.py` (0%), `services/concepts.py` (44%),
  `services/cache.py` (50%). These are exercised by
  `tests/integration/test_fragments_api / test_review_api / test_review_queue_api /
  test_analysis_api / test_concept_browse_api` (Docker-gated,
  `DOPPIA_RUN_INTEGRATION=1`, run in CI per Phase-2 hard gate 7) and by
  `scripts/validate_graph.py` (CI). The campaign's exercised paths — submit,
  review/reject/resubmit, browse-by-concept, preview generation, analysis
  slicing — all map to one of those suites.
- **Campaign-path unit additions since the triage batch** are present:
  `test_task_dispatch.py` (ADR-034), `test_fragment_preview_task.py`,
  `test_verify_mc_stability.py`, `test_i18n.py`.
- Not run here: the integration tier (requires `docker compose up`; CI owns it).

## 5. Dependency audit

### 5.1 Fixed now — frontend (verified: 827 tests + lint green)

`npm audit` reported 8 vulnerabilities (2 high: undici; moderate: react-router
open redirect, vite/launch-editor NTLMv2 disclosure, js-yaml DoS).
**`npm audit fix` resolved all 8 → 0 vulnerabilities**, changing only
`package-lock.json` (all bumps in-range; `package.json` untouched;
react-router-dom → 6.30.4 stays on v6).

### 5.2 Fixed now — backend (verified: 786 unit tests green)

| Package | From → To | Advisories closed |
|---|---|---|
| python-multipart | 0.0.20 → 0.0.31 | 6 (upload/form parsing CVEs incl. CVE-2026-53540) |
| python-jose | 3.3.0 → 3.4.0 | PYSEC-2024-232/233 |
| python-dotenv | 1.1.0 → 1.2.2 | CVE-2026-28684 |

### 5.3 Recorded for decision — not applied

> **Decision (2026-07-09, with Francisco):** items 1 (fastapi/starlette), 2
> (lxml) and 4's CI wiring (§5.4: pip-audit in requirements-dev + report-only
> audits in CI) land together as a **pre-Step-32 batch** after the campaign
> closes, gated on the full unit + integration suites. Item 3 (PyJWT migration)
> is **Phase-2 backlog**. The black/pytest dev bumps ride the same batch only
> if convenient; black's reformat lands as an isolated `chore:` commit if so.
>
> The batch and all Phase-2 deferrals are consolidated in
> `docs/roadmap/phase-2-entry-backlog.md`.

1. **starlette 0.41.3 (via fastapi 0.115.6) — 7 advisories** (multipart DoS
   family and related; fix versions 0.47.2–1.x). Fixing requires a coordinated
   **fastapi bump**, which touches the auth middleware, routing, and TestClient
   behaviour — not a mid-campaign change to make casually. *Recommendation:*
   schedule the fastapi+starlette bump immediately after the campaign closes
   (still in-component, before Step 32), gated on the full unit + integration
   suites. Severity context: staging is internal-only and access-gated
   (Supabase Auth), so exposure is limited.
2. **lxml 5.3.0 → 6.1.0** (PYSEC-2026-87): major-version bump of the
   normalizer/validator parser. The corpus is frozen, so the normalizer only
   runs on future re-ingests; the 797-test normalizer suite is a strong net.
   *Recommendation:* bump together with item 1 in the same post-campaign batch.
3. **python-jose PYSEC-2025-185 (no fix) + ecdsa PYSEC-2026-1325 (no fix,
   transitive):** python-jose is effectively unmaintained. *Recommendation:*
   migrate JWT validation to **PyJWT** in Phase 2; record as Phase-2 backlog
   with the security-review deadline.
4. **Dev-only:** black 24→26 (would reformat the tree — churn, defer and land
   as an isolated `chore:` commit if wanted), pytest 8→9 (PYSEC-2026-1845,
   dev-only exposure). Not urgent.

### 5.4 Process gap

`pip-audit` is not in `requirements-dev.txt` and neither audit runs in CI —
`security-model.md` § "Could be done in Phase 1" already recommends both.
*Recommendation:* add `pip-audit` to requirements-dev and wire
`pip-audit`/`npm audit` into CI as a non-blocking (report-only) step first;
make it blocking once the §5.3 items are resolved so it doesn't start red.

## 6. Verovio version policy (ADR-013) — compliant

Pinned **6.1.0** in both `backend/requirements.txt` and
`frontend/package.json` (exact pin, client/server parity per the ADR-013
addendum). 6.2.0 is available; per the policy an upgrade is a deliberate,
verified event — no action, and no advisory pressure on 6.1.0.

---

## Disposition summary

| Finding | Disposition |
|---|---|
| 2 stale comments (`models/fragment.py`) | Fixed in this review |
| 8 npm vulnerabilities | Fixed (`npm audit fix`, lockfile-only) |
| 3 backend packages with safe fixes | Fixed (requirements + venv, test-verified) |
| fastapi/starlette advisory set | **Decided 2026-07-09:** pre-Step-32 batch |
| lxml major bump | **Decided 2026-07-09:** same batch |
| python-jose/ecdsa unfixable | **Decided 2026-07-09:** Phase-2 — migrate to PyJWT |
| black/pytest dev bumps | Optional; ride the batch or isolated chore |
| pip-audit + audits in CI | **Decided 2026-07-09:** same pre-Step-32 batch (report-only first) |
