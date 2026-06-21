# Bucketer — "Next-Level Utility" Review & Roadmap (v1.26.3)

*Authored 2026-06-21. Companion tracker: GitLab milestones + epics #5–#11 (see [Tracker map](#gitlab-tracker-map)).*

## Context

Bucketer is a browser-based, single-page S3-compatible object manager (Preact + esbuild,
shipped as one self-contained `dist/index.html`). This review is a full-app expert pass for changes
that raise real utility **without** drifting into absurdity, staying grounded in four pillars:

1. **Single-page HTML** — one inlined file, no backend, no external scripts/CDNs.
2. **Server-is-blind** — the host never sees user actions; all S3 calls go browser→bucket,
   signed in-browser; shareable state lives in the URL hash (never sent to the server).
3. **Privacy & security** — no telemetry; secret key in `sessionStorage` only; nothing leaves
   the browser except signatures to the user's own S3 endpoint.
4. **S3 bucket-focused object management** — manage *objects in a bucket*, not a cloud admin console.

**Method:** three parallel read-only explorations (feature/UX inventory; architecture/privacy/security;
S3-domain coverage), a strategy synthesis, then direct code verification of every high-stakes claim.

## Executive summary

Bucketer is already a remarkably complete single-purpose tool: multipart upload with crash-resumable
state, copy-then-delete move (incl. >5 GiB via `UploadPartCopy`), read-only duplicate detection with
byte-for-byte verification, a versioning panel, presigned share links with a credential-free download
page, build-integrity verification, and a clean lazy-capability permission model — all server-blind.

The biggest *utility* gaps are **recursive/full-bucket search** and **finishing dedup iteration 2**.
The biggest *correctness* risks are **memory blowup on huge prefixes** (the collision/scan crawlers buffer
the entire prefix into memory) and **non-resumable large moves**. The cheapest *privacy* win is a
**`Referrer-Policy` meta tag** (confirmed missing). The most on-mission *capability* expansion is
**object tagging + editable metadata** (the Properties modal is already half-built for it).

Everything in Phases 1–3 respects all four pillars. Only Phase 4 (folder-zip download, optional
client-side encryption, cold-storage restore) touches a pillar, and each is opt-in with the tension stated.
A short list of ideas is explicitly **declined** as pillar-breaking overreach.

## Already shipped — do NOT re-fund (verified in code)

- **New Folder button** — `Browser.jsx:983` (`+ New folder`, `handleCreateFolder`).
- **Select All (tri-state header checkbox)** — `Browser.jsx:377` `toggleSelectAll`, `:1058`.
- **Filter reset on navigation** — `Browser.jsx:252` `setFilterQuery('')`.
- **Three-way empty state** — `Browser.jsx:1048` (filter-zero / empty-bucket / empty-prefix).
- **Custom presigned expiry input** — `CopyLinkPopover.jsx:12-64` (value + unit, 7-day cap).
- **Dark color scheme** — `main.css:32` `@media (prefers-color-scheme: dark)` exists… but **no manual toggle**.

## A. Broken / correctness risks (triaged, verified)

| Sev | Issue | Evidence | Fix direction | Tracker |
|----|-------|----------|---------------|---------|
| **High** | **Memory blowup on huge prefixes.** Move/delete/dedup buffer an entire prefix's keys into an array + `Set` before acting → OOM on very large prefixes. | `move-queue.js:26-35,88`; same pattern in `delete-queue.js`, `dedup-scan.js` | Stream each `ListObjectsV2` page; bounded membership. Fold into shared crawler. | #20 #21 #22 |
| **High** | **Large multipart MOVE is not resume-aware.** A >5 GiB move that fails at 90% restarts at part 1. | `move-multipart.js:30` builds `partNumbers` fresh, no `ListParts` | Port the upload resume pattern (`ListParts` reconciliation). | #36 |
| **Med** | **No conditional writes (If-Match) on rename/move.** Read-then-copy-then-delete with no guard. | `grep IfMatch` → zero matches in `src/` | `CopySourceIfMatch` + gate post-copy delete on source match. | #35 |
| **Med** | **Continuation-token staleness on long sessions.** Surfaces as an opaque "Load more" error. | `Browser.jsx:315`, cache `:241` | Transparent re-list from the start on failure. | #23 |
| **Low** | **Presigned preview/share URLs can persist in the browser disk cache.** | `CopyLinkPopover.jsx:26-30` | `ResponseCacheControl: 'no-store'` on those presigns. | #13 |

## B. Quick wins (high value / low effort)

- **`Referrer-Policy` meta tag** (`#12`) — confirmed missing; most actionable in-app privacy fix. **Do first.**
- **Manual dark-mode toggle** (`#14`) — vars + media query exist; add a persisted `data-theme` override.
- **Success toasts** (`#15`) — no success feedback today.
- **Copy-and-keep ("Copy to…")** (`#17`) — move path minus the delete; reuses `MovePickerModal`.
- **Folder rename** (`#18`) — a move where dest = sibling prefix with a new name.
- **Keyboard shortcuts** (`#16`) — `/` focus filter, Ctrl/⌘-A select-all, Del delete.
- **`no-store` on presigned preview/share** (`#13`) — pairs with the Low-sev cache fix.

## C. Next-level opportunities (ranked)

1. **Full-bucket / recursive search** (`#7` → #24 #25 #26). The single biggest utility gap. List *without*
   `Delimiter`, stream results, match substring + glob. **M.** Highest utility-per-effort.
2. **Finish dedup iteration 2, safely** (`#8` → #27 #28 #29 #30). Engine is done; add verified-only
   "keep oldest, delete the rest." Never delete on hash-match alone. **M.**
3. **Object tagging + editable metadata + storage-class** (`#9` → #31 #32 #33 #34). Properties modal is
   half-built for it; squarely object management. **M.**
4. **Resumable + memory-bounded bulk operations** (`#6`/`#10`). Folds the two High-sev fixes; the line
   between toy and tool. **M–L.**
5. **Conditional writes (If-Match)** (#35). Correctness; small surface, real data-safety gain. **S–M.**

**Cross-cutting refactor:** unify the three prefix crawlers into one streaming
`crawlPrefix(client, bucket, prefix, { onBatch })` (`#19`) — search and the streaming collision-scan both
consume it. Do it *before* search/scan work.

## E. S3 capability expansions — on-mission vs scope-creep

| Capability | Verdict | Reasoning (pillar-4 lens) |
|---|---|---|
| Object tagging (`*ObjectTagging`) | **INCLUDE** (#31) | Pure object management; Properties modal half-built. |
| Editable user-metadata / content-type | **INCLUDE** (#32) | Object-level; reuse rename copy-replace path. |
| Storage-class change | **INCLUDE (small)** (#33) | Already displayed; per-object CopyObject. |
| SSE-S3 toggle on upload | **INCLUDE** (#34) | One header. Defer KMS; **decline SSE-C**. |
| `RestoreObject` (cold-storage thaw) | **INCLUDE (later, opt-in)** (#39) | Restoring to read = object management. |
| Conditional requests (If-Match) | **INCLUDE** (#35) | Correctness. |
| ACL / public-read toggle | **DEFER (display-only first)** | Many buckets disable ACLs; write nudges toward footguns. |
| Object Lock / retention / legal-hold | **DECLINE** (#40) | Governance config = bucket admin. |
| Lifecycle rules | **DECLINE** (#40) | Bucket administration. |
| Bucket list / create / cross-bucket admin | **DECLINE console; consider narrow same-creds copy** (#40) | Admin console = pillar 4. |
| Presigned-URL revoke | **DECLINE** (#40) | Impossible without admin (key rotation / bucket policy). |

## F. Ideas that challenge the grounding pillars (opt-in tradeoffs)

Each is **opt-in, never default.**

- **(A) Streaming folder-as-ZIP** (#37). *Unlocks* "download a folder as one file." *Tension:* the
  600 KB bundle ceiling. *Pursue* with a streaming writer (File System Access API) so nothing fully buffers.
- **(B) Service Worker → PWA.** *Breaks* pillar 1 (second served artifact). **Decline as default;** opt-in
  build variant only. (#40)
- **(C) Client-side encryption before upload** (#38). *Aligned* with pillar 3; *cost* is key-management
  footgun. **Opt-in, experimental.**
- **(D) Server-side relay / short-link.** *Breaks* pillar 2 hard. **Decline** — the guardrail. (#40)

## Phased roadmap

- **Phase 1 — Privacy & Polish** (milestone): Referrer-Policy; `no-store`; dark-mode toggle; toasts;
  shortcuts; copy-and-keep; folder rename. *Close cheap privacy + UX gaps.*  → Epic #5
- **Phase 2 — Scale & Search** (milestone): unify crawlers; recursive search with glob; streaming
  collision/delete/dedup scans (High-sev memory fix). *Manage large buckets; find anything.* → Epics #6, #7
- **Phase 3 — Object Mastery** (milestone): dedup iteration 2; tagging + metadata + storage-class;
  SSE-S3; If-Match; resumable large moves. *Complete, safe per-object lifecycle.* → Epics #8, #9, #10
- **Phase 4 — Opt-in Power Features** (milestone): folder-ZIP; client-side encryption; RestoreObject.
  *Differentiated capability without compromising any pillar by default.* → Epic #11

**Declined as overreach** (#40): lifecycle rules, object-lock config, bucket-admin console,
presigned-URL revoke, default service-worker/PWA, server-side relay/short-link.

## GitLab tracker map

Tracker on [`hidayahtech/bucketer`](https://gitlab.com/hidayahtech/bucketer). GitLab Free has no native
Epics/blocking-links/weights, so epics are emulated as `kind::epic` tracking issues with task lists,
children linked via "relates to", sized with `effort::*` labels, and grouped by **milestones** (the phases).

| Epic | Children | Milestone |
|---|---|---|
| #5 Privacy & Polish quick wins | #12 #13 #14 #15 #16 #17 #18 | Phase 1 |
| #6 Streaming crawler & bounded-memory bulk ops | #19 #20 #21 #22 #23 | Phase 2 |
| #7 Full-bucket recursive search *(relates to #6)* | #24 #25 #26 | Phase 2 |
| #8 Dedup iteration 2 (safe destructive actions) | #27 #28 #29 #30 | Phase 3 |
| #9 Object mastery — tagging/metadata/storage class | #31 #32 #33 #34 | Phase 3 |
| #10 Write-safety: If-Match & resumable large moves | #35 #36 | Phase 3 |
| #11 Opt-in power features (pillar-tension) | #37 #38 #39 | Phase 4 |
| #40 [Docs] Non-goals / Declined scope | — | — |

**Label taxonomy:** `kind::{epic,feature,enhancement,bug,refactor,security,docs,chore}` ·
`area::{search,upload,move,delete,dedup,s3-api,privacy,ui-ux,build,sharing}` ·
`priority::{high,medium,low}` · `effort::{S,M,L}` · `pillar::tension` ·
`status::{needs-repro,declined}`.

**Existing bug reports** folded into the taxonomy under the *Maintenance & Bug Triage* milestone:
#1, #2, #4 (`kind::bug`; already closed — fixed via BUG-030/031/032) and #3 (open, `status::needs-repro`).
