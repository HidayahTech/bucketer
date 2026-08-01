# Large downloads — handoff

**Written:** 2026-07-31 · **Branch:** `download-manager-stage1` (cut from `vault-phase2`)
**State header updated 2026-08-01:** v1.43.0 is committed, tagged and **pushed**
(`a1cf110`); the v1.44.0 implementation is parked on `wip/v1.44.0-archived-verify`
(DO NOT SHIP — defects F3–F7). The original header here ("nine commits, v1.42.1, nothing
pushed") described the 2026-07-31 morning state and went stale the same day.

**Read `docs/postmortem-2026-07-31/independent-analysis-2026-08-01.md` before acting on
anything below** — v1.43.0 ships two critical download defects (F1: CSP `frame-src`
blocks http endpoints; F2: iframe src race loses files at TTFB > 250 ms), and the
recovery plan supersedes parts of this document's task list.

Then read `docs/review-download-parity/` (the measurements) and
`docs/superpowers/specs/2026-07-30-large-download-manager-design.md` (the design).

---

## 1. Why this exists

Real users on slow, unreliable connections need to pull hundreds of GB to more than a TB out of
their buckets, stopping and resuming **across multiple sessions**. Some are non-technical; some
would run a CLI command.

> A resume window has **never been specified**. It matters: Safari deletes site data after seven
> days without a visit. If sessions are hours or days apart that is a footnote; if a job may sit
> for a month it disqualifies Safari from the staged mechanism. Ask before designing around it.
> (An earlier draft invented "two weeks" and reasoned from it — don't repeat that.)

---

## 2. What actually ships today

| Version | What a user can do |
|---|---|
| 1.40.0 | **Download with a transfer tool…** — generates an rclone remote + `rclone copy`, and an `aws s3 sync` equivalent, for the current folder. Carries credentials, never presigned URLs. |
| 1.41.0 | **Download this folder…** — enumerates the folder, shows count and size before committing, hands files to the browser's download manager, remembers what it sent, resumes across sessions. |
| 1.41.1 | Filenames survive (BUG-049); download URLs live 7 days so the browser's own resume works. |
| 1.42.0 | Capability detection; the panel names the mechanism and warns on phones. |
| 1.42.1 | Listing can be stopped; a run with failures keeps its manifest and retries just those files. |

**Not built:** the managed-folder tier, the staged tier, the sink seam, the chunked Range
transport, read-only folder verification.

---

## 3. Decisions already made, with the evidence

Do not re-litigate these without new evidence. Each cost real work.

| Decision | Why |
|---|---|
| **Private origin storage is the staging mechanism** | Measured flat: 22–92 MiB (Chromium) and 15–25 MiB (Firefox) for files from 64 MiB to 2 GiB. Holding in memory costs 1.00× the file on Chromium, 1.62× on Firefox. O(1) vs O(n). |
| **Keep the browser-handoff tier** | It is the only mechanism with no size ceiling, because the app never holds the file. Required for the largest jobs everywhere, and the only option at all off Chromium. |
| **Keep the single-file architecture** | Background Fetch needs a service worker. Safari/iOS gain nothing from it; Firefox's equivalent has an open defect reporting *success on a truncated file*; Chromium already has a better option needing no second script. |
| **Per-chunk presigning** | Measured 0.30 ms (Chromium), ≤1 ms (Firefox). All 256 chunks of a 2 GiB file cost 77 ms. Affordable, so prefer it — no long-lived URL ever exists. |
| **Long expiry for handoff URLs** | Opposite of the above, same reason. The browser's own resume re-requests the *original* URL, so a short expiry turns a recoverable interruption into a permanent 403 the app cannot see. Both constants are deliberate; don't "harmonise" them. |
| **Capability by feature detection, never browser name** | Names are trivially faked; caniuse is currently *wrong* about Chrome for Android's folder access, which shipped in M132. |
| **Credentials in the CLI handoff, never presigned URLs** | A URL bundle is an unrevocable bearer token valid up to 7 days. Credentials are revocable by key rotation. |
| **No IndexedDB staging, no in-memory staging** | Both measured at ~1× the file or worse. Strictly dominated by private storage. |

---

## 4. The immediate open decision

A queued download must never be able to navigate the page away. **Measured in all three
engines:** an anchor pointed at an error response (403/404) navigates the top frame, destroying
the app mid-job. A single reused hidden iframe downloads correctly *and* contains the error —
10 sequential downloads, 1 iframe, recovers after an error, page never navigates.

Proposed, awaiting a decision on scope:

1. **One reused hidden iframe** — replaces the per-file anchor in `src/lib/download-issue.js`.
   Fixes the defect, cheaper than today. *No open questions.*
2. **Storage-class flag at enumeration** — AWS only, `GLACIER` and `DEEP_ARCHIVE` only. Free: the
   field is already in the listing. **Do not flag `GLACIER_IR`** (serves GETs directly) and do not
   attempt Intelligent-Tiering: AWS keeps the class as `INTELLIGENT_TIERING` whatever the internal
   tier, so the listing cannot tell a readable object from an archived one. No other provider has a
   tier where a GET fails.
3. **One pre-flight before the first file, then periodic sampling** (~20 requests, not 3,800) —
   catches job-wide failures: bad credentials, CORS, clock skew, a wholesale deny. Use a
   `Range: bytes=0-0` fetch on the exact presigned URL: CORS-safelisted, so no preflight round trip.
4. **Read-only folder verification afterwards** — stats the downloads folder for per-file truth at
   zero request cost. Better than exhaustive pre-flighting, which still cannot guarantee the
   subsequent download succeeds.

Known gap in that plan: on Firefox and Safari, per-file failures stay unreported until the staged
tier exists. Files simply do not arrive.

---

## 5. Then: the sink seam (tasks #6, #7)

The measurement collapsed two features into one. **Tier 1 and Tier 2 differ only in which sink
they write to** — transport, resume, progress, verification and cancellation are all shared.

```js
open(destPath) -> { existingBytes }   // read from disk; never trust a recorded counter
writeAt(offset, bytes)                // explicit offset; may be called out of order
close()                               // leaves a valid resumable partial, never a corrupt one
abort()                               // discard (integrity failure only, not pause)
```

Build `MemorySink` first so the engine is provable in plain Node. Then `FsaSink` (Chromium: real
folder tree, byte resume, no quota) and `OpfsSink` (Chromium + Firefox: flat files, bounded by
quota **per largest single file**, not per job).

Transport: raw `fetch(url, { headers: { Range } })` against a per-chunk presigned URL. **Never**
`client.send(GetObjectCommand)` for chunk bytes — that attaches `Authorization` and `x-amz-*`,
which are not CORS-safelisted, adding an `OPTIONS` preflight to *every chunk*. This is the single
easiest way to destroy the design's performance without noticing.

The mock now supports everything needed to test it: `Accept-Ranges`, `Content-Range`, suffix
ranges, 416, `If-Match` → 412, `If-Range`, `503 SlowDown`, and a `killAtByte` fault that drops the
socket mid-body (deliberately not an error status — a dropped connection and an error response
exercise different client paths).

---

## 6. Only you can answer these

- **Real Safari (macOS and iOS).** Does private-storage export cost what it costs elsewhere? **No
  published source anywhere measures this** — the design's Safari case rests on it. Playwright
  cannot drive real Safari; its WebKit lacks the entire storage API, which is why the automated
  runs prove nothing about Safari.
- **Real Android.** Is Chrome's folder picker usable, or do the M132 launch defects persist
  (picker freezing on large folders, save being overwrite-only)? Serve
  `docs/review-download-parity/probe/mobile-probe.html` over HTTPS and open it on the device; it
  reports the automated part and prompts for the two observations only a person can make.
- **The resume window** (§1).
- **Stage 1's rclone output has never been run through a real `rclone`.**

---

## 7. Process note worth carrying forward

**Four real bugs this session were found by running things, not by tests** — a regex with literal
control bytes that blanked the app in the bundle (BUG-048), percent-encoded filenames on disk
(BUG-049, live in production), an IndexedDB transaction auto-committing a partial page, and the
navigation defect above. All four passed a fully green suite.

Two measurement conclusions were also confidently wrong until the *actual operation* was measured
rather than a proxy: reading bytes back through `fetch()` reported Firefox's cost at 2177 MiB where
a real download costs 6 MiB — a 360× error. Five of seven recorded measurement faults share that
shape. A proxy that is easy to measure will return a precise, stable, reproducible number for the
wrong thing.

Weight accordingly: the sink work has more surface than anything so far.

---

## 8. Files worth knowing

| Path | What |
|---|---|
| `docs/review-download-parity/README.md` | How to rebuild the report and re-run every measurement |
| `docs/review-download-parity/doc/` | doclab source for the PDF |
| `docs/review-download-parity/probe/` | The measurement harnesses, all re-runnable |
| `docs/superpowers/specs/2026-07-30-large-download-manager-design.md` | The design |
| `src/lib/browser-capability.js` | Tier vocabulary and feature detection |
| `src/lib/download-{records,manifest,naming,queue,issue}.js` | The shipped worklist |
| `src/lib/crawl-prefix.js` | Streaming crawler — also the roadmap Phase 2 / Epic #6 primitive. **Not yet adopted by delete/move/dedup**; that is a deliberate follow-up, not an oversight. |

Untracked and deliberately not committed: `docs/review-download-parity/browser-capability-report.md`
(superseded markdown holding four withdrawn figures — delete it if you agree) and
`probe/results-sweep.json` (data from a broken-methodology run).
