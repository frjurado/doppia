# ADR-016 — JWT Browser Storage

**Status:** Accepted
**Date:** 2026-05-04

---

## Context

`frontend/src/services/auth.ts` stores the Supabase access token in `localStorage` under the key `doppia_access_token`. This is the token used on every authenticated API call.

Three storage options were evaluated:

**`localStorage`** — persists across tabs and browser restarts. Accessible from any JavaScript on the same origin. Vulnerable to XSS: if a script can run on the page, it can read `localStorage`. The standard objection.

**`HttpOnly` cookie** — inaccessible from JavaScript; immune to XSS token theft. Requires `SameSite=Strict` or CSRF mitigation, changes the backend to issue and validate cookies rather than bearer tokens, and complicates the local dev bypass (which currently relies on a single `localStorage.setItem` call). Adds meaningful backend surface area in Phase 1 for a threat that does not yet exist.

**In-memory token with silent refresh** — token lives in a closure or React context; disappears on page reload. Requires a refresh-token dance to survive navigations, and Supabase's refresh flow needs the client SDK, which is not wired in Phase 1 (the current `auth.ts` is a thin wrapper, not a full Supabase client).

---

## Decision

Retain `localStorage` for Phase 1.

The reasons this is acceptable **in Phase 1 specifically**:

1. **Internal-only deployment.** The tagging tool has no public URL, no anonymous traffic, and a small, trusted annotator team. There is no adversary with a plausible delivery path for a malicious script.
2. **No third-party content rendering.** The XSS surface that makes `localStorage` dangerous is primarily third-party script injection and user-supplied HTML rendered raw. Phase 1 renders no third-party scripts and no user-supplied HTML (annotations are plain text, rendered via React JSX which escapes by default).
3. **No DOMPurify gap yet.** The blog editor and any `dangerouslySetInnerHTML` paths noted in `security-model.md` are Phase 2 features; they do not exist today.
4. **Complexity cost vs. threat model.** `HttpOnly` cookies require backend changes (Set-Cookie, CSRF tokens, cross-origin cookie policy) that add Phase 1 work with no Phase 1 payoff. In-memory tokens require the full Supabase refresh flow, which is a Phase 2 prerequisite anyway.

---

## Consequences

- `frontend/src/services/auth.ts` stores and reads the token from `localStorage['doppia_access_token']`. No other storage is used.
- **This must be revisited before Phase 2 public launch.** Phase 2 introduces anonymous visitors, public URLs, and potentially user-supplied rich content — the threat model changes materially. Options to evaluate then: migrate to `HttpOnly` cookie (requires backend cooperation), switch to the full Supabase JS client (which manages token storage internally and uses `localStorage` with a refresh token strategy by default), or implement in-memory storage with silent refresh.
- The exception is documented in `docs/architecture/security-model.md` under the signed URL lifecycle section, where the earlier wording implied `localStorage` was forbidden for session data. That paragraph is updated to note this ADR as the recorded exception.

---

## Alternatives rejected

**`HttpOnly` cookie:** Correct long-term direction, but adds backend complexity (Set-Cookie, SameSite, CSRF) that is disproportionate to the Phase 1 threat model.

**In-memory token:** Requires the full Supabase JS client and silent refresh, both Phase 2 work items. Implementing this in Phase 1 would mean building Phase 2 infrastructure early to solve a Phase 1 non-problem.
