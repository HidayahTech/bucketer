# Demo Mode — Design & Implementation Plan

Deferred after design discussion on 2026-06-06. All decisions below are settled
unless marked **OPEN**.

---

## Goal

A "Try Demo" entry point that shows a fully functional Bucketer UI backed by an
in-memory mock rather than a real S3 bucket. Users can explore listings, upload
files, preview content, rename, delete — without credentials and without a
backend. Intended for first-time evaluation and for demonstrating the app to
others.

---

## Approach: MockS3Client

Create `src/lib/mock-s3-client.js` — a class that implements the same
`client.send(command)` interface as the real AWS SDK client. Components never
know they are talking to a mock; no conditional branches in component code
except the two feature-specific carve-outs noted below.

**Not chosen:** service worker interception (requires HTTPS/localhost, complex
lifecycle, hard to pre-populate); URL-param endpoint spoofing (doesn't solve
presigned URLs, requires a real server).

---

## The Hard Part: Presigned URLs

`getSignedUrl()` from `@aws-sdk/s3-request-presigner` is called **directly**
in `usePreview.js` and `Browser.jsx` — it bypasses `client.send()` entirely,
so the mock cannot intercept it. For a real client it produces a signed HTTPS
URL; for a mock that URL points nowhere.

**Solution: `getObjectUrl(client, command, options)` wrapper**

Add `src/lib/object-url.js`:

```js
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export async function getObjectUrl(client, command, options) {
  if (client._isMockClient) {
    return client._getBlobUrl(command.input.Key);
  }
  return getSignedUrl(client, command, options);
}
```

Replace every `getSignedUrl(client, ...)` callsite in `usePreview.js` and
`Browser.jsx` with `getObjectUrl(client, ...)`. There are roughly 4–5
callsites; grep for `getSignedUrl` to find all of them.

The mock client exposes `_isMockClient = true` and `_getBlobUrl(key)` which
returns a `URL.createObjectURL(blob)` from in-memory content, or `null` for
large-file stubs (see below).

**Important:** blob URLs created with `URL.createObjectURL` must be revoked when
no longer needed to avoid memory leaks. `usePreview.js` already calls
`closePreview()`; add `URL.revokeObjectURL(url)` there when in demo mode. The
mock client can track which blob URLs it has issued.

---

## MockS3Client Internal State

```js
// key → { size, lastModified, eTag, contentType, blob?: Blob }
const store = new Map();

// In-flight multipart uploads
// uploadId → { key, parts: Map<partNumber, { eTag, size }> }
const multipartUploads = new Map();
```

`blob` is present for files stored in full (small uploads, pre-populated
samples). Absent for large-file stubs — preview is gracefully unavailable.

---

## Command Implementations

**ListObjectsV2Command**
- Filter `store` keys by `Prefix`; exclude keys that have a `/` after the
  prefix unless they are themselves a "folder" key (trailing slash)
- Simulate CommonPrefixes (virtual folders) by collecting the first path
  segment after the prefix for keys that contain a `/` after it
- Honour `MaxKeys` and return `IsTruncated` + `NextContinuationToken`
- Critical: the response shape must match exactly what the existing parsing
  code in `Browser.jsx` expects. Read `Browser.jsx`'s `listObjects()` function
  carefully before implementing — pay attention to `Contents`, `CommonPrefixes`,
  `IsTruncated`, `NextContinuationToken`, `KeyCount`

**HeadObjectCommand**
- Look up key in store, return `ContentType`, `ContentLength`, `LastModified`,
  `ETag`; throw a 404-shaped error if absent

**PutObjectCommand**
- Extract `Body` (a `Blob` or `Uint8Array`), store it with metadata
- Return `{ ETag: '"mock-etag-' + randomHex() + '"' }`

**CreateMultipartUploadCommand**
- Generate a fake `UploadId` (random hex string)
- Store `{ key, parts: new Map() }` in `multipartUploads`
- Return `{ UploadId }`

**UploadPartCommand**
- Look up the multipart entry by `UploadId`
- For small-file paths (total size < threshold): accumulate the part `Body`
  blob in `parts`
- For large-file stub paths: discard the body, record only size and a fake ETag
- Add a simulated delay of ~3 ms per part so the speed display shows plausible
  numbers (otherwise parts complete instantly and show ∞ MB/s)
- Return `{ ETag: '"part-etag-' + partNumber + '"' }`

**CompleteMultipartUploadCommand**
- If all parts have stored blobs: concatenate into a single `Blob` and store in
  `store` with the assembled content
- If large-file stub: store metadata only (no blob) — preview will gracefully
  show "not available in demo mode"
- Delete the multipart entry
- Return `{ ETag, Location: 'demo://...' }`

**AbortMultipartUploadCommand**
- Delete the multipart entry and any accumulated part blobs
- Return `{}`

**DeleteObjectsCommand**
- Remove each key from `store`
- Return `{ Deleted: [...], Errors: [] }`

**CopyObjectCommand** (for rename)
- Copy the store entry under the new key, delete the old key
- Return `{ CopyObjectResult: { ETag, LastModified } }`

**ListObjectVersionsCommand** (for HiddenVersions panel)
- **OPEN:** either return empty (simplest) or simulate a couple of delete
  markers so the panel is demonstrable. Leaning toward returning empty and
  letting the panel show its empty state.

---

## Large File Threshold

Files ≥ 50 MB: store metadata only, no blob. The file appears in the listing
with the correct name and size. Preview shows a note: "Preview not available in
demo mode for files over 50 MB." Download link is absent or similarly noted.

Files < 50 MB: blob stored; preview and download work via blob URL.

The 50 MB limit is enforced in `PutObjectCommand` (check `Body.size`) and at
the `CompleteMultipartUploadCommand` point (check total assembled size from
part sizes). Add a `_DEMO_BLOB_LIMIT = 50 * 1024 * 1024` constant.

---

## Capability Detection

The capability probe in `Browser.jsx` fires `ListObjectsV2`, `HeadObject`,
`PutObject`, `DeleteObjects` against the bucket to detect permissions. For the
mock client, all of these succeed, so all four capabilities will be discovered
as `permitted` automatically without any special-casing — the probe just works.

---

## Demo Mode Entry Point

**UI:** "Try Demo" button on the credential form screen (below the form, styled
as a secondary action). Also support `?demo` as a URL parameter so a demo
session can be linked directly.

**What "entering demo mode" does:**
1. Creates a `MockS3Client` instance pre-populated with sample data
2. Sets `credentials` to a synthetic demo credential object:
   ```js
   { provider: 'demo', bucket: 'demo-bucket', endpoint: 'demo://', keyId: 'demo', secretKey: '' }
   ```
3. Skips the real `createS3Client` / connect flow; sets `session = 'connected'`
   directly
4. `addFilesRef` wires up normally — UploadQueue works as-is

**OPEN:** whether `provider: 'demo'` needs special handling anywhere (e.g.,
`requiresPathStyle`, `defaultMaxKeys`, `needsCorsConfig`). Likely needs a new
`PROVIDERS.DEMO` entry that returns safe defaults.

---

## Things to Explicitly Disable in Demo Mode

| Feature | Action |
|---------|--------|
| **Cross-session upload resume** | Suppress — fake UploadIds stored in IndexedDB would appear as stale resume prompts on next real session. Skip `saveResumeRecord` and `loadResumeRecord` calls when `provider === 'demo'`. |
| **Update check banner** | Suppress — `UpdateBanner` polls the remote for a version; irrelevant in demo. Gate on `provider !== 'demo'`. |
| **Share link** | Suppress or show disabled — `buildShareUrl` would include `endpoint=demo://`, which is not useful. Either hide the share button or show a tooltip "Not available in demo mode." |
| **Upload log persistence** | **OPEN:** could let it write to IndexedDB as normal (it's harmless), or suppress it. Leaning toward allowing it — the log is a useful demo feature. |
| **SetupGuide** | Should not appear for provider `demo` — add a guard in the guide's provider switch. |

---

## Demo Mode Indicator

A persistent banner at the top of the connected view:

> **Demo Mode** — Files are stored in memory only and will not persist after you
> close this tab. [Connect to a real bucket →]

Style it distinctly from the warning banner (maybe `--info-bg` rather than
`--warn-bg`). The "Connect to a real bucket" link clears demo state and returns
to the credential form.

---

## Pre-Populated Sample Data

A realistic-feeling starting state. All blobs should be tiny (real renderable
content so preview actually works) — a few KB each.

Suggested tree:
```
photos/
  beach.jpg         (real tiny JPEG, ~8 KB)
  mountain.png      (real tiny PNG, ~6 KB)
documents/
  readme.txt        (short text file)
  report.pdf        (real minimal PDF, ~4 KB)
  notes.md          (markdown text)
archive/
  backup-2025.zip   (stub — no blob, listed with a realistic size like 2.3 GB)
logo.svg            (inline SVG, a few hundred bytes)
```

The `backup-2025.zip` entry demonstrates how a large file appears in the listing
without preview. The images and PDF demonstrate the preview modal. The text and
markdown files demonstrate text preview.

Sample data defined as a static array in `src/lib/mock-s3-client.js` (or a
separate `src/lib/mock-sample-data.js`). Blobs can be base64-encoded inline
constants — keep it small.

---

## File Layout

| File | Purpose |
|------|---------|
| `src/lib/mock-s3-client.js` | `MockS3Client` class, sample data, `_DEMO_BLOB_LIMIT` |
| `src/lib/object-url.js` | `getObjectUrl` wrapper replacing direct `getSignedUrl` calls |
| `src/components/DemoBanner.jsx` | Persistent demo mode indicator strip |
| `src/components/CredentialForm.jsx` | Add "Try Demo" button |
| `src/components/App.jsx` | Handle demo credential object, skip real connect flow, suppress update check |
| `src/lib/provider.js` | Add `PROVIDERS.DEMO` with safe defaults |
| `src/lib/indexeddb.js` | Gate `saveResumeRecord`/`loadResumeRecord` on `provider !== 'demo'` |

---

## Implementation Order

1. `object-url.js` wrapper + update all `getSignedUrl` callsites — do this
   first so the refactor is isolated and testable before any mock code exists
2. `PROVIDERS.DEMO` entry in `provider.js`
3. `MockS3Client` — implement commands in this order: List → Head → Put →
   Delete → Copy → Multipart (Create/Part/Complete/Abort)
4. Sample data
5. App.jsx demo entry path (Try Demo button, skip connect flow)
6. DemoBanner
7. Feature suppressions (resume, update check, share link)
8. Tests

---

## Testing Strategy

- Unit test `MockS3Client` command handlers directly (no build needed) —
  `test/mock-s3-client.test.js`
- Source invariant: `getSignedUrl` does not appear directly in
  `usePreview.js` or `Browser.jsx` (all callsites replaced by `getObjectUrl`)
- The `getObjectUrl` wrapper itself: unit test that it calls through to
  `getSignedUrl` for a real client and returns a blob URL for a mock client

End-to-end / visual verification via Playwright: navigate to `?demo`, confirm
the listing renders the sample tree, upload a small file, confirm it appears,
preview an image, delete a file.

---

## Rough Complexity Estimate

- `MockS3Client`: ~250 lines
- `object-url.js` + callsite updates: ~50 lines
- App.jsx demo path + DemoBanner: ~80 lines
- Feature suppressions: ~30 lines
- Sample data: ~60 lines
- Tests: ~150 lines

Total: ~620 lines new/changed. Approximately one focused session.

The main risk is the `ListObjectsV2` response shape — get that wrong and the
browser silently shows nothing. Read the existing parsing code in `Browser.jsx`
before writing a single line of the mock.
