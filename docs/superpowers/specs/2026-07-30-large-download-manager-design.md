# Large Download Manager — Design

**Date:** 2026-07-30
**Status:** Approved (brainstorming session 2026-07-30, six-expert panel + direct verification)

## Problem

Real users on slow, unreliable connections need to pull hundreds of GB — up to more
than a TB — out of their buckets. They must be able to stop, close the browser, and
resume across many sessions over days or weeks. The population is mixed: some are
non-technical and have only a browser; some would run a generated CLI command.

Downloading today (`src/components/Browser.jsx:523`) presigns a `GetObject` with
`ResponseContentDisposition: attachment` and clicks a hidden `<a download>`. That was
deliberate — `docs/s3-browser-spec-v0.15.md:141` records the rationale ("works
correctly for objects of any size") — and it is precisely why there is no queue, no
progress, no pause, no resume, no multi-file download, and no verification anywhere
in `src/`. It handles one file and forgets everything the moment it finishes.

`docs/intent/master-queue.md:164` already excluded downloads from the master queue
because "a queue row would be a *lie*", while noting that a streamed folder download
"if ever built, would stream through the app and *would* belong in the master queue".
The roadmap tracks this as Phase 4 / Epic #11 / issue #37
(`docs/review-v1.26.3/next-level-review.md`). This design brings it forward.

## Verified constraints

Each was verified directly during design, not inferred. They drive every decision below.

### 1. No CORS change is required

`Range` is a CORS-safelisted **request** header for non-suffix single ranges
(`bytes=N-M`, `bytes=N-`) — [Fetch spec](https://fetch.spec.whatwg.org/#cors-safelisted-request-header),
fetched 2026-07-30. The spec explicitly excludes suffix forms: *"As web browsers have
historically not emitted ranges such as `bytes=-500` this algorithm does not safelist
them."*

`Content-Length` is in the default CORS-safelisted **response**-header set
(alongside `Cache-Control`, `Content-Language`, `Content-Type`, `Expires`,
`Last-Modified`, `Pragma`), and the HTTP status code is always readable. A chunked
reader therefore never needs `Content-Range` or `Accept-Ranges` — it already knows the
offset it asked for, and it can count the bytes it receives.

**Consequence, and the trap:** this holds only when chunk bytes are fetched with raw
`fetch(url, { headers: { Range } })` against a **presigned URL**. Routing them through
`client.send(new GetObjectCommand(...))` attaches `Authorization`, `x-amz-content-sha256`,
`x-amz-date`, `amz-sdk-invocation-id` and `amz-sdk-request` — none safelisted — adding an
`OPTIONS` preflight to **every chunk**, roughly one extra round trip per 8 MiB on a
300 ms link. The preflight cache does not save this: it is keyed by URL, and a
re-signed URL changes the query string. This must be a commented, deliberate decision
in the transport code.

### 2. `keepExistingData` is an O(n) trap

MDN [`FileSystemFileHandle.createWritable()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable),
fetched 2026-07-30, verbatim: *"When set to `true` if the file exists, the existing file
is first copied to the temporary file."* And: *"Any changes made through the stream won't
be reflected in the file represented by the file handle until the stream has been closed."*

Reopening a 100 GB partial file to append would copy 100 GB before writing one new byte —
on every session. **Resume must use per-chunk files assembled once at the end, never one
growing file.**

The same page documents `mode: 'exclusive'`, which takes a real lock and throws
`NoModificationAllowedError` if a second writer is opened. That is a stronger cross-tab
guard than a localStorage heartbeat, and it is what this design uses. Note the default is
`'siloed'`, where concurrent writers each get their own swap file and **the last one closed
wins** — silent data loss across tabs if left at the default.

### 3. Physics, not architecture, is the ceiling

1 TB at 5 Mbps is ~18.5 days of pure transfer; at 2 Mbps, ~46 days. No browser design
changes this — but neither does rclone. What rclone buys is surviving reboots with no tab
and no permission re-grant. The app must therefore **route** the largest jobs, not compete
for them.

### 4. The native downloader cannot write folders

The `download` attribute strips path separators, so browser-managed downloads land flat
and collide as `file (1).mp4`. Reproducing an S3 prefix tree on disk requires either the
File System Access write path (Chromium desktop only) or a CLI tool.

## Decisions

- **Three stages**, each independently shippable and independently useful.
- **Delivery mode is chosen per job**, at creation time. The app offers only the modes the
  current browser can actually honour.
- **The CLI handoff carries credentials, never presigned URLs.** A bundle of presigned URLs
  is an unrevocable bearer token valid up to seven days, and this project already declined
  presigned-URL revoke as overreach. Credentials are no more sensitive than what the user
  already holds, and they are revocable by key rotation. `aria2c` is therefore not offered —
  it is only useful with a presigned-URL list.
- **The browser-managed tier never displays bytes, a percentage, or an ETA** unless
  read-only folder verification has been granted. This is the `master-queue.md` doctrine
  applied, not re-litigated.
- **The two tiers must not render as the same row.** A "Browser-managed" badge distinguishes
  them at a glance.

| Delivery mode | Availability | Structure | Progress fidelity | Stage |
|---|---|---|---|---|
| CLI job (rclone / aws-cli) | everywhere | real tree | none (external) | 1 |
| Browser-managed | everywhere | flat (+ optional rename script) | files issued; verified counts only with a read-only folder handle | 2 |
| Managed folder | Chromium desktop | real tree | real bytes, ETA, byte-range resume | 3 |

## Architecture

### Stage 1 — CLI handoff

`src/components/TransferHandoff.jsx`, shaped like the existing per-provider `SetupGuide`
panels. Emits an `rclone.conf` remote stanza plus `rclone copy remote:bucket/prefix ./local
--progress --transfers 4 --checkers 8 --retries 99 --low-level-retries 20`, and an
`aws s3 sync --endpoint-url` equivalent. Provider specifics reuse `buildEndpoint`,
`extractRegion` and `requiresPathStyle` from `src/lib/provider.js`.

Secret redacted by default, with an explicit "include secret" toggle and one line of copy
explaining the trade-off. `README.md` gains a "Large transfers" section, mirroring the
existing ">50 GB uploads are more reliable with native tools" guidance.

### Stage 2 — Download worklist

The bookkeeping half of the problem, solved for every browser: the app remembers what to
fetch and what is done; the browser's own download manager moves the bytes.

| Module | Purpose |
|---|---|
| `src/lib/crawl-prefix.js` | `crawlPrefix(client, bucket, prefix, { onBatch, shouldCancel })` — paginates `ListObjectsV2`, never buffers the whole prefix. This is the Phase 2 / Epic #6 primitive. |
| `src/lib/download-records.js` | IndexedDB `DB_VERSION` 3 → 4, additive. Stores `bucketer_download_jobs` (keyPath `id`) and `bucketer_download_items` (key `${jobId}:${key}`, index `by_job_status` on `[jobId, status]`). |
| `src/lib/download-manifest.js` | Enumerates via `crawlPrefix`, persisting each page **and** the `ContinuationToken` in one IndexedDB transaction, so enumeration itself resumes after a crash. |
| `src/lib/download-naming.js` | Key → local name. Modes `leaf` and `flatten`. Sanitisation is mandatory (see below). |
| `src/lib/download-queue.js` | `runDownloadJob(client, job, { onProgress, shouldCancel, sink })`, matching the engine signature of `delete-queue.js` / `move-queue.js`. |

**Sanitisation is not optional.** The WHATWG fs spec's
[valid file name](https://fs.spec.whatwg.org/#valid-file-name) check (fetched 2026-07-30)
covers only the empty string, `.`, `..` and the path separator, and explicitly leaves
everything else to the OS. `download-naming.js` must additionally handle: control
characters, Windows-illegal characters (`: ? * " < > |`), reserved device names (`CON`,
`PRN`, `NUL`, `AUX`, `COM1`…), trailing dots and spaces, segments over 255 bytes, and NFC
normalisation (APFS stores NFD, so visually identical names can differ byte-wise).

**Storage budget:** ~300 bytes per item record — about 400 MB at 1M objects. Completed jobs
drop their item rows and retain only a summary.

**Master-queue integration:** `createDownloadTask` in `src/lib/queue-tasks.js`, a
`VERBS.download` entry in `src/components/MasterQueue.jsx`, progress routed through the
existing `engineUpdateToPatch(update, 'downloaded')`.

**Pacing:** cap in-flight native downloads at 2–3 with a short delay between issues. Chrome
shows a one-time "download multiple files" permission prompt, which the UI must expect and
explain rather than treat as an error. Large files are presigned with a long expiry so the
browser's *own* resume still works after an interruption.

**Optional verification (Chromium, read-only):** the user may grant a **read-only** directory
handle for their downloads folder; the app then stats each expected filename and confirms
size. Read-only means no write hazards, no `keepExistingData` cost, and no path-traversal
surface. Only with this granted does the row show verified counts rather than issued counts.

### Stage 3 — Managed folder (Chromium streaming writer)

`src/lib/download-sink.js` is the seam that makes the engine testable without a browser:

```js
open(destPath)            // → { existingBytes }  — read from disk, the sole resume truth
writeAt(offset, bytes)    // explicit offset; may be called concurrently and out of order
close()                   // leaves a valid, resumable partial — never a corrupt one
abort()                   // discards the partial (integrity failure only, not pause/cancel)
```

`existingBytes` is read from disk, never from a recorded counter — a counter can lie after a
crash between the write and the record update. Two implementations: `FsaSink` (production)
and `MemorySink` (tests, plain Node).

Supporting modules: `src/lib/fs-dest.js` (picker, handle persisted in IndexedDB,
`queryPermission`/`requestPermission`, nested segment resolution, writables opened with
`mode: 'exclusive'`), `src/lib/download-chunks.js` (chunk plan, write, stat, assemble), and
`src/lib/download-verify.js` (verification tiers).

**Chunk-file layout, mandated by constraint 2:** each chunk is its own file under
`.bucketer-tmp/<jobId>/<hashedKey>/NNNNNN.part`, written and `close()`d individually. A
single assembly pass concatenates them into the final name and deletes the parts. A crash
costs one chunk, not the file, and no session pays an O(n) copy.

**Transfer policy** — deliberately the *opposite* of the upload path's 16-stream budget,
because this is the low-BDP regime:

| Parameter | Value |
|---|---|
| Auth | one presigned URL per object, re-minted before its 7-day cap |
| Transport | raw `fetch(url, { headers: { Range } })` — never `client.send(GetObjectCommand)` for chunk bytes (constraint 1) |
| Chunk size | 8 MiB default, adaptive 4–32 MiB via the `resolveProbe` >10% rule in `src/lib/concurrency-strategy.js` |
| Concurrency | 2–4; drop to 1 after repeated stalls (the bufferbloat signature) |
| Stall detection | no bytes for 30 s → abort and re-request that range only |
| Retry | reuse the classification in `src/lib/s3-retry.js`, with a far higher ceiling than uploads' 4 — over days, transient failure is the normal case |
| Memory | mirror `capConcurrencyByMemory` (`chunkSize × concurrency ≤ budget`) — the BUG-033 lesson |

**Integrity:** pin size and ETag from a `HeadObject` at start; periodically re-anchor with a
HEAD and compare the ETag **client-side**. Do not use `If-Match` — it is not CORS-safelisted
and would reinstate a preflight on every chunk. On mismatch, fail loud and mark the partial
untrusted; never assemble bytes from two object versions. Default tier is size + edge hash
(reuse `computeFileHash` from `src/lib/file-identity.js`). A strict full re-hash tier is
opt-in and only meaningful for ETags without a `-N` suffix, since a multipart ETag is a
composite of part MD5s, not a content hash.

## Cross-cutting

- **Credential lifetime is a stated limitation, not a bug.** Signing chunks needs the secret
  key, which lives in `sessionStorage` and is cleared on tab close. Resuming after a browser
  restart requires a vault unlock. The UI and docs must say so, and must not claim unattended
  cross-restart resume.
- **Cost warning** at job creation above a size threshold, acknowledged with an explicit click
  (not a bare OK), recorded in the job record so it is not re-shown every session — but
  re-surfaced when a job resumes after a long gap. Reference figures: ~$81–92/TB on AWS S3;
  free on R2; ratio-gated on B2 (free up to 3× stored) and Wasabi (free up to stored volume);
  DigitalOcean Spaces double-bills presigned downloads through its CDN.
- **`src/lib/format.js`** — `formatEta` tops out at hours; add a days tier. Speed smoothing
  needs a ~15-minute window alongside the existing 6-second one in `BatchSummary.jsx`, which
  reads as noise or a false zero on a multi-day job.
- **BUG-021 recurrence guard** — cap rendered rows the way `UploadLog` caps at `MAX_DISPLAY`,
  use stable keys (not array index), and offer a CSV export instead of rendering a 4,000-row
  error list.

## Testing

Testing hinges on the sink seam: with `MemorySink`, nearly all engine logic is provable in
plain `node --test` with no browser.

Playwright **cannot** drive File System Access pickers. `page.on('filechooser')` does not
fire for them, and both feature requests are closed "not planned"
([#8850](https://github.com/microsoft/playwright/issues/8850),
[#11288](https://github.com/microsoft/playwright/issues/11288), fetched 2026-07-30). Browser
tests therefore inject a mock `window.showDirectoryPicker` via `context.addInitScript`.

| Layer | Covers |
|---|---|
| `node --test` + `MemorySink` | resume planning, no-redundant-bytes, manifest-before-bytes ordering, cancel boundary, memory cap, path-traversal rejection, ETag-mismatch detection |
| `node --test` + `fake-indexeddb` | job/item CRUD, checkpointed enumeration, cross-session `existingBytes` round trip |
| `npm run test:ui` | row rendering and the `MAX_DISPLAY` cap, two distinct row types, cancel wiring |
| mock-S3 node integration | Range/206, kill-at-byte, 503 injection, `If-Match` |
| Playwright, FSA mocked | full job flow incl. resume-after-reload; runs the **full 3×3 matrix** — Firefox/WebKit exercise the browser-managed tier, which is the point |
| Playwright, real FSA | one `launchPersistentContext` restart test proving IndexedDB + handle survive a real browser restart — **Chromium only** |

`test/e2e/mock-s3/server.mjs` additions, in order: `Accept-Ranges` on plain GET/HEAD;
`Content-Range` and `Accept-Ranges` in the CORS expose set (so a regression can be *detected*,
per BUG-028, even though the design does not depend on reading them); a
`{ op: 'GetObject', killAtByte: N }` fault; `503 SlowDown` injection; `If-Match` → 412.
Slow-drip throttling can follow later — a killed connection exercises the same restart branch.

Regression tests carried from `BUG-LOG.md`: **BUG-021** (row cap + stable keys), **BUG-033**
(memory budget tested at the *default* budget with a *large* chunk size — exactly the case the
original coverage missed), **BUG-041** (the browser-managed tier asserted at the network level,
not via Playwright's `download` event, which WebKit does not fire), **BUG-028** (every header
the engine reads asserted present — a stripped header here fails silently, not loudly),
**BUG-007** (enumeration must loop until exhausted).

## Non-goals

- Exporting any file of presigned URLs. The CLI handoff uses credentials, which are revocable.
- Claiming unattended resume across a browser restart.
- Showing byte progress, a percentage, or an ETA on the browser-managed tier.
- Rendering the two tiers with the same row UI — that is exactly the "queue row would be a lie"
  failure `master-queue.md` named.
- Refactoring the delete/move/dedup crawlers onto `crawl-prefix.js` as part of this work. Build
  the primitive, note the follow-up, leave those callers alone.
- Competing with rclone above ~1 TB. Above a threshold the app recommends the CLI job outright,
  as `README.md` already does for uploads over 50 GB.

## Open questions

1. Cost-warning and CLI-recommendation thresholds (proposed: warn at 50 GiB, recommend CLI at 1 TiB).
2. Chunk size and reconciliation batch size are educated guesses needing a measured pass, given
   BUG-033's history of a plausible-looking budget silently collapsing concurrency to 1.
3. Whether Wasabi's automatic CORS already exposes the headers the *tests* assert on. The design
   itself does not depend on them.
4. Job retention window — no precedent exists in the repo.
