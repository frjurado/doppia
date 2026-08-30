# Staging score loading fails — R2 S3 endpoint unreachable from Orange España

**Date:** 2026-08-29 · **Updated:** 2026-08-30 (second opinion + re-probe)
**Author:** Francisco (symptom report, network-side confirmation) · investigation in Claude Code
**Source:** Staging (`doppia-staging.fly.dev`) returning "Failed to fetch" on every score load, reported alongside a Fly Doctor port warning and a recurring Neo4j deprecation notice in the logs.
**Status:** **Diagnosed and confirmed.** Not a defect in Doppia. Workaround in place (Cloudflare WARP, verified by Francisco). A 2026-08-30 re-probe (§ 6) found the endpoint reachable again but the routing hole only **partially** healed — this is ongoing instability, not a closed incident. A durable fix is **proposed below but NOT implemented** — it needs an ADR decision first. The action plan is split into short-term (unconditional) and long-term (decision-gated) items under § Follow-ups.

**Bottom line: Orange España is not routing the Cloudflare anycast prefixes that R2's S3 API endpoint lives on.** The browser must reach `<account>.r2.cloudflarestorage.com` directly to fetch presigned MEI and SVG artifacts; from Orange, TCP connections to that host are silently dropped. Everything else in the stack — Fly, Supabase, Neo4j, the API, DNS, CORS, CSP — is healthy. The two log messages that prompted the investigation are both red herrings.

---

## Symptom

Loading any score in staging failed with `Failed to fetch`. Corpus browse
thumbnails (incipit SVGs) were broken in the same way. MIDI playback and its
piano soundfonts worked normally, as did login, navigation, and every other API
call.

That asymmetry is the fingerprint of this failure and the fastest way to
recognise it again: **the artifacts served from the private R2 bucket break;
the soundfonts served from the public `r2.dev` bucket do not.**

---

## The failing path

Score loading resolves MEI in two hops
([frontend/src/routes/ScoreViewer.tsx:2214-2218](../../frontend/src/routes/ScoreViewer.tsx#L2214-L2218)):

1. `fetchMeiUrl()` ([frontend/src/services/scoreApi.ts:53](../../frontend/src/services/scoreApi.ts#L53))
   calls the **same-origin** route `GET /api/v1/movements/{id}/mei-url`
   ([backend/api/routes/browse.py:142](../../backend/api/routes/browse.py#L142)),
   which returns a presigned URL.
2. `await fetch(url)` goes **cross-origin** to whatever host `R2_ENDPOINT_URL`
   names — for staging, `https://b0c58….r2.cloudflarestorage.com`
   ([fly.toml](../../fly.toml) `[env]`).

Hop 1 succeeds. Hop 2 never establishes a TCP connection, so the browser's
`fetch()` throws `TypeError: Failed to fetch`.

The presigned URL is built against `R2_ENDPOINT_URL` verbatim
([backend/services/object_storage.py:176](../../backend/services/object_storage.py#L176),
client constructed at
[backend/services/object_storage.py:259](../../backend/services/object_storage.py#L259)),
so **every artifact class that goes through `signed_url()` is affected**: MEI,
incipit SVGs, and fragment-preview SVGs. Soundfonts are the sole exception —
they live in the separate public `doppia-soundfonts` bucket on a `pub-*.r2.dev`
hostname, which resolves into a different, reachable prefix.

---

## Evidence

### 1 — The endpoint is unreachable from Orange, at the TCP layer

DNS resolves normally; the connection simply never completes. `conn=0.000000`
means no TCP handshake ever happened, and `remote_ip` comes back empty.

```
b0c58….r2.cloudflarestorage.com → 172.64.66.1, 172.64.190.1

curl -4 https://…/doppia-staging/probe.mei   code=000  conn=0.000000  12s timeout
curl -4 http://…/            (port 80)       code=000  conn=0.000000   8s timeout
```

Both ports, both addresses, fixed line **and** mobile data.

### 2 — It is not DNS

The ISP resolver, Cloudflare's DoH, and Google's DoH all return the identical
pair of addresses. The records are correct; the addresses are unroutable.

| Resolver | Answer |
|---|---|
| Orange (`liveboxfibra`, 192.168.1.1) | `172.64.66.1`, `172.64.190.1` |
| `cloudflare-dns.com/dns-query` | `172.64.66.1`, `172.64.190.1` |
| `dns.google/resolve` | `172.64.66.1`, `172.64.190.1` |

Changing DNS servers does not help, and no DNS-level workaround exists.

### 3 — It is not Cloudflare-wide, and not R2-specific

TCP:443 connect tests from the affected network, same moment:

| Address | Host | Result |
|---|---|---|
| `172.64.66.1` | R2 S3 endpoint | **dead** |
| `172.64.190.1` | R2 S3 endpoint | **dead** |
| `172.64.128.1` | Cloudflare | **dead** |
| `188.114.97.5` | `check-host.net` (Cloudflare) | **dead** |
| `172.64.41.3` | Cloudflare | connects, 15 ms |
| `172.64.80.1` | Cloudflare | connects, 16 ms |
| `104.18.50.34` | `pub-*.r2.dev` soundfonts | connects, 16 ms — HTTP 200 |
| `104.19.193.29` | `api.cloudflare.com` | connects — HTTP 400 |

A subset of Cloudflare's anycast prefixes is unreachable while others in the
same `/13` are fine. R2's S3 endpoint happens to sit in an affected one. No
Cloudflare account, bucket, or CORS setting is involved.

### 4 — The traffic dies inside Orange's own network

Identical paths for six hops, then divergence. `193.251.x` is Orange France's
backbone (AS3215), which the Spanish access network transits.

| Hop | → `104.18.50.34` (works) | → `172.64.66.1` (dead) |
|---|---|---|
| 1 | `192.168.1.1` | `192.168.1.1` |
| 3–4 | `10.255.108.145` → `10.255.108.133` | identical |
| 5–6 | `10.34.143.37` → `10.34.133.77`, 16 ms | identical, 17 ms |
| 9–11 | `193.251.247.13` → `193.251.129.16` → `193.251.150.8` | `*` |
| 12–13 | `188.114.108.67` → **`104.18.50.34`**, 17 ms | `*` through hop 15 |

Packets to the R2 endpoint never leave Orange's internal core — they never
reach the `193.251.x` backbone, let alone Cloudflare.

### 5 — The endpoint is healthy from outside Orange

Probed from our own Fly machine in `lhr`, which is the decisive control:

```
172.64.66.1    TCP OPEN  0.006 s
172.64.190.1   TCP OPEN  0.001 s
HTTP response received: 403  -> endpoint is UP
```

`403` is the correct R2 response to an unsigned request. The service is fine.

> **Note on the mobile-data test.** Loading staging over mobile data also
> failed. That is *consistent* with this diagnosis, not evidence against it:
> Orange's fixed and mobile networks share the same AS and transit, so both
> paths hit the same missing route. Testing over mobile on the same carrier is
> not an independent vantage point — the Fly machine is.

### 6 — Re-probe on 2026-08-30: partial restoration, not a full recovery

The same probe battery, run from the same Orange fixed line one day later:

| Address | Host | 2026-08-29 | 2026-08-30 |
|---|---|---|---|
| `172.64.66.1` | R2 S3 endpoint | dead | **connects, 76 ms** |
| `172.64.190.1` | R2 S3 endpoint | dead | **connects, 15 ms** |
| `172.64.128.1` | Cloudflare | dead | **still dead** (8 s timeout) |
| `188.114.97.5` | `check-host.net` (Cloudflare) | dead | connects, 15 ms |
| `104.18.50.34` | `pub-*.r2.dev` soundfonts | connects | connects, 16 ms |

An unsigned HTTPS request to the R2 hostname now returns `400` with a 39 ms
connect — the endpoint is up, and score loading works again without WARP. But
`172.64.128.1` remains unroutable, so the hole in Orange's routing of
Cloudflare's `172.64.0.0/13` space has only partially healed. The R2 prefixes
happen to be routed again today. **Treat this as ongoing instability with a
real chance of recurrence, not a resolved one-off.**

---

## Exposure assessment — second opinion, 2026-08-30

How frequent and how problematic are two different questions, with opposite
answers:

- **Frequency: low, but not negligible.** ISP-level failures to route a subset
  of Cloudflare's anycast prefixes are a known, recurring class of incident in
  Europe (peering and route-announcement friction with large incumbents,
  Orange included, has history). They are sporadic and usually resolve in
  hours to days — consistent with §6. The proposal's claim that this "will hit
  real users on other ISPs" is a projection; the honest statement is that it
  *can*, at a low base rate. When it does, it is not a tail-of-the-tail event:
  Orange España alone is roughly a quarter of Spanish broadband.
- **Severity: total, and invisible to us.** While active, the core surface
  (every score, every thumbnail) is dead with an opaque `Failed to fetch`, and
  the app can neither detect nor recover. Critically, the failure is
  **vantage-dependent**: staging looks perfectly healthy from Fly and from any
  uptime checker. Server-side monitoring can never see this failure class —
  only client-side telemetry can.

Current blast radius: one developer, on an internal-only staging, with a
working workaround. Real exposure, zero urgency.

### Next-occurrence playbook

The 2026-08-29 evidence took an evening to gather; the next occurrence should
take minutes.

1. **Capture.** Timestamp it and run the probe battery: curl the R2 hostname,
   TCP-connect the five reference addresses in §6, traceroute one working and
   one dead address. (Short-term follow-up: script this.)
2. **Get an independent vantage inside Orange.** RIPE Atlas has probes in
   Orange España's AS; a measurement toward `172.64.66.1` distinguishes an
   Orange-wide routing hole from a single-line problem — the one axis the
   original investigation could not resolve (mobile data shares the same AS,
   see the note under §5).
3. **Confirm from outside.** The Fly machine remains the decisive control (§5).
4. **Work around.** WARP, immediately (§ Temporary fix).

---

## Red herrings

Both signals that prompted the investigation are unrelated to the failure.
Recording them so the next occurrence is not misread.

**Fly Doctor: "App is not listening to the expected port … internal_port 8000."**
False positive caused by scale-to-zero. [fly.toml](../../fly.toml) sets
`auto_stop_machines = true` with `min_machines_running = 0`, so Doctor probes a
**stopped** machine. `fly status` confirmed `STATE: stopped` with `1 warning`.
Measured behaviour: first request `200` in **14.1–14.3 s** (cold boot), then
`200` in **0.15 / 0.17 / 0.27 s** warm. The app binds `0.0.0.0:8000` correctly.

Related but separate: the health check's `grace_period` was `10s`, shorter than
the measured ~14 s cold boot, which made the check fail on every wake and fed
Doctor's complaint. **Raised to `30s` in [fly.toml](../../fly.toml) and
deployed on 2026-08-29.** Note that this fixes the flapping check and the
`1 warning` on `fly status`; Fly Doctor may still report the port warning,
because with `min_machines_running = 0` it can continue to probe a stopped
machine. That remaining warning is benign.

**Neo4j: `Neo.ClientNotification.Statement.FeatureDeprecationWarning`.**
Log noise, `severity: WARNING`, emitted at `level: info`. It reports the scoped
`CALL` syntax change (`CALL { WITH c` → `CALL (c) {`) for the `hierarchy_path`
subquery at
[backend/graph/queries/concepts.py:190](../../backend/graph/queries/concepts.py#L190)
and
[backend/graph/queries/concepts.py:438](../../backend/graph/queries/concepts.py#L438).
Worth a cheap cleanup; unrelated to this incident.

**Supabase / Component 12.** Considered and ruled out. The failure occurs
*after* a successful authenticated API call, and unshipped local changes cannot
affect a running deploy.

**CORS and CSP.** Both correct. The CSP served by staging already permits the
host — `connect-src 'self' https://*.r2.cloudflarestorage.com https://*.r2.dev`
([backend/api/middleware/security_headers.py:48](../../backend/api/middleware/security_headers.py#L48)).
A CORS or CSP rejection produces a console violation and an HTTP-level failure,
not a dropped SYN.

---

## Temporary fix — in place

**Cloudflare WARP** (the free 1.1.1.1 client) resolves the symptom immediately
and completely. It tunnels traffic into Cloudflare's edge, bypassing the missing
Orange route. Verified working by Francisco on 2026-08-29.

Any VPN achieves the same; WARP is simply the lightest option. Switching DNS
does **not** work (see § 2).

**Reporting upstream.** The higher-value channel is Cloudflare, not Orange:
their NOC chases peering complaints and has a relationship with Orange. Post the
§ 3 / § 4 evidence to `community.cloudflare.com` under Network/Peering. For
Orange, skip phone support and use `comunidad.orange.es` or `@Orange_es_Ayuda`,
asking explicitly for an *"escalado a incidencia de enrutamiento"* — otherwise
it gets triaged as a modem reboot.

---

## Proposed durable solution — NOT implemented, needs a decision

The workaround fixes one developer's machine. The underlying exposure remains:
**a client can only view a score if its own ISP can route to
`r2.cloudflarestorage.com`.** That is a hard dependency on third-party network
reachability for the product's core surface, and it will hit real users on other
ISPs. Nothing in the application can detect or recover from it today — the
failure surfaces as a bare "Failed to fetch".

### Proposal — stream R2 artifacts through the backend

Add backend routes that read from R2 server-side and stream to the client, so
the browser only ever talks to the app's own origin. The building block already
exists: `StorageClient.get_mei()`
([backend/services/object_storage.py:143](../../backend/services/object_storage.py#L143)),
and the Fly machine reaches R2 without trouble (§ 5).

Scope: the three artifact classes that go through `signed_url()` — MEI, incipit
SVGs, fragment-preview SVGs. Each new route carries the same role gate as the
`-url` route it replaces (`require_role(EDITOR, ADMIN)` for MEI).

**What it buys**

- Removes the client-side dependency on R2 being routable, for every user.
- Same-origin: no CORS, and `connect-src` can drop `*.r2.cloudflarestorage.com`.
- Failures become real HTTP statuses inside the error envelope, not opaque
  network errors — so they are diagnosable and translatable.
- Better security posture: `require_role()` is re-checked on every fetch and
  access is instantly revocable, replacing hour-long bearer-capability URLs
  (a presigned URL grants access to whoever holds it until it expires).
- Better browser caching is *possible*, not lost. Presigned URLs are unique
  per call — the signature covers the request time
  ([backend/services/object_storage.py:181-187](../../backend/services/object_storage.py#L181-L187))
  — so today the browser cache gets a fresh URL every page view and can reuse
  nothing. A stable proxy URL plus `ETag`/`Cache-Control` caches strictly
  better. (This corrects the 2026-08-29 draft, which listed free caching as
  something the proxy would forfeit.)

**What it costs**

- All artifact egress moves through Fly, on a 512 MB shared-CPU VM.
- Egress economics shift: R2→browser egress is free — a stated reason ADR-002
  chose R2 — while Fly→browser outbound is metered above Fly's allowance.
  Negligible at Phase-1 volume, but it erodes an ADR-002 rationale and belongs
  in the ADR text.
- Incipit SVGs are the volume concern, not MEI: the browse grid requests many
  per page view.
- Adds a hop to every artifact fetch and forfeits R2's edge proximity. (No new
  cold-start cost, though: the `-url` call already wakes the scaled-to-zero
  machine today.)
- Needs the explicit `ETag` / `Cache-Control` handling described above, and a
  streaming response rather than buffering bodies in memory on the 512 MB VM.

### Conflicts to resolve before writing code

1. **ADR-002** establishes the store-the-key, presign-at-request-time model.
   This proposal does not discard it — object keys remain canonical, and
   presigning stays available for backend-to-backend use — but it does change
   how artifacts reach the browser. Needs an ADR amendment or a new ADR.
2. [docs/architecture/security-model.md](../architecture/security-model.md)
   § 4 (signed URL lifecycle) and § "R2 and CORS" both describe the current
   model and would need updating in the same commit.
3. [docs/deployment.md](../deployment.md) § 3 documents the bucket CORS policy
   as a required setup step; it becomes unnecessary for the private bucket.

### Alternatives considered

| Option | Verdict |
|---|---|
| **R2 custom domain** (e.g. `assets.doppia.app`) | **Rejected.** Custom domains serve objects publicly and do not honour S3 presigned signatures. It would make the private bucket public — unacceptable. Still the right answer for the *public* soundfonts bucket, as [docs/deployment.md](../deployment.md) § 4 already recommends. |
| **Cloudflare Worker on a custom domain**, implementing its own signed-token auth in front of R2 | Viable and keeps egress off Fly, but adds a third deployment target and a bespoke auth scheme to maintain. Disproportionate for Phase 1. |
| **Presigned-first, proxy on fallback** — try R2 directly, retry through the backend when the fetch throws | **Rejected** (2026-08-30 review; the 08-29 draft left it open). Every affected client pays a multi-second timeout on every score load before the fallback fires, and it puts two code paths on the product's core fetch — a standing correctness tax for a rare event. |
| **Do nothing** | Defensible only while staging is internal-only and every user can be told to install WARP. Not defensible once there are external users. |

### Recommendation

Take the full proxy for **MEI only** first — it is the surface that actually
broke, it is one request per score load, and its egress cost is negligible.
Decide on incipit and preview SVGs separately once there is a real measurement
of browse-grid volume. Neither should be written before the ADR question in (1)
is settled.

The 2026-08-30 second opinion **agrees with the direction but decouples the
urgency**: with staging internal-only, the incident (partially) recovered, and
WARP covering the one affected developer, nothing is on fire. The unconditional
short-term items below are worth doing now regardless of the ADR outcome; the
proxy decision itself can wait for a natural slot rather than interrupting
Component 12. On ADR shape: prefer a **new ADR referencing ADR-002** over an
amendment — the store-the-key model survives intact (keys stay canonical,
presigning stays for backend use); only browser delivery changes.

---

## Follow-ups

### Short term — unconditional, no decision needed

- [ ] **Frontend failure discriminator + specific message.** When an artifact
      fetch throws `TypeError`, fire a canary fetch to the public
      `pub-*.r2.dev` soundfont host. Private-dead-but-public-alive is this
      failure's fingerprint (§ Symptom): show "your network can't reach our
      storage provider" instead of the raw `Failed to fetch`, and log the
      event. This is the only telemetry that can see this failure class
      (§ Exposure assessment) and it pays off whatever the ADR decides.
- [ ] **Repeatable probe script** implementing step 1 of the next-occurrence
      playbook, so the next capture takes minutes, not an evening.
- [ ] Optional: report upstream on `community.cloudflare.com`
      (Network/Peering) with the §3/§4/§6 evidence — see § Temporary fix.
- [ ] Optional cleanup: scoped `CALL (c) {` syntax in
      [backend/graph/queries/concepts.py](../../backend/graph/queries/concepts.py).
- [x] Raise health-check `grace_period` from `10s` to `30s` in
      [fly.toml](../../fly.toml) — done and deployed, 2026-08-29.

### Long term — decision-gated

- [ ] **ADR decision on the MEI proxy.** Recommendation: accept, as a new ADR
      referencing ADR-002. Write the ADR before any code; schedule at a
      natural slot (post-Component-12), since WARP covers the current exposure.
- [ ] **Incipit / fragment-preview SVG delivery.** Decide separately, only
      after measuring real browse-grid volume; until then they stay on
      presigned URLs.
