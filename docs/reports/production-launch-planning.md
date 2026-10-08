# Production Launch — Planning Report

**Status:** pre-decision report, 2026-10-01. Written after Component 12 closed
(PR #32, `2be0fbd`) and before Component 13 begins. Captures the aims, the
current state, the proposed plan, and the open questions. **Nothing here is
decided yet.** Once Francisco answers § 6, this report is the input to a full
roadmap doc under `docs/roadmap/`, and this file stays as the record of how
the decisions were reached.

---

## 1. Aims

Over the coming weeks a small number of colleagues will start using Doppia.
Before that happens:

1. **Separate staging from production.** Staging becomes a place where
   Francisco can try unfinished work online without colleagues seeing it.
   Production is the stable site colleagues use.
2. **Give production a proper domain** — `doppia.org` — so the URL shared with
   colleagues is permanent and does not name the hosting provider.
3. **Make the site safe and pleasant to hand to someone else.** Data that
   cannot be lost is backed up, emails arrive, sign-in looks trustworthy, and
   testers have a way to report problems.

Non-aims: this is not the public launch, does not change the Phase 2
component order, and does not open registration (that stays tied to
Component 13, per `roles-and-permissions.md` § 3).

---

## 2. Current state (verified 2026-09-18 in the repo)

**The existing "staging" is the environment of record.** It holds everything
that cannot be regenerated: the tagging-campaign fragments and reviews, the
harmony confirmations, the real admin account, the verified Google OAuth
setup. This single fact drives the plan: the job is less "stand up
production" than "promote what exists, and build a fresh staging beside it".

| Area | Today |
|---|---|
| Fly app | One app, `doppia-staging`, `lhr`, 512 MB, `auto_stop_machines` with `min_machines_running = 0`. SPA and API in one image (`backend/Dockerfile`). Config in the single root `fly.toml` |
| Env-specific config | `[env]` in `fly.toml`: `ENVIRONMENT=staging`, `R2_BUCKET_NAME`, `PUBLIC_APP_URL=https://doppia-staging.fly.dev`, `REGISTRATION_MODE=invite`. Build arg `VITE_SOUNDFONT_BASE_URL` (the public `r2.dev` URL) |
| PostgreSQL + Auth | One Supabase project (free tier) |
| Neo4j | One AuraDB Free instance |
| Redis | One Upstash database (cache, rate-limit counters) |
| R2 | Private artifact bucket `doppia-staging`; public `doppia-soundfonts` on an `r2.dev` subdomain, shared by design |
| CORS allowlist | `backend/main.py` `_ALLOWED_ORIGINS`: production entry is still the placeholder `https://doppia.app`. `ALLOWED_ORIGINS` env var can add origins without code |
| CSP | `backend/api/middleware/security_headers.py` allows `*.r2.cloudflarestorage.com` and `*.r2.dev` only |
| HSTS | Sent only when `ENVIRONMENT=production`: `max-age=63072000; includeSubDomains` |
| OpenAPI docs | Disabled when `ENVIRONMENT=production` |
| Migrations | Manual (`fly ssh console -C "alembic upgrade head"`); no `release_command` |
| Keep-alive | `.github/workflows/keepalive.yml` pings staging's `/api/v1/health/deep` daily |
| Production docs | `docs/deployment.md` § Production: a short sketch, written in Phase 1 ("mirror staging; promote the staging image by tag") |

Code that already behaves correctly per environment needs no change:
the auth bypass guard, cookie `Secure` flag, OpenAPI gate, HSTS, and the
`PUBLIC_APP_URL` 503 guard all key off `ENVIRONMENT`.

---

## 3. The two proposals

### 3.1 Staging / production split

**Recommendation: promote the existing stores to production; build new ones
for staging.**

Create a new Fly app, `doppia-production`, whose secrets point at the
*current* Supabase, Aura and Upstash, with a production `[env]` block. Then
point `doppia-staging` at newly created stores. The irreplaceable data never
moves, and Supabase auth users (including the OAuth-linked admin) stay valid.

The alternative — a fresh production and a data migration into it — moves the
campaign data and loses the Supabase auth users unless they are migrated
separately. More risk for no benefit.

Per store:

- **PostgreSQL.** New Supabase project for staging, populated from a
  `pg_dump` of production (application schema and data). Auth users do not
  come across, which is desirable: staging gets its own test accounts.
  Needs a repeatable "refresh staging from production" script.
- **Redis — must be separate.** Rate-limit counters and the `tree:v2:` cache
  keys are not namespaced by environment, so a shared database lets staging
  traffic consume production's limits and a staging seed poison production's
  concept-tree cache. Upstash allows several free databases.
- **R2.** Copy the artifact objects into a new private `doppia-production`
  bucket. Object keys are environment-agnostic (ADR-002), so the copy is
  mechanical and no database row changes. `doppia-staging` stays staging's.
  Soundfonts stay shared.
- **Neo4j — the one real cost question.** See decision D1. The graph is
  reference data seeded from the repo, with immutable ids, so sharing one
  instance is defensible *if* staging never seeds anything that is not on
  `main`. The catch: the glossary renders stub concepts publicly, so an
  experimental domain seeded from staging would appear on the production
  site. A second instance removes the rule entirely.
- **Fly config.** A second config file (e.g. `fly.production.toml`) for the
  differing app name, `[env]` block, build arg, and machine settings. Deploys
  become `fly deploy -c <file>`.
- **Code.** Replace the `doppia.app` placeholder in `_ALLOWED_ORIGINS` with the
  real domain (plus `www` if used), and update its unit test.
- **Keep-alive.** Ping both apps, since both sets of free-tier stores pause.

### 3.2 Domain

Yes, and **before** any colleague receives a URL. HSTS switches on with
`ENVIRONMENT=production` and pins the domain in browsers for two years, with
`includeSubDomains`. Getting the canonical host right first matters more than
usual.

Recommendations:

- **Registrar: Cloudflare.** R2 already lives there, pricing is at cost, and
  DNS is in the same dashboard. Records must be **DNS-only (grey cloud)**, not
  proxied, for Fly's certificate issuance to work cleanly.
- **Canonical host: the apex, `doppia.org`**, with `www` redirecting to it.
  This becomes `PUBLIC_APP_URL`.
- **Staging stays on `doppia-staging.fly.dev`.** No subdomain under
  `doppia.org` means no interaction with `includeSubDomains`, and staging stays
  unlisted.

The domain touches more than the Fly certificate. Every place below needs the
new origin:

| Where | What |
|---|---|
| Fly | `fly certs add doppia.org` (and `www`); A/AAAA records in Cloudflare |
| `fly.production.toml` | `PUBLIC_APP_URL=https://doppia.org` |
| `backend/main.py` | `_ALLOWED_ORIGINS["production"]` |
| Supabase | Auth → URL Configuration: Site URL and Redirect URLs |
| Supabase | Email templates (invite, confirm, reset) if they hard-code a host |
| Google Cloud | OAuth client authorised origins/redirects; consent-screen homepage and privacy-policy links |
| R2 | CORS `AllowedOrigins` on the production artifact bucket and on `doppia-soundfonts` |
| Soundfonts (optional) | Custom domain e.g. `assets.doppia.org` instead of `r2.dev` (the `r2.dev` host is rate-limited and meant for development, per `docs/deployment.md` § 4). Requires adding that host to the CSP and changing the production build arg |

---

## 4. Things not yet on the list

Ordered roughly by how much each would hurt if missed.

1. **Backups.** The fragment database is the one thing that cannot be
   regenerated. To verify: the Supabase free plan is believed to offer no
   automatic backups, while `docs/deployment.md` § Rollback assumes a
   dashboard restore. A scheduled GitHub Action running `pg_dump` into a
   private R2 bucket is a small job. Neo4j needs nothing beyond the repo's
   YAML; R2 artifacts are re-derivable by re-ingest but slowly.
2. **Email delivery.** Supabase's built-in SMTP is throttled to a handful of
   messages per hour and intended for development (to verify the current
   limit). Invites and verification emails to a group of colleagues will hit
   it. Fix: custom SMTP on a free transactional tier, sending from a
   `doppia.org` address, with SPF and DKIM records in Cloudflare. Cloudflare
   Email Routing can give a free receiving address (e.g. `hello@doppia.org`)
   to forward to Francisco.
3. **Google OAuth publishing status.** While the consent screen is in
   "Testing" mode, only listed test users can sign in. Publishing requires a
   homepage and privacy-policy URL. The Google sign-in screen will name the
   Supabase host (`<ref>.supabase.co`) rather than `doppia.org` unless a paid
   Supabase custom auth domain is used — cosmetic, but visible to every
   tester.
4. **A privacy notice.** Real people's emails will live in the database.
   ADR-038 already specifies the substance (export, deletion, editorial
   content reassigned on deletion), so this is a short public page, not a
   legal project. Also required by item 3.
5. **The Orange/R2 routing failure is still open.** See
   `r2-endpoint-unreachable-from-orange.md`. Colleagues are likely on Spanish
   networks, the failure looks like "the site is broken", and server-side
   monitoring can never see it. The short-term canary-plus-message item from
   the 2026-08-30 decision is still pending. Options: land it before testers
   arrive, or ship a known-issues note with the WARP workaround.
6. **What testers can actually do** (decision D4). Until Component 13, a
   `registered` account owns nothing: anonymous reading needs no account at
   all. Tagging needs `editor` grants and writes real production data into
   the review queue Francisco owns. This also decides whether the
   `definition_reviewed` gate and the Spanish content coverage matter for this
   round.
7. **Feedback channel.** A visible "report a problem" link (a mailto to the
   routing address is enough).
8. **Minimal observability.** Fly's built-in metrics show whether anyone
   visited and whether requests fail. An error tracker is optional at this
   scale.
9. **Cold starts.** With `min_machines_running = 0`, a colleague's first visit
   after idle waits several seconds for the machine to boot. Keeping one
   production machine running costs a few dollars a month (decision D5).
   Separately, `docs/deployment.md` § Production says "at least two
   instances" — two machines would also need the rate-limit store on Redis
   (already the case) and inline task dispatch to be safe across machines
   (ADR-034; check before scaling out).
10. **Staging privacy.** An `X-Robots-Tag: noindex` header (or `robots.txt`)
    on staging, plus an unpublished URL, is enough. HTTP basic auth in front of
    staging is not worth building.
11. **Deployment discipline.** The deploy doc already describes promoting the
    tested staging image by tag. Migrations stay manual; consider a Fly
    `release_command` for `alembic upgrade head` now that two environments
    have to be kept in step.
12. **Records.** `docs/deployment.md` (Production section, keep-alive,
    soundfont CORS), `security-model.md` (CORS, HSTS, CSP notes), and the
    environment topology itself. A shared Neo4j instance in particular is a
    design decision the Definition of Done says wants an ADR.

---

## 5. Proposed plan

Five steps. Steps 2 and 3 are the only ones with ordering risk; the rest can
interleave.

1. **Decide.** One sitting, answering § 6.
2. **Domain and production.**
   Register the domain; DNS records; Fly certificates. Create
   `doppia-production` with the existing stores' secrets and a production
   config. Copy R2 artifacts into the production bucket. Fix the CORS
   placeholder. Update Supabase URL configuration, Google OAuth, and R2 CORS.
   Deploy by promoting the current staging image.
   **Gate:** the full cycle — invite → sign-up → verification email → Google
   sign-in → score render with playback — works on `https://doppia.org`. This
   needs a real mailbox and cannot be closed by tests, like Component 12's
   gate 2.
3. **Fresh staging.**
   New Supabase project, Upstash database, and (per D1) Aura instance.
   Restore a production dump; seed `--all`; repoint `doppia-staging`'s secrets.
   Write the refresh-from-production script while the steps are fresh.
   **Gate:** a change deployed to staging is invisible on production, and a
   staging login cannot sign in to production.
4. **Operations.** Backup job with one tested restore; keep-alive for both
   apps; release command (if D9); docs and the ADR.
5. **Tester readiness.** Custom SMTP; OAuth published; privacy page; feedback
   link; R2 canary or known-issues note; noindex on staging. Then send the
   URL.

Then Component 13, unchanged.

---

## 6. Decisions to take

Recommendation first where there is one.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Neo4j for staging | (a) Second Aura instance — free if the account allows it, otherwise Aura Professional; (b) share production's instance, rule: only `main` is ever seeded; (c) local Neo4j on staging (another Fly machine) | Verify whether a second free instance is possible. If yes, (a). If not, (b) with the rule recorded in an ADR |
| D2 | Which environment keeps today's data | (a) Promote current stores to production; (b) fresh production + migration | (a) |
| D3 | Canonical host | (a) apex `doppia.org`, `www` redirects; (b) `www.doppia.org`, apex redirects | (a) |
| D4 | What testers do this round | (a) Read only, anonymous — no accounts needed; (b) accounts for profile/exercise history, no tagging; (c) some colleagues get `editor` and tag on production | Francisco's call. Determines whether SMTP, OAuth publishing and the privacy page are blocking or merely nice to have |
| D5 | Production machine policy | (a) `min_machines_running = 1`; (b) auto-stop like staging; (c) two machines | (a) during the test weeks |
| D6 | Soundfonts host | (a) keep `r2.dev`; (b) custom `assets.doppia.org` | (b) if cheap to do alongside the domain work, else (a) for now |
| D7 | Email | (a) custom SMTP provider now; (b) Supabase built-in until it hurts | (a) if D4 involves accounts |
| D8 | R2/Orange canary | (a) build the canary + message first; (b) known-issues note and WARP advice | (b) for the first testers, (a) before a wider round |
| D9 | Migrations | (a) Fly `release_command`; (b) stay manual | (a), now that two environments must match |
| D10 | Budget ceiling | What monthly spend is acceptable? Free tiers everywhere, or a few paid items (production machine always on, Aura Pro, domain, SMTP) | Francisco's call; shapes D1, D5, D6 |
| D11 | Where staging test data comes from | (a) periodic refresh from a production dump; (b) staging seeded independently and left to drift | (a) |
| D12 | Timing relative to Component 13 | (a) do this first, as its own small piece of work; (b) interleave with Component 13 | (a); it is short and Component 13 then deploys straight to two environments |

---

## 7. Facts to verify before the roadmap doc

Stated from general knowledge rather than checked; each changes a
recommendation if wrong.

- Whether AuraDB Free allows more than one instance per account (D1).
- Whether the Supabase free plan includes any automatic backups, and its
  current built-in SMTP rate limit (§ 4 items 1–2).
- Whether a second free Upstash database is available on the current account.
- Google's current requirements for publishing an OAuth consent screen that
  requests only basic scopes (email, profile).
- Whether moving the inline task dispatch (ADR-034) to two machines is safe,
  before any choice of D5 (c).
