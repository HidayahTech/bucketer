# Connection Diagnostics — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorming session 2026-07-26)

## Problem

When a request is blocked before producing an HTTP response, the browser hands the
AWS SDK a bare `TypeError` ("NetworkError when attempting to fetch resource." on
Firefox) with zero distinguishing detail — by spec. CORS misconfiguration, a DNS
typo, an unpropagated new-bucket hostname, mixed content, being offline, and
extension blocking all look identical. `ErrorBlock` currently shows a generic
three-way "may be CORS, or auth, or routing — verify with curl" note, pushing the
diagnosis onto the user.

Passive parsing cannot improve this; the precision must come from gathering new
evidence. Two sources exist: static environment checks (free) and active
`no-cors` probes, which bypass the CORS layer and therefore test raw
reachability independently of CORS configuration.

## Decisions (from brainstorming)

- **Trigger:** explicit **"Run diagnostics"** button — no automatic probe
  traffic; nothing runs until the user clicks.
- **Scope:** every CORS-like `ErrorBlock`, not just the connect screen. Call
  sites opt in via a prop; sites without it render exactly as today.
- **Depth:** Approach A — ordered check list with a single derived verdict
  (chosen over a single-probe message swap and over a full "connection doctor"
  modal, which is YAGNI until this proves insufficient).

## Architecture

### New library: `src/lib/connection-diagnostics.js`

Pure-testable logic separated from I/O, per house pattern.

- `runDiagnostics({ endpoint, bucket, forcePathStyle, fetchFn })` → returns
  `{ checks, verdict }`. `fetchFn` is injectable (defaults to `fetch`) so unit
  tests never touch the network.
- Each check result: `{ id, label, status: 'pass' | 'fail' | 'skip', detail }`.
- Probes are unauthenticated `no-cors` requests with a 5 s `AbortController`
  timeout. No credentials are ever attached.

Checks run in order; once a verdict is determined, later checks are recorded as
`skip`:

| # | Check | Failure verdict | User-facing verdict wording (gist) |
|---|-------|-----------------|------------------------------------|
| 1 | `navigator.onLine` | `offline` | "Your browser reports no network connection." |
| 2 | Page is HTTPS but endpoint is HTTP | `mixed-content` | "Browsers silently block HTTP requests from an HTTPS page. Use an HTTPS endpoint." |
| 3 | Endpoint parses as a valid URL | `bad-endpoint-url` | "The endpoint is not a valid URL." |
| 4 | `no-cors` probe of the endpoint origin | `endpoint-unreachable` | "The endpoint host didn't respond — check the URL for typos. (A blocking browser extension can also cause this.)" |
| 5 | `no-cors` probe of `bucket.<endpoint-host>` — virtual-host style only; `skip` when `forcePathStyle` | `bucket-host-unreachable` | "The endpoint works, but the bucket's hostname doesn't resolve — check the bucket name; for a brand-new bucket, DNS may still be propagating." |
| 6 | All above passed yet the SDK saw a network-shaped `TypeError` | `cors-blocked` | "Your storage responded, but the browser blocked the app's request. This is almost certainly missing or incorrect CORS configuration on the bucket — see the Setup Guide for your provider's exact command." |

Rationale for check 6's confidence: if CORS were configured correctly, even bad
credentials would surface as a readable 403 (`AccessDenied`), not a masked
`TypeError`. Reachable + masked ⇒ the failure is at the CORS layer.

### UI: enhancement inside `ErrorBlock` (no new component file)

`ErrorBlock` gains one optional prop:

```js
diagnostics = { endpoint, bucket, forcePathStyle, fetchFn? }
```

When `diagnostics` is provided **and** the error is CORS-like (existing
`isCorsLike` heuristic), a **"Run diagnostics"** button renders under the
existing masked-error note. Click → "Running…" state → button is replaced by
the check list (✓ / ✗ / – per line) topped by the verdict sentence in bold.

Call sites (threaded from credentials App already holds):

- `App.jsx` connect-screen block (primary case) — form values in hand
- `Browser.jsx` (3 blocks), `HiddenVersions.jsx`, `UploadQueue.jsx` per-item
  errors — threaded via props from App

Omitting the prop keeps today's rendering byte-for-byte.

## Edge cases / honest wording

- An opaque `no-cors` "success" only proves *something* answered at that origin
  (captive portal / proxy false positives possible) → `cors-blocked` says
  "almost certainly", never "definitely".
- Extension blockers (uBlock etc.) reject the probe identically to DNS failure →
  `endpoint-unreachable` wording mentions extensions, consistent with the
  existing `isBlockedByExtension` heuristic in `format.js`.
- Path-style providers (MinIO, forced path-style) record check 5 as `skip`, not
  a false negative.
- Probe rejections and timeouts are treated identically (both mean
  "unreachable from this browser").

## Testing

- **`test/connection-diagnostics.test.js`** (unit, pure Node): every verdict
  reachable via mocked `fetchFn` and `global.navigator`; timeout path;
  path-style skip; check-ordering (later checks marked `skip` after verdict).
- **`test/components/error-block.test.jsx`** (extend, jsdom): button renders
  only when `diagnostics` prop present **and** error is CORS-like; absent prop
  → unchanged output; click → verdict text appears (mock `fetchFn` threaded
  through the prop).

## Versioning

Minor bump (new backwards-compatible user-facing feature) + CHANGELOG entry in
the same commit, with operator confirmation before commit, per house policy.
