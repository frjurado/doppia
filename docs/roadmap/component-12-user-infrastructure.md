# Phase 2 — Component 12: User Infrastructure — Implementation Plan

This document translates Component 12 of [`phase-2.md`](phase-2.md) into a
concrete, sequenced set of implementation tasks, following the model of the
Component 10 and 11 plans: it does not restate settled design, it sequences
implementation and pins the integration boundaries the design docs leave open,
and where it reaches a decision those docs do not record it flags it for
confirmation rather than baking it in silently.

The authoritative design is
[`../architecture/roles-and-permissions.md`](../architecture/roles-and-permissions.md)
(role model, registration flow, moderation, data rights — all decided
2026-07-14). This plan adds the *how* and the *order*, plus the two work
batches that ride the component:

1. **The user infrastructure itself** — the role-set migration, invite-only
   registration with the full role model, the user-state tables that must
   exist before their features do, data rights (export + deletion), the
   minimal moderation tool, and the topbar/responsive redesign that turns the
   editorial shell into a public product frame.
2. **The carried debt batch** — the seven Component 11 triage items deferred
   here in full (minus item 13, re-homed by decision below), the Track M rows
   slotted "during 12" (M4, M9, M13, and by decision M17 and the G1 piece of
   M10), and the design-debt register F8–F13 where the design pass overlaps
   it.

Component 12 is the pivot of Phase 2: everything after it (Collections,
Presentation Mode, Exercises, Blog) assumes accounts, roles, and the product
chrome exist. It is also the last component in which the permission machinery
can change shape cheaply — after 13, user-owned content depends on it.

---

## Prerequisites

All four Component 11 hard gates were met at close (2026-08-25, PR #31 merged
as `e017dc0`, deployed to staging). Additionally, before the registration
steps can be exercised end to end:

- **Supabase project configuration** (Francisco / admin dashboard): enable
  email+password signup with mandatory email verification; configure the
  invite-email template; register the **Google OAuth** provider (requires a
  Google Cloud OAuth client — an external credential-creation task, worth
  starting early since consent-screen review can take days).
- **`REGISTRATION_MODE` config flag** (`invite` | `open`) added to the
  environment schema — invite-only at launch, flipped to `open` when
  Collections ship (`roles-and-permissions.md` § 3). A config flag, not a
  code change.
- The token-storage prerequisite (ADR-035, HttpOnly cookie + server-side
  credential proxy) landed in Component 10 — registration builds on that
  proxy, not on direct browser↔Supabase calls.

---

## Part 1 — Role Model Core (backend)

The order inside this part is strict: the join table first, then the
enforcement helpers, then the verification gate. Everything else in the
component sits on top of these three steps.

### Step 1 — `user_role` join table and migration

Create `user_role` per the SQL sketch in `roles-and-permissions.md` § 1
(composite PK `(user_id, role)`, `granted_by`/`granted_at` audit columns);
Alembic migration migrates `app_user.role` into rows (`'editor'` → one
`editor` row, `'admin'` → one `admin` row, `'user'` → no row — `registered`
is implicit in having an account) and **drops the column**. Role names become
constants in one module (mirroring the
`backend/graph/queries/relationships.py` convention for relationship types).

Two integration points the design doc does not spell out, both grounded in
current code:

- **The JWT is no longer the source of truth for roles.** Today
  `api/middleware/auth.py:168` reads `app_metadata.role` from the Supabase
  token and `api/dependencies.py` JIT-upserts it into `app_user` on every
  authenticated request. After this step, grants live in PostgreSQL only:
  the middleware stops reading the claim, the JIT upsert inserts/updates the
  `app_user` row *without* a role, and `get_current_user` loads the user's
  role set from `user_role` (one indexed query; cache only if it measurably
  hurts). Existing Supabase `app_metadata.role` values are migrated once by
  the Alembic data migration and then ignored.
- **Dev auth bypass** (`AUTH_MODE=local`, `scripts/seed_dev_users.py`): the
  seeded dev editor/admin need matching `user_role` rows; the bypass path in
  `auth.py` needs the same role-set loading. Update `security-model.md`'s
  dev-bypass section in the same change.

Recorded as an **ADR extending ADR-001** (together with Step 2 — one ADR for
the whole role-model migration).

### Step 2 — `require_role()` any-of + `require_owner_or_role()`

`require_role()` becomes any-of over the user's role set, and
`require_owner_or_role(user, resource, *roles)` is added in the service layer
as the second — and only other — sanctioned permission mechanism
(`roles-and-permissions.md` § 1).

**Flagged wrinkle — the design doc's "single-argument calls are unchanged in
behaviour" is not quite true.** Today `require_role` is a *hierarchy* check
(`_ROLE_HIERARCHY = {"editor": 1, "admin": 2}`,
`backend/api/dependencies.py:28`): `require_role("editor")` admits an admin.
Under any-of it would not. The permission matrix (§ 2 of the roles doc) gives
admin every editor capability, so the resolution is to **audit every call
site and enumerate explicitly** — `require_role(EDITOR, ADMIN)` wherever the
matrix says both — rather than keeping an implicit admin-passes-everything
rule. Explicit enumeration is what the matrix already is; an implicit
superuser rule would silently grant admin the author-only capabilities too,
which the matrix does *not* do (admin edits any post via its own row, not by
being an author). Call-site audit is small: `require_role(` appears in ~8
route modules.

`require_owner_or_role` lives in the service layer (it needs the ORM object;
`require_role` stays a route dependency — the two layers are by design, per
the roles doc). Its first real consumers are Component 13's collections; in
this component it ships with unit tests and one internal consumer (Step 9's
"delete own account" path).

**Invariant update in the same commit:** `CLAUDE.md` and `CONTRIBUTING.md`
wording becomes *"`require_role()` and `require_owner_or_role()` are the only
permitted permission mechanisms — no inline role or ownership checks anywhere
else."*

### Step 3 — Email-verification gate

A service-layer precondition (`require_verified(user)` or equivalent)
checked alongside role checks for content-creating actions
(`roles-and-permissions.md` § 3): unverified accounts can log in but cannot
create content. Verification status comes from the Supabase token/user record
(`email_confirmed_at`), surfaced onto the request user by the auth
middleware. In this component its consumers are profile edits (Step 6) and
report filing (Step 11, when that ships); Collections adopt it in 13. Ships
with tests proving the unverified path is blocked with the standard error
envelope.

---

## Part 2 — Registration & Accounts (frontend + auth proxy)

### Step 4 — Registration flows through the server-side auth proxy

Extend `services/supabase_auth.py` / `api/routes/auth.py` (the ADR-035
proxy) with: sign-up (email+password, invite-gated when
`REGISTRATION_MODE=invite`), resend-verification, password reset, and the
**Google OAuth** dance.

- **Invite gating:** admin-issued Supabase invite emails
  (`roles-and-permissions.md` § 3). The proxy's sign-up endpoint refuses
  non-invited sign-ups while the flag is `invite`; the admin issue-invite
  action is Step 10's surface.
- **OAuth wrinkle to resolve early:** ADR-035 removed all direct
  browser↔Supabase traffic and the CSP has no `*.supabase.co`. OAuth is a
  *navigation* redirect (not fetch — CSP `connect-src` does not block it),
  so the flow is: backend endpoint returns the Supabase authorize URL →
  full-page redirect → Supabase → Google → callback route on *our* origin →
  the SPA hands the code to the proxy, which exchanges it server-side and
  sets the HttpOnly refresh cookie exactly as password login does. Spike
  this first inside the step; it is the one genuinely untested path in the
  auth design. If it fights, password+verification launches first and Google
  OAuth becomes its own follow-up — registration is invite-only at this
  stage anyway, so the cost of deferring is low. Any deviation from ADR-035's
  flow gets recorded as an amendment to that ADR.
- New accounts get **no** `user_role` rows (`registered` is implicit);
  default-deny falls out of Step 1 automatically.

### Step 5 — Registration UI

`/register` (invite acceptance + sign-up form), verify-your-email
interstitial, unverified-state banner, Google button on `/login`, password
reset. Extends the Phase 1 login page — `login-page.md` § Scope explicitly
excluded registration and password reset; mark that spec superseded on these
points rather than rewriting it. All new UI strings go through the existing
i18n mechanism (they are the first entries in Step 19's inventory, so name
keys consistently).

### Step 6 — Profile

Profile page under the account menu: `display_name` edit,
`self_declared_role` (new column with the CHECK vocabulary drafted in
`tech-stack-and-database-reference.md` § User infrastructure — student /
educator / researcher / hobbyist / professional_musician / other; optional,
asked at registration too), and the **reading-history opt-in toggle**
(default off — the consent lives here even though the history view itself is
later). Verification gate applies to writes.

---

## Part 3 — User-State Schema & Data Rights

### Step 7 — The record-from-day-one tables

One Alembic migration, shapes from `component-15-exercises.md` § 6 and
`tech-stack-and-database-reference.md`:

- `exercise_type` — created now **only as the FK target** that
  `exercise_session.exercise_type_id` requires; empty until Component 15
  seeds it. (The alternative — deferring the FK — buys nothing.)
  `exercise_activation` waits for 15; nothing references it.
- `exercise_session` + `exercise_result` — exactly the § 6 sketch, including
  `mode = 'standard' | 'preview'` and `fragment_id` **without** FK cascade
  (results outlive fragments).
- `reading_history` — the drafted shape with the surrogate `BIGSERIAL` PK
  (the PK-includes-time note), both indexes. Recording is wired **now** for
  the one surface that exists: fragment-detail views record a row iff the
  user has opted in (Step 6). Blog posts join in Component 16 via
  `content_type`.

**Decision (2026-08-26): `collection` / `collection_fragment` are *not*
created here** — they land in Component 13 with their feature, designed
against real use. Nothing is lost: the deletion/tombstone rules that shape
their FKs are recorded in Step 9's ADR now. This resolves the tension
between `phase-2.md` § Component 12 (which lists them under "user state
schema") and `tech-stack-and-database-reference.md` (which defers them until
their consumers exist) in favour of the latter; `phase-2.md` gets a
clarifying edit.

### Step 8 — Data export

Self-service endpoint producing one JSON document: profile, collections
(with annotations), exercise history, reading history
(`roles-and-permissions.md` § 5). Written resource-generic so Component 13
adds collections by registering a section, not by editing the exporter.
No editorial content. Rate-limited in the existing `slowapi` write category.

### Step 9 — Account deletion + the system user

- Create the **system user** (`deleted-user`) as a seeded `app_user` row
  with a fixed, documented UUID.
- Deletion *deletes* user-owned content (profile, exercise
  sessions/results, reading history, reports filed; collections when they
  exist) and *reassigns* editorial contributions to the system user —
  grounded in the actual FKs: `fragment.created_by`
  (`backend/models/fragment.py:614`, nullable) and
  `fragment_review.reviewer_id` (`fragment.py:689`, `ondelete=RESTRICT` —
  the RESTRICT is exactly right: it forces the reassignment path and makes
  a bare `DELETE` fail loudly). Blog-post authorship joins the reassignment
  list in Component 16.
- The Supabase auth user is deleted via the admin API through the proxy;
  the whole operation is one service function, transactional on the
  PostgreSQL side, with the Supabase call last (an orphaned auth-less
  `app_user` row is recoverable; the reverse is not).
- Recorded as an **ADR** (data-rights: export shape, deletion semantics,
  the system user, and — for Component 13 to inherit — the rule that
  snapshot-imported collections survive the source owner's deletion).

---

## Part 4 — Admin Surfaces

### Step 10 — User management (invites + role grants)

Minimal admin page under the Editorial menu: list users, issue invites
(Supabase invite email via the proxy), grant/revoke roles (writes
`user_role` with `granted_by`; revoking `admin` from yourself is refused —
the one guard worth having). This is what makes invite-only launch operable
without the Supabase dashboard. Permission: `require_role(ADMIN)`.

### Step 11 — Moderation queue

`moderation_report` table exactly per `roles-and-permissions.md` § 4
(generic `resource_ref`, one open report per user per resource), the service
functions, and the admin queue UI (list → dismiss / action). **The report
action and the "unpublish share" action ship dark:** nothing reportable
exists until Component 13's sharing, so 12 delivers the schema, the service,
the queue page, and tests against synthetic reports; 13 wires the report
button on shared-collection views and implements unpublish-share as the
first `actioned` outcome. This satisfies "the moderation tool must be live
before sharing is" (`phase-2.md` § Component 13) with zero dead UI on public
surfaces.

---

## Part 5 — Topbar, Responsive Addendum & the Design Pass

This part is one coherent design effort — `phase-2.md` is explicit that the
topbar is "part of the responsive / design-system work, not a standalone
tweak". Triage items 10 and 11 belong to it by the same decision.

### Step 12 — `DESIGN.md` responsive addendum + Verovio narrow-width check

Breakpoints, the mobile nav pattern, and the per-surface support matrix
(`phase-2.md` § Mobile) go into `DESIGN.md` as an addendum *before* the
topbar is built to them. The open technical check rides here: an afternoon
confirming Verovio at narrow widths (vertical scroll + small scale) on the
public surfaces — glossary, fragment detail. Findings noted in the addendum;
anything ugly becomes a scoped follow-up, not a blocker (the matrix already
commits only the reading surfaces to full mobile support).

**Done 2026-08-31.** `DESIGN.md` § 7 carries the addendum: three breakpoints
(`sm` 600 / `md` 900 / `lg` 1280, `sm` derived from the measured 552–560px
point where notation stops being downscaled), the support matrix, the
layout-width set that Step 14's F10 tokenises, the below-`sm` disclosure-nav
pattern Step 13 builds to, and a 44px touch-target minimum (nothing on the
public reading path currently meets it — Step 14 / F12). Verovio check: below
`sm` notation is **optically scaled, not reflowed** (pageWidth clamped at
480px, SVG CSS-scaled to ~0.60× at 360px); accepted as intended, since a 26px
staff is near print size and reflowing would give ~2 bars per system. The two
risks did not materialise — bracket overlays stay aligned through the
downscale, and no surface scrolls horizontally at any width tested.
Regression-guarded by `frontend/e2e/narrow-width.spec.ts` (5 cases, real
Verovio WASM). Two follow-ups handed to Step 14, below.

### Step 13 — Topbar redesign

The three editorial links become: **public nav** (Fragments, Glossary — plus
Collections / Exercises / Blog *as they ship*; unshipped surfaces are
absent, not greyed out), a role-gated **Editorial** menu (corpus Browse /
score viewer, Review, moderation queue, user management), and an **account
menu** (profile, progress placeholder, logout) with sign-in/register
entry points for anonymous visitors. Role-gating consumes Step 1's role set
via the existing auth context. Built mobile-first against Step 12's
addendum; this retires the Component 10 note that the public shell's nav was
minimal-by-decision.

**Done 2026-08-31.** `NavBar` and the minimal public header are replaced by
one shared `TopBar` mounted from both layouts, so every surface carries the
same frame. Public nav is Fragments (`/public/concepts`) + Glossary; the
Editorial menu (editor or admin) holds Corpus, Concept tree, Review, and for
admins Moderation and People; the account menu holds Profile, Progress and
sign out, with Login / Create account when anonymous. Below `sm` all three
groups collapse into one frosted-vellum disclosure panel with 44px targets,
per `DESIGN.md` § 7.4. The progress entry opens a real placeholder page
(`/progress`) rather than sitting greyed out, since § 7.4 forbids
shown-and-disabled entries.

Decided during the step (see § Decisions 5): the **editorial fragment browser
shows the same approved-only fragments as the public one** —
`FragmentBrowser.tsx:270` pins `statusFilter` to `approved` with no setter and
no UI to change it, even though the endpoint supports every status. It is
therefore listed as "Concept tree", which is its only real feature, not as a
second Fragments view.

Two defects the build turned up, both from verifying on renders rather than
tests alone: `role="listitem"` on the nav anchors (inherited from `NavBar`)
destroyed their link semantics, and an `aria-label` on the account button
replaced the email with "User menu". Both are gone. The `sm` tagline rule from
Step 12 was revised to `md` — a tagline truncated between the two breakpoints
reads as a defect; `DESIGN.md` § 7.4 records the revision.

### Step 14 — Design-system pass (F-register overlap, triage 10 + 11, M5)

One pass over the shared chrome, scoped to what this component already
touches:

- **F10 width tokens** and **F12 shared button/control library** — both are
  direct dependencies of the topbar and of the action-row work below; they
  land fully.
- **Triage item 10** — one action row at the panel foot (Cancel / Delete /
  Save / Submit), destructive action visually separated; the destructive
  treatment has no `DESIGN.md` precedent yet, so the pass adds one (that is
  the actual deliverable — the layout move is trivial,
  `FormPanel.tsx:455–475` / `:676–700`).
- **Triage item 11** — verify on screen that radio (ONE_OF, ≤2 values) and
  checkbox (MANY_OF) states are visually distinct under 0px-radius/tonal
  constraints; strengthen the cue if not. A check with a possible small fix,
  not a rebuild — the count-based presentation threshold stays.
- **M5 bracket redesign** — the design-thinking item: square handles on
  stored fragments, edited-vs-rest differentiation, sub-bracket label
  collision (the "Dominant with Final Tonic" overlaps), above/below-staff
  collision minimisation. Design exploration first (sketches against
  `DESIGN.md`), then implementation. This is the pass's largest unknown;
  timebox the exploration and let the implementation land late in the
  component without gating anything else.

  **Done 2026-09-01.** Exploration:
  [`../reports/component-12-reports/m5-bracket-redesign-exploration.md`](../reports/component-12-reports/m5-bracket-redesign-exploration.md),
  which measured the failures in a sandbox against the production constants
  rather than arguing from the report. The four asks all reduced to one cause:
  **four surfaces each carrying a private copy of the vertical geometry**, one
  of which had deliberately matched another's constant so that stored sub-parts
  would "sit in the same lane as live stage brackets" — and duly collided with
  them. `bracketLanes.ts` is now the single lane table.

  What shipped: square serifs on committed brackets and a gradient fade kept
  for live ones, so **the end treatment encodes editability**; labels always on
  the far side of their bracket from the staff; stored sub-parts in their own
  lane; stored brackets dimmed while a live selection exists (focus by quieting
  the rest); and stage and sub-part labels staggered onto a second row **only
  where they would actually collide**. The stored lane also moved from −16 to
  −26: at 3px of clearance the stored and live brackets read as one two-tone
  bar, which is why "differentiate the one being edited" was felt as a problem.

  A second read-through (2026-09-03) reworked three of these — see § 7 of the
  exploration. The serif trick became "one serif per boundary, drawn by the
  bracket that begins there"; serifs below the staff turn *up*, so a bracket's
  ends always turn in toward what they enclose; and the **live selection
  bracket was removed outright** as redundant with the ghost layer, which
  already fills the committed selection and carries its drag handles. That
  freed an above-staff lane, and the stage-visibility fix let the below-staff
  lanes merge again — together ~36px less vertical stack per system, which is
  what feeds the adjacent-system collision.

  Stage visibility is the keystone: expansion is derived from selection now
  rather than toggled beside it, which fixes "B's stages appear but A's stay
  on", "clicking A again switches its stages off", and "entering an edit should
  hide everyone else's stages" in one change.

  The roadmap's open question is answered: M5 **did** want the bracket-geometry
  unification, but only its vertical half. The horizontal projection
  (`stageFrame.ts`, `resolveSegments`) is untouched — it carries the M7
  beat-precision fix and invariant I7, and has no bearing on these collisions.
  That half stays in the Phase-2 backlog.
- **Carried from Step 12's narrow-width check** (`DESIGN.md` § 7.7), both
  scoped and small:
  - *Glossary example card below `sm`.* `ConceptExamples.module.css`
    `.cardHeader` is a three-column flex row with a `flex-shrink: 0` 140px
    preview well; at 360px the metadata column is left ~46px and wraps to one
    word per line. Below `sm` the header stacks (or the preview well
    collapses). This is a **Full**-support surface, so it is a bug, not a
    deferral. `FragmentBrowser.module.css` shares the pattern but is
    desktop-only — leave it.
  - *Sub-part label scaling.* Labels are a fixed 10px while their brackets
    shrink to 60% on a phone, so the M5 collision case is ~2.4× worse there.
    **M5's redesign must be verified at 360px, not only at desktop width.**
    **Done 2026-09-01:** labels scale with the notation, with a legibility
    floor — a faithful ratio gives 6px at 360px, which is not readable type, so
    the rule is `max(8px, 10px × scale)`. Verified at 360px as required. The
    fix was masked by `Number('480px')` returning `NaN` where `parseFloat`
    works, which had pinned the ratio at 1.
- **F8, F9, F11, F13 stay in the backlog** unless the pass touches their
  files anyway — "fold in where it overlaps" (`phase-2.md`), not a sweep.

**Step 14a done 2026-09-01** (split at Francisco's request: the design-system
items first, M5 as a second pass). F10, F12, triage 10 and 11, and the § 7.7
glossary card all landed; M5 is what remains.

- **F10.** Six width tokens in `styles/tokens.css`, replacing eighteen magic
  numbers. Two surfaces the Component 9 survey predated joined the set rather
  than extending it: admin tables 960 → `--width-listing` (880), profile column
  640 → `--width-list`. The open 1200-vs-1280 question is **closed**: A/B'd on a
  48-bar render at a 1600px viewport, where the score viewer's cap actually
  binds. 1200 gives a uniform 8 bars per system, 1280 gives 9 (8 on the first,
  which carries the clef and meter); the 1280 engraving is clean and better
  filled, with no crowding or overflow. Unified up, as § 7.3 proposed.
- **F12.** `components/ui/Button.tsx` — six variants (primary, secondary,
  tertiary, quiet, and the destructive **pair**), two padding sizes, `fullWidth`.
  Sizes carry padding only: typography stays `Type`'s job, as everywhere else
  in this codebase. Migrated: the five auth routes, both admin routes, profile,
  `FormPanel`, `FragmentDetailPanel`, `SubmissionChecklist`, the three
  load-more rows and the corpus CTA. The migration found real drift it then
  erased — three copies of primary/secondary that disagreed on hover colour and
  padding, and an `Admin .primaryButton` with no hover state at all.
  The score-surface chrome was deferred to a second pass and **completed
  2026-09-03** — after M5 rather than during it, since M5 turned out to be about
  bracket geometry and touched none of those files. Two shapes were missing
  from the library and are now in it: `SegmentedControl` (with `ToggleButton`,
  its single-option form) and `IconButton`. Migrated: staff size ×2, the
  selection grid, the TAG/Done and harmony toggles, both transport rows, both
  close buttons, and the text-link register. `HarmonyPanel`'s four buttons went
  with them — they were in F12's original scope and the first pass simply
  missed them.

  Two findings worth keeping. The three segmented controls **disagreed about
  what "selected" looks like**: staff size filled the active segment with
  `primary`, the selection grid stepped it one tonal layer instead. Both are
  defensible; both sitting in one toolbar is not. And the resting fill had to
  become a white card rather than a tonal step, because these controls sit on
  two different layers and a step that reads against the score viewer's toolbar
  vanishes against the fragment viewer's panel — the same trap the option marks
  hit in triage item 11.

  Two things stay unmigrated, deliberately: `.transposeButton`, a dropdown
  trigger belonging to the toolbar's select family rather than the button
  library; and the checklist's own Save/Submit, whose muted-until-ready state
  is meaningful and is not a `disabled` variant.
- **Triage 10.** Done in two passes. The first moved Cancel and Delete out of
  the old `.fragmentHeader` (removed entirely — hosting those controls was its
  whole purpose) into the checklist's action row. Francisco's read-through then
  found the real problem was wider than the move: the tool had **three** action
  grammars, and the move had added a fourth. On a stored fragment, four buttons
  in two rows on two tonal layers, all left-aligned, in two styles; on a new
  fragment, centred full-width buttons in two different colours plus a
  right-aligned Delete. "Somewhat random, and merits a conceptual review."

  The second pass replaced all of it with one grammar, now in `DESIGN.md` § 5
  "Action blocks": one block per panel, one tonal layer, pinned to the foot;
  decisions stacked full-width (these panels are ~320px resizable columns —
  an inline row of four cannot read there); at most one filled button, and it
  is the action that moves the fragment's lifecycle *on the server*; lifecycle
  chrome in one small row beneath, never filled, destructive at the trailing
  edge; semantic wells nested inside. Consequences worth noting: `.reviewSection`
  and `.footer` collapsed into one `.actionBlock`; **Edit became secondary
  everywhere** (it switches mode locally and changes no server state, so its
  treatment no longer depends on whether a review is pending); and Submit now
  keeps the primary treatment while unavailable, faded rather than recoloured
  — the old muted grey box read as a different kind of control. Verified on a
  render in all three states, including the destructive pair's trigger and
  confirmation.
- **The destructive precedent** is recorded in `DESIGN.md` § 5 — the
  deliverable the account-deletion UI has been waiting on since Step 9.
- **Triage 11.** The check found them **identical**, not merely similar: same
  `.optionLabel`, same tonal fill, native input visually hidden, so nothing at
  all distinguished a ONE_OF group from a MANY_OF one. The first attempt added
  a "Choose one" / "Choose any" line plus a leading indicator, and filled the
  selected row with `primary`. Francisco rejected both halves, correctly: a
  control that needs explanatory text has already failed, and the full-width
  blue drowned the ⓘ buttons sitting inside the row.

  What shipped instead takes the **BOOL toggle as the model**, since it was
  already the cleanest of the three controls: only the indicator well changes
  colour, never the row. A MANY_OF option *is* a BOOL — its well fills with a
  tick, identically. A ONE_OF option shows a solid mark centred in the well,
  the square counterpart of a radio's dot. No explanatory text. The same mark
  went into the **dropdown presentation** (>2 values), which had no indicator
  at all and so carried the same bug in its other half.

  A third read-through then found the drift ran through the whole sidebar, not
  just the two option groups, and all of it resolved the same way — toward the
  BOOL row and the floating ⓘ, both of which were already right. Measured
  before touching anything: three mark sizes down one column (property 16px,
  BOOL 24px, stage swatch 14px), the smallest mark carrying the largest label;
  option rows with a `surface-container` fill that read as pale rectangles
  inside a stage's `surface-container-highest` well and as *nothing* in a panel
  section, where the two tones are identical; the BOOL clickable only on its
  mark while option rows were clickable across their whole width; and three
  separate ⓘ implementations, one of which opened on click alone and expanded
  inline, shoving the rest of the sidebar down. What landed:

  - **One 16px mark** for property rows, the BOOL row and the stage swatch.
    The swatch keeps its per-stage *colour* — that is what ties the row to its
    bracket in the score, and is not decoration to be unified away.
  - **Flat rows.** No per-row fill; hover is the only fill and it is transient.
    An empty mark became a white card with the sanctioned ghost outline
    (`DESIGN.md` § 4) because a tonal step cannot read on both a panel section
    and a stage well — against the latter it disappeared outright.
  - **The whole row is the target**, BOOL included.
  - **One ⓘ.** `InfoHint` absorbed both of `PropertyForm`'s private
    implementations (gaining an optional title for referenced concepts) and its
    fixed 240px panel became full-width. `.descButton`, `.descFloating`,
    `.infoButton`, `.infoPanel`, `.infoTitle` and `.infoDef` are gone.
  - **The absent stage swatch** stopped being a 1.5px solid border — a
    standing no-line-rule violation — and became the same empty mark.
  - The `hideFieldLabels` BOOL special case could be deleted: the name is part
    of the control now, so hiding field labels can no longer strand it as an
    unlabelled tick.

  Verified on a render: property rows, BOOL, dropdown and stage swatches in one
  column, in both the panel-section and stage-well contexts.
- **Deliberately not in scope:** Francisco's wider point that "a full review of
  sidebar design would be good" — spacing rhythm, heading hierarchy, section
  nesting depth. This step unified the *controls*, which is what triage item 11
  covers; the layout review is a Component 13 candidate.
- **Render verification.** Everything reachable was checked on screen. The two
  panel surfaces could not be driven through the score viewer (the stored
  bracket needs a committed selection the stub harness could not produce), so
  they were rendered through a temporary dev-only route mounting both panels
  with stubbed fragments — added, screenshotted, and reverted in the same
  session. Worth repeating rather than rediscovering: it is the only cheap way
  to see a panel state that is otherwise several interactions deep.

### Step 14b — Route topology: a real landing page, and one browse surface

Added 2026-08-31 (Francisco), after Step 13 surfaced both halves of this. It
runs **after Step 14** — a landing page is a design deliverable, and Step 14
lands the width tokens (F10) and shared control library (F12) it should be
built from; building it first means building it twice — and **before Part 6**,
because Component 13 adds Collections to the public nav and user-owned content
on top of these routes. Settling topology inside 12 avoids shipping a topbar
that 13 has to revise.

Two problems with one shape:

- **`/` is the corpus browser**, an editorial surface. So the post-login
  redirect (`Login.tsx:42`) sends every account there including role-less
  ones; an anonymous visitor to the site root is bounced to `/login` and never
  sees the product; and `RequireRole`'s "you lack the role" fallback cannot
  use `/` without looping. Step 13's interim gating stops the raw permission
  string from rendering, but the topology is still wrong.
- **`/concepts` and `/public/concepts` are near-duplicates** (§ Decisions 5):
  identical status set, same `FragmentCard`, detail pages differing only by
  API client and an always-`approved` badge. The real differences are the
  concept-tree navigator, the ADR-009 NonCommercial licence filter, and the
  auth gate.

The work:

1. **`/` becomes a public landing page**, common to every audience, and the
   corpus browser moves to `/corpus`. This is the piece that pays for the
   rest: the post-login redirect becomes correct for all roles,
   `RequireRole`'s fallback becomes `/` (see its docstring), and `TopBar`'s
   `isEditorial ? '/' : '/glossary'` wordmark special case collapses to plain
   `/`. Delete that branch when it does — it exists only because `/` is
   currently editorial.
2. **Collapse the two browse surfaces**, deciding as part of it whether the
   concept-tree navigator is worth keeping (the glossary index largely does
   its job publicly, with `fragment_count` per node) or whether the glossary
   simply becomes the way in. If it is kept for anonymous users it needs
   public concept-tree endpoints — the current ones are editor-only.
   Licence filtering keys off the session, not the route.
3. **Revisit the interim gating** from Step 13 in light of 1 and 2: which
   routes still need `RequireRole`, and whether `/fragments/:id` should
   collapse into the public detail route the same way.

Recorded in `phase-2.md` § Decisions Log. `login-page.md` gets a note if the
post-login destination changes there rather than in `Login.tsx`.

**Done 2026-09-04.** The investigation this step asked for found the two
surfaces closer together than the plan assumed and further apart in one
respect that mattered.

*Already shared, before any work:* `FragmentCard` (the public browser imported
it from the editorial one), the `ConceptBrowseResponse` type, the same service
method behind both endpoints — and the **detail page**, which was already one
component parameterised by `loadFragment` + `publicMode`.

*The one real difference:* `/api/v1/fragments` requires `EDITOR`/`ADMIN` and
`/api/v1/public/fragments` is anonymous, pinned to `approved`, and excludes
NonCommercial corpora (ADR-009 § 2). Crucially the service enforces both on
**`caller_id is None`** — the session, not the route. So an editor sees NC
corpora and an anonymous visitor never does, and that distinction survives the
collapse rather than being flattened by it.

*The blocker the plan recorded had already gone.* "If the navigator is kept for
anonymous users it needs public concept-tree endpoints" — `/api/v1/public/
concepts` already returns a flat node list keyed by `parent_id` with fragment
counts, and its nodes are **field-for-field identical** to the editorial tree's.
The adapter is one `flatMap`.

Decided (Francisco): **one route, client picked by session; navigator kept and
public-powered for everyone.**

- `/` is a landing page for every audience; the corpus browser moved to
  `/corpus`. That alone fixes the post-login redirect for role-less accounts,
  stops anonymous visitors bouncing off the site root, and lets `RequireRole`
  refuse callers to `/` without looping.
- `/fragments` and `/fragments/:id` are the only browse and detail routes.
  Both components read the session and choose their client; `publicMode`
  becomes `!isEditorial` rather than a route-injected prop.
- Root search stays editorial — `/concepts/search` is gated and has no public
  counterpart. The forest below it is public, so the navigator itself stays.
- `/public/concepts`, `/public/fragments/:id` and `/concepts` are **redirects,
  not deletions**: the glossary has linked into the first since Component 11 and
  fragment permalinks have been shareable since Component 10. The redirect
  preserves the query, which is the whole point — a concept id lives there.
- Both Step 13 stopgaps are retired: `TopBar`'s `isEditorial ? '/' : '/glossary'`
  wordmark branch is a plain `/`, and `RequireRole`'s refusal destination is
  `/`. The editorial menu lost "Concept tree", which pointed at the editorial
  half of a surface that no longer has halves.

Two defects the work surfaced, both from the collapse itself: `FragmentDetail`
would have fetched with the public client and never retried, because roles
arrive asynchronously and its effect depended only on the fragment id — an
editor would have silently lost the status badge, resolved property names, and
any NC fragment; and the browse empty state said "search for a concept" to
readers who have a tree beside them and no search box, because it keyed on
`?root` rather than on whether a forest had rendered.

`PublicFragmentBrowser` and its test are deleted; the test's coverage moved
into `FragmentBrowser.test.tsx` as the role-less case rather than being dropped
with the file.

---

## Part 6 — Tagging-Tool Chrome & Conventions Batch

The carried Component 11 triage items (8, 9, 12, 14 — see
[`../reports/component-11-reports/component-11-triage.md`](../reports/component-11-reports/component-11-triage.md)
for the grounded detail) plus the Track M rows slotted here. Item 13 is
**not** in this batch — re-homed to Component 15 (§ Decisions).

### Step 15 — Short labels: items 8 + 14, and the M4 naming bug

One solution to one underlying gap — "the display needs a short label and
the model only reliably carries a long one":

- **Item 8:** `short_name` on `PropertyValueYAML` (triage option (c)): seed
  schema + merge + read query + `PropertyValueItem` + forms render
  `short_name ?? name`; the glossary keeps `name`. `aliases` stays what it
  is. **Editorial dependency: Francisco writes the short forms** for the
  stage-component values before the step closes.
- **Item 14:** parent-bracket label falls back `alias ?? name` (the one-line
  fix matching `subPartLabel`'s existing deliberate fallback), so no bracket
  is ever nameless; aliases added in `cadences.yaml` wherever Francisco is
  happy to coin one (editorial call — several of the six have no
  conventional abbreviation).
- **M4's naming piece** ("Evaded Cadences are not named as such in the
  review queue") — verify it is the same alias gap and falls out of the
  fallback; if the queue renders a different field, fix it to the same rule.

**Landed 2026-09-05**, with one addition the plan did not anticipate and one
bug it surfaced:

- `short_name` alone could not carry item 8, because removing "(IV, ii, ii6,
  …)" from a name deletes the gloss outright — the ⓘ is per *schema*, so
  there was nowhere for it to go. The step added `description` alongside
  `short_name` on `PropertyValueYAML`, and repointed the per-value ⓘ at it.
  That ⓘ previously rendered the referenced concept, which for these values
  is stub boilerplate under a title repeating the value; it now suppresses
  entirely when there is nothing real to say, which needed a `stub` flag on
  `ReferencedConcept`. `name` stays the absolute form on purpose — Component
  15's distractors and any export are context-free consumers.
- M4's naming piece **is** the same alias gap, but the queue could not
  simply fall back: `ReviewQueueItem` carried the alias and not the name.
  Added `primary_concept_name`, which is where the bug came in — the two
  listing helpers in `FragmentService` ended up with fallthrough `return`
  statements of the wrong arity, unpacked as tuples of a different length.
  Neither path had a test, because every fixture inserts a primary tag.
  Fixed, and covered: an untagged fragment now has an integration test
  asserting it still lists with all three concept fields null.
- Editorial outcome (short forms, and four coined aliases) is recorded in
  the triage report under items 8 and 14.

### Step 16 — Item 9: rare properties under an "Other" group

Three `group:` lines in `cadences.yaml` (the ADR-023 mechanism already
renders labelled clusters — no code). **Editorial call for Francisco:** does
`ECP` stay inline, leaving "Other" = `Covered` + `Unison`? Collapsibility
stays in the backlog per the triage recommendation — see whether the cluster
suffices first.

**Landed 2026-09-06.** Francisco's call: `ECP` stays inline, `other` =
`Covered` + `Unison`, and the cluster sorts last.

It was not "no code". The plan assumed the ordering mechanism could express
this; it could not. ADR-023 § 4 sorted **every grouped schema ahead of every
ungrouped one**, so grouping the rare pair promoted it *above* `ECP` — the
leftovers would have rendered before the property they were meant to follow.
Giving `ECP` a group of its own would have fixed the order at the cost of a
heading over a single property, which is what "stays inline" rules out.

So the sort is now `order` then `name`, with no grouped-first term: a
schema's declared `order` alone fixes its position, and `group` only says
which neighbours draw a shared heading. One clause removed from the Cypher
`ORDER BY`; the renderer already clustered contiguous runs without
re-sorting, so no frontend change was needed. ADR-023 § 4 carries the
amendment, including the new obligation it creates — **group members must
hold contiguous `order` values**, or the group draws two headings. Covered by
tests at both ends (`tests/graph/test_concept_detail_async.py`,
`PropertyForm.test.tsx` § 9), neither of which existed before.

Resulting order on a PAC: `closure` (CadenceFunction, PhraseClosure,
ThemeClosure) → ungrouped inline (ReinterpretedAsHC, ECP) → `other`
(Covered, Unison).

#### Scope: making "other" collapsible (not built — for Francisco to schedule)

Francisco is confident collapsing is right, but wanted the grouping first and
the cost of the rest written down before committing to it.

**What the data says.** Of 91 fragments in the local DB, **`Covered` and
`Unison` are set on zero**; `ECP` on four. Both are optional `BOOL`s, so a
collapsed cluster can never hide a required field or affect
`computeIsComplete` — the correctness risk that would normally dominate this
work is absent here.

**The work, honestly sized:**

1. **A disclosure primitive — the real cost.** There is no shared one.
   `ConceptExamples`, `InfoHint` and `TopBar` each hand-roll `aria-expanded`,
   which is exactly the F-register duplication Step 14 was set up to remove.
   Doing this properly means extracting a `Disclosure` into
   `components/ui/` and migrating those three, not adding a fourth variant.
   That is the majority of the effort and it is shared-chrome work, not
   property-form work.
2. **A `DESIGN.md` pattern.** No collapsed-section precedent exists (the
   `sm`-breakpoint disclosure nav is a different thing). Under 0px radius, no
   1px dividers and tonal-layering-only, "there is more here" has to be
   carried by tone and an affordance glyph. Same shape as Step 14's
   destructive-action precedent: the documented pattern *is* the deliverable.
3. **Where the collapsed state lives.** Per-group, per-session is the cheap
   answer (component state); remembering it across fragments needs somewhere
   to put it. Not a hard problem, but a decision.
4. **The "never hide a set value" rule.** Even though nothing sets these
   today, a group that silently hides a checked box is a data-integrity
   trap: open by default when any member has a value, and keep it open.
   One predicate, but it must be tested, and it is the reason not to
   hard-code "collapsed by default".
5. **Tests.** Toggle, keyboard, the auto-open predicate, and the existing
   § 9 clustering tests extended.

**Recommendation: schedule it with the `Disclosure` extraction, in Component
13's chrome work — not as a Step 16 follow-up.** Collapsing two never-used
optional booleans is a thin payoff for a new bespoke widget; the same effort
spent extracting the primitive pays for itself across three existing call
sites and makes this a few lines. The grouping already delivers most of what
item 9 asked for — the rare pair no longer reads as noise beside the rest.

**Also noted, not fixed:** group labels are free-form strings rendered
verbatim (uppercased in CSS) and are **not translated** — a Spanish reader
sees "CLOSURE" and "OTHER". Pre-existing with `closure`; this step adds the
second instance. Belongs with the ADR-006 overlay work, not here.

### Step 17 — Item 12: the blocked-stages notice

Render the already-computed state: when `stageGridBlocked`
(`ScoreViewer.tsx:685`) is true, the stage area shows a note — selection too
short for the concept's stages; lengthen it or mark stages absent. The copy
follows the design pass's tone; the state and the submission block already
work.

**Landed 2026-09-06, with the precondition Francisco set.** He accepted the
notice *only if* the stages are in the sidebar so disabling is possible
without lengthening — and they were not. `computeAutoPrePopulate` returned
`assignments: []` when blocked (its docstring said "keep assignments empty"),
`StageList` returns `null` on an empty list, and the absent toggle lives on a
stage card. The notice would have told the annotator to do something the UI
gave them no way to do.

Blocked now yields *unplaced* assignments — one per stage, `bounds: null`,
`absent: false` — so the cards render and the toggle is reachable. Marking a
stage absent re-attempts placement with the stages that remain and clears the
notice once they fit. `computeStagesComplete` already reports false for a
non-absent stage with no bounds, so submission stays blocked meanwhile.

Two follow-on corrections this forced: the three "needs pre-population"
guards keyed on `stageAssignments.length === 0`, which no longer means what
it did — they now test blocked explicitly, or extending a blocked selection
would never retry placement. All four cadence stages are optional, so the
"mark absent" escape is genuinely available; a concept with required stages
would still have only the lengthen option, which the copy does not promise.

**Corrected after Francisco's read-through (same day).** The first cut
re-evaluated placement only *while* blocked, so the un-block direction was
never re-checked: mark a stage absent on a too-short selection and the other
three place and the notice clears, but re-enable it and nothing happens — no
bracket, no space, no notice. Reproduced exactly against the real functions
before changing anything.

Two causes. `toggleStageAbsent` restores a stage by carving bars from a
neighbour, and when no neighbour can spare one it restores the stage with no
bounds at all. That is the right answer — the alternative is the inverted
geometry Step 18 fixed, and Step 18's `canDonate` guard is what turned the old
silent *corruption* into a silent *no-op* — but it says nothing. And the
handler only looked at the blocked flag, which was false by then.

The toggle handler now re-evaluates in both directions: if any stage is wanted
but unplaced (`hasUnplacedWantedStage`, extracted and tested rather than left
inline), it re-attempts placement across the whole wanted set, and raises the
notice again when that too is blocked. Local surgery is kept whenever it
placed everything, so confirmed positions are not thrown away by an unrelated
toggle. Note submission was never actually possible in the broken state —
`computeStagesComplete` already returns false for a wanted stage with no
bounds — so this was a missing explanation, not a bad write.

**A third defect, from the same read-through: the carve counts bars, the
stages sit on beats.** 4/4, a measure and a half selected, PAC laid out
2+2+1+1. Disabling Initial Tonic hands its beats to Pre-dominant, which then
holds `m1b1 .. m2b1`. Re-enabling gave Initial Tonic the *whole* of bar 1 and
left Pre-dominant at `m2b1 .. m2b1` — zero beats wide, still listed present.

Pre-dominant spans "two bars" by the bar count and two beats in reality,
because its range crosses the barline. `canDonate` and the carve both counted
bars, so they read a stage with two beats as having a bar to spare. Step 18's
`expectValidBounds` test missed it for the same reason: `barEnd >= barStart`
holds, and the emptiness is entirely in the beats.

Bounds are now checked for real extent — `(bar, beat)` pairs under the
half-open reading, where `beatStart: null` is the bar's first beat and
`beatEnd: null` its end — and the restore declines when either the restored
stage's or the donor's new bounds would span nothing, restoring unplaced
instead. `hasUnplacedWantedStage` then routes it to the wholesale
re-placement, which lays the wanted set out on the grid the selection
actually needs and recovers the original 2+2+1+1. Three regression tests
cover the reported sequence; all three fail without the guard.

**Not a bug, asked in the same message:** the 2+2+1+1 distribution over six
beats. `chooseStageGrid` returns the *coarsest* grid at which every stage gets
a slot — measure, then beat, then sub-beat — and six beat slots hold four
stages, so it stops at beat and never reaches sub-beat. The resolution control
in the toolbar is the display grid; it does not force pre-population finer.

### Step 18 — M9 + M4 UX: small tagging/review chrome fixes

- **M9:** fix stage ordering (un-toggled stages jump to the end — keep the
  set order fixed). The "stage properties" label was already dropped in M0.
- **M4 UX:** review-queue select scrolls the score to the fragment; back
  button returns to the queue, not the browser root.

**Landed 2026-09-06.** Both items were larger than the plan's one-liners.

**M9 was hiding a data-integrity bug.** Francisco's warning that "weird
orderings happen depending on how you click the stages" was right, and the
cause is not ordering. Restoring a stage carves bars out of its nearest
*active* neighbour — which, after other stages have been disabled, is not
necessarily its schema neighbour. When that donor spans a single bar the
carve took the bar anyway, leaving the donor at `barEnd === barStart - 1`.
Probing toggle sequences on four one-bar stages: `S2- S3- S3+ S2+` ends with
`S1 (1-0)`, `S3- S1- S3+ S1+` with `S2 (2-1)`, while `S2- S3- S2+ S3+` — the
same toggles, different order — is clean.

Nothing downstream rejects an inverted bracket: the write model validates
`ge=0` and within-bar beat ordering only, sub-part containment reads an
inverted range as trivially contained, and `fragment` has no check
constraint. It would have been persisted. Fixed by refusing a donor that
cannot spare a bar (falling through to the other neighbour), with the
proportional carve clamped as a second line of defence, and covered by a test
that walks five toggle sequences asserting no bounds ever invert.

**The ordering fix itself** was Francisco's call between three options: placed
stages still sort by position (Component 9 G2 preserved), but an unplaced
stage now keeps its slot in the sequence instead of dropping to the bottom.
For contiguous stages — all of them — position order and schema order
coincide, so only the absent cards move. `tagging-tool-design.md` updated.

**M4 UX turned up a Step 14b regression.** The score viewer's back link still
pointed at `/`, which Step 14b turned into the public landing page; it had
been the corpus browser. It now goes to `/corpus`, or to `/review-queue` when
the viewer was reached from the queue (`?fragmentId=`), with its own label.
The scroll-to-fragment waits for the bracket element rather than firing with
the panel, since the bracket only exists after Verovio renders and the
overlay positions it.

### Step 19 — M13: i18n surface inventory

The deliverable is a *list*, not an implementation: every untranslated UI
surface, per type/complexity/urgency — including the strings this component
adds (registration, topbar, moderation, profile) — ending in a decision
session with Francisco on what to implement when. Full second-language
machinery stays deferred per ADR-006.

**Landed 2026-09-06** —
[`../reports/component-12-reports/i18n-surface-inventory.md`](../reports/component-12-reports/i18n-surface-inventory.md).

The headline inverts the expectation the step was written with: **UI chrome is
already complete**. A scan of every `.tsx` for JSX text and literal
`aria-label`/`placeholder`/`title`/`alt` found one real hit, in a dev-only
spike route. 519 keys, 12 namespaces, `en` + `es`, parity enforced in CI —
including everything this component added.

The gap is entirely **editorial content**. All four ADR-006 translation tables
exist and are wired, with the `machine`/`reviewed`/`authoritative` ladder and
`source_hash` staleness tracking — and hold zero Spanish rows. Switching to
Spanish today gives a fully Spanish interface around entirely English musical
content. Populating them is data entry, not engineering.

Three structural gaps need schema work first: property value `short_name` and
`description` (ADR-039 — the table carries `name` only), property schema
group labels (free-form strings with no id to key a translation on), and
backend error messages (English at the raise site; the frontend surfaces the
server's prose rather than mapping on `code`). The report sizes each and
proposes an order for the decision session, whose first question is whether
Spanish is a real second language for *content* or a UI convenience over an
English corpus.

**Decisions taken 2026-09-06**, recorded in § E of the report. Spanish **is**
a real second language, so content translation is in scope. § B (populate the
tables) and § C.1 (`short_name` / `description` columns) and § C.3 (error
messages on `code`) are scheduled as Step 19b, before Step 20. § C.2 (group
labels) is deferred with its strategy settled — promote them to keyed
entities, not client-side i18n keys. `fragment_annotation_translation` gets a
working assumption (machine translation, provenance on the existing status
ladder) and its own scoping pass later; it is not in 19b.

### Step 19b — Spanish content translation

The implementation half of Step 19, scheduled by the decisions above:

- **Populate the Spanish rows** in `concept_translation`,
  `property_schema_translation` and `property_value_translation`. 34 concepts,
  13 schemas, 22 values — bounded editorial work against machinery that
  already exists. `fragment_annotation_translation` is **out of scope** here.
- **Extend `property_value_translation`** with `short_name` and `description`
  (ADR-039 recorded them as untranslated; that was always provisional), plus
  the overlay read path so a non-English locale resolves them.
- **Translate errors on `code`** rather than surfacing the server's English
  `message`: an `errors` namespace entry per code, and a decision about the
  fallback for an unmapped code.

The editorial content is Francisco's; the schema and read-path work is not.
Sequence accordingly — the columns can land before the rows exist.

### Step 20 — M17 + G1: the meter-rule and beat-display conventions

Decided into this component 2026-08-26 (display/coordinate conventions
settle before Exercises reads beat data):

- **M17 rule:** 3/8 behaves like 3/4 (Francisco's reading) — "compound"
  requires a numerator that *groups*, i.e. `count >= 6 && count % 3 == 0`,
  aligning `ghosts.ts` `isCompoundMeter`/`beatSlotCount` with DCML and
  `ingest_analysis.py` (which already requires `count >= 6`). Decide and
  record what a one-beat signature (3/8 read compound would have been one)
  is allowed to be; the rule lands in an ADR or as an amendment to the
  beat-encoding notes (ADR-005-adjacent — record where the encoding is
  specified).
- **M17 data pass:** the 53 K280/iii fragments (scale measured 2026-07-27;
  K279/iii was a false positive of M18) get a data migration in
  `backend/data_migrations/` re-expressing stored beat coordinates under
  the corrected rule, plus a re-run of `clamp_subpart_bounds.py` for the
  movement it previously refused to touch. Verified on real renders per the
  standing feedback rule — a script-only audit is not sufficient.
- **G1 (the M10 piece kept here):** settle the beat-range display
  convention so "beats 1⅔–1" can never render (`displayEndBeat`; mechanism
  on file in `part-8-campaign-triage.md`). The other two M10 pieces (pickup
  numbering, caret at repeats) go to Component 13 (§ Decisions).

---

## Decisions

Made in this planning session (2026-08-26, Francisco):

1. **Triage item 13 (capture extensions) re-homes to Component 15.** It is
   tagging capture work unrelated to user infrastructure; 15 is where its
   absence bites (exercisability triage already references it). Accepted
   cost: `ReopeningHalfCadence` fragments tagged before 15 keep missing
   their constitutive pointer. `phase-2.md` § Component 12's carried-items
   table and `component-15-exercises.md` § capture-extensions note get the
   pointer.
2. **M17 lands in Component 12** (Step 20) — rule, ghost-layer fix, and the
   K280/iii data pass together.
3. **M10 splits:** G1 beat-range convention here (Step 20); pickup/partial-
   bar numbering (the ADR-005-adjacent design work) and the repeat-barline
   caret move to Component 13.
4. **`collection` / `collection_fragment` DDL waits for Component 13**;
   Component 12's data-rights ADR records the FK-shaping rules now.
5. **(2026-08-31, during Step 13) The two fragment-browse surfaces stay split
   for now, with one public nav entry.** Investigation showed they are
   near-duplicates rather than an editorial/public pair — the "editorial" one
   is pinned to approved fragments too (`FragmentBrowser.tsx:270`). Public nav
   points at `/public/concepts` for everyone; the editorial browser sits in
   the Editorial menu as "Concept tree", its only distinguishing feature.
   Consolidation is logged for Component 13 (§ Deferred) rather than resolved
   inside the topbar step.

Flagged for confirmation during implementation (small, but this plan does
not decide them):

- **Any-of call-site enumeration** (Step 2): the plan resolves the
  hierarchy→any-of wrinkle by explicit enumeration per the permission
  matrix; confirm in the role-model ADR review.
- **Editorial inputs Francisco owns:** short forms for stage-component
  values (Step 15), which of the six alias-less concepts get coined aliases
  (Step 15), whether `ECP` stays inline (Step 16).
- **Google OAuth fallback** (Step 4): if the proxied OAuth dance fights
  ADR-035's constraints, password-only launches first and OAuth becomes a
  follow-up — acceptable under invite-only.

---

## Deferred to Later Components

Stated so the boundary is a decision, not a gap:

- **Item 13 — capture extensions** → Component 15 (decision 1 above).
- **Stage absent/restore should carve in grid slots, not bars** → later
  consideration (Francisco, 2026-09-06: "too much for right now"). Three
  defects in this one path during Step 17/18 all came from the same root:
  `toggleStageAbsent` rebalances in whole bars while the stages are laid out
  on whatever grid the selection needs, usually beats. A stage spanning
  `m1b3 .. m2b1` counts as two bars and holds two beats, and every bar-based
  judgement about it is wrong. Both guards now in place — refusing a donor
  that cannot spare a bar, and refusing any carve that would leave either side
  spanning nothing — are *detectors*: they keep invalid geometry out and hand
  the case to the caller's wholesale re-placement. That is correct but coarse,
  since it discards the local surgery that would have preserved confirmed
  positions. The principled fix is to carve in the frame's own slots, which
  means `toggleStageAbsent` needs the ghost layer and stops being a pure
  function over assignments — a real refactor, not a patch.
- **Browse-surface consolidation** → Component 13. `/concepts` (editorial) and
  `/public/concepts` are near-duplicates: identical status set, the same
  `FragmentCard`, and detail pages differing only by API client and an
  always-`approved` badge. The real differences are the concept-tree navigator
  (whose job the glossary index largely already does), the ADR-009
  NonCommercial licence filter, and the auth gate. Collapsing them touches
  routes, the editor-only concept-tree endpoints, and the glossary's role as
  entry point — too much to absorb into a topbar step, but it should not
  outlive Component 13.
- **Collection tables + the report button + unpublish-share action** →
  Component 13, on top of this component's moderation schema/queue.
- **Open registration** → flipped by config when Collections ship.
- **Pickup/partial-bar beat numbering; caret at repeat barlines** (M10
  remainder) → Component 13.
- **M3** (fragment edit/lifecycle UI), **M8** (harmony-panel semantics),
  **M14** (Verovio 6.2.0) keep their later Track M slots (13–14).
- **Collapsible property groups**, **F8/F9/F11/F13**, **glossary
  subtype hierarchy**, **bracket-geometry unification** — Phase-2 backlog,
  unchanged. (If Step 14's bracket redesign (M5) turns out to want the
  geometry unification, that is the trigger to pull it forward — note it in
  the design exploration.)
- **Progress dashboard** → Component 15 (§ 7 of its doc); the account menu
  ships a placeholder.

---

## Sequencing

```
Part 1  Role model core                     ← everything sits on this
  Step 1  user_role table + migration + ADR
  Step 2  any-of require_role +
          require_owner_or_role + invariants
  Step 3  verification gate
        │
        ├──────────────────────────────┐
        ▼                              ▼
Part 2  Registration & accounts    Part 3  User state & data rights
  Step 4  auth-proxy flows           Step 7  exercise_*/reading_history
          (OAuth spike FIRST)        Step 8  export
  Step 5  registration UI            Step 9  deletion + system user + ADR
  Step 6  profile                          │
        │                              ┌───┘
        ▼                              ▼
Part 4  Admin surfaces (needs roles + registration)
  Step 10 user management (invites, grants)
  Step 11 moderation schema + queue (report UI ships dark)

Part 5  Design (parallel with Parts 2–4 after Step 1)
  Step 12 DESIGN.md responsive addendum + Verovio narrow check
  Step 13 topbar (needs Step 12 + role set from Step 1)
  Step 14 design pass: F10/F12, items 10+11, M5 bracket redesign
  Step 14b route topology: landing page at /,
          corpus browser to /corpus, one browse surface

Part 6  Tagging chrome & conventions (parallel; independent of Parts 1–4)
  Step 15 short labels (items 8+14, M4 naming)   ← editorial input
  Step 16 item 9 "Other" group                   ← editorial input
  Step 17 item 12 blocked-stages notice
  Step 18 M9 ordering + M4 review-queue UX
  Step 19 M13 i18n inventory → decision session  ← after 13/15 add strings
  Step 20 M17 meter rule + data pass; G1 convention
```

Steps 15–18 and 20 touch the tagging tool and can start immediately; Step 14
should follow Step 12 so the pass writes to the settled addendum. Step 19
runs late so the inventory includes this component's own new strings.

---

## Docs to Update (Definition of Done)

- **`roles-and-permissions.md`** — mark sections implemented; fold in any
  deltas (any-of enumeration, OAuth flow shape).
- **`CLAUDE.md` + `CONTRIBUTING.md`** — the two-mechanism permission
  invariant wording (Step 2, same commit).
- **`security-model.md`** — registration flows, dev-bypass role rows,
  moderation/report surface; ADR-035 amendment if the OAuth dance deviates.
- **New ADRs:** role-model migration (extends ADR-001); data rights
  (export/deletion/system user); the M17 meter rule (or ADR-005-adjacent
  amendment).
- **`tech-stack-and-database-reference.md`** — user-infrastructure section
  updated: created tables, `self_declared_role` landed, collection DDL
  pointer to Component 13.
- **`DESIGN.md`** — responsive addendum; destructive-action precedent;
  bracket redesign outcomes.
- **`login-page.md`** — superseded-note for registration/reset scope.
- **`component-15-exercises.md`** — item 13 ownership note (capture
  extensions build there, not just triage).
- **`phase-2.md`** — tick Component 12 scope; strike M4/M9/M13/M17 + the G1
  piece of M10 in Track M with landing commits; record decisions 1–4 in the
  Decisions Log; clarify the collection-DDL split.
- **`phase-2-entry-backlog.md`** / **`issues-deferred-for-phase-2.md`** —
  strike landed items with commits per the registers' maintenance notes.

---

## Hard Gates Before Component 13 Begins

1. **The role model is migrated and enforced:** `app_user.role` is gone;
   grants live in `user_role`; `require_role` is any-of with all call sites
   enumerated per the permission matrix; `require_owner_or_role` exists and
   is tested; the invariant wording in `CLAUDE.md`/`CONTRIBUTING.md` is
   updated; the ADR is recorded.
2. **Invite-only registration works end to end on staging:** invite → sign-up
   → verification email → verified account with no granted roles; Google
   OAuth works (or its deferral is explicitly recorded); unverified accounts
   are blocked from content creation by the service-layer gate.
3. **The user-state tables exist and record:** `exercise_type` /
   `exercise_session` / `exercise_result` / `reading_history` are migrated;
   a fragment-detail visit by an opted-in user writes a `reading_history`
   row; opt-out writes nothing.
4. **Data rights are real, not decorative:** export returns the full JSON
   document for a test user; deletion of a seeded user with editorial
   content reassigns `fragment.created_by` / `fragment_review.reviewer_id`
   to the system user and deletes the user-owned rest — proven by an
   integration test, not inspection.
5. **The admin can operate the launch:** user management (invite, grant,
   revoke) and the moderation queue are reachable from the Editorial menu
   and tested against synthetic data.
6. **The product chrome shipped:** the topbar's public nav / Editorial menu /
   account menu are live on staging, built to the responsive addendum, and
   the addendum is in `DESIGN.md`.
7. **The tagging chrome batch is closed:** no bracket renders nameless
   (items 8/14 + M4 naming), the blocked-stages notice shows (item 12), the
   rare-property group renders (item 9), stage ordering is fixed (M9), the
   review-queue navigation works (M4), and the panel action row follows the
   new precedent (item 10).
8. **The conventions are settled and the data matches:** the 3/8 rule is
   recorded and implemented, the K280/iii data pass is verified on real
   renders, and G1 can no longer render an inverted range.
9. **The i18n inventory exists** and its decision session has happened
   (implementation may be deferred — the gate is the decided list, not the
   translations).
