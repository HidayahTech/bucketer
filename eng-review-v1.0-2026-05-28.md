# Engineering Review — Bucketer
**Version:** 1.0
**Date:** 2026-05-28
**Reviewer:** Engineering Manager perspective
**Scope:** Full codebase and spec review at v1.10.0

---

## Summary

Bucketer is in genuinely good shape for what it is: a single-engineer browser app that does something non-trivial correctly. The spec is thorough, the implementation is faithful to it, and the hard problems (multipart upload, resumability, CORS surface) are handled with real care. The concerns below are mostly about where the codebase will become harder to change as it grows, and a few bugs and spec drift items worth addressing now before they compound.

---

## What Is Working Well

### The upload pipeline is production-quality

The multipart implementation — dynamic part size, worker pool for part concurrency, file identity hash, IndexedDB resume records, `ListParts` as ground truth on resume, tab conflict detection, and provider-specific cleanup guidance — is thorough. These aren't features that got bolted on; they were designed correctly from the start. The `UploadQueue` class is a clean primitive that gives file-level concurrency without complexity.

### The update check is well-engineered

The HEAD → Range → full-fetch cascade is a genuinely clever solution to a tight constraint (single file, no separate version endpoint, must work within browser cache semantics). The build invariant that enforces the 512-byte boundary is self-documenting and fails loudly. The HAR analysis confirms it's working exactly as designed.

### Error handling is honest

`ErrorBlock`'s CORS masking detection, `isPermissionError`, the `parseS3Error` wrapper, and the provider-specific consequence text on multipart failures all reflect real-world experience with what actually confuses users. Most browser apps either hide errors entirely or dump raw stack traces. This is neither.

### The storage tier separation is correct

Secret key in `sessionStorage`, everything else in `localStorage`, `type="password"` on the input, clear on disconnect — all correct. The spec language about this (§4.5) is also appropriately honest: "reduced persistence duration, not meaningfully secure storage." That's the right framing.

### Provider abstraction is clean

`provider.js` is a single module that handles all provider variance: endpoint pattern detection, region extraction, `forcePathStyle`, default MaxKeys, CORS config need, and labels. New providers extend it in one place. The provider matrix in §5 of the spec and the implementation stay in sync well.

### The spec is unusually good for this stage

Most personal projects at this scale have no spec at all. The Bucketer spec at v0.15 reflects 15 documented revisions, resolves all open questions, and provides implementation rationale that makes code decisions traceable. Principle 2 ("require justification for complexity") is the kind of discipline that prevents scope creep.

---

## Technical Concerns

### 1. `Browser.jsx` is approaching unmanageable complexity — HIGH RISK

At 1352 lines with 33 `useState` calls, `Browser.jsx` manages roughly fifteen distinct UI flows: preview, rename, single delete, folder delete, batch delete, batch copy links, single copy link, metadata panel, new folder, drag-and-drop, navigation/history, pagination, filtering, sorting, and the HiddenVersions sub-tree. A change to any one of these can silently affect the others because they all share the same render scope.

This is the single highest-risk item in the codebase. It doesn't mean anything is broken today, but every new feature added to the browser will make it harder to reason about correctness, and bugs introduced here will be harder to isolate. The blast radius of a state variable named `error` that could be the delete error, download error, or list error is already present in subtle form.

The right direction is extraction — not necessarily into separate files, but into focused custom hooks (e.g., `usePreview`, `useDelete`, `useRename`) that each own their own state slice and expose a clean interface. This would make it possible to test each flow in isolation and reduce the cognitive overhead of reading the render tree. This is the most important piece of debt to address in the next round of development work.

### 2. `clearCredentials()` silently deletes all user settings — BUG

In `src/lib/storage.js`:

```js
export function clearCredentials() {
  Object.values(LS_KEYS).forEach(k => safeRemove(localStorage, k));
  safeRemove(sessionStorage, SS_KEY_SECRET);
}
```

`LS_KEYS` includes `maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, and `capabilities`. Disconnecting — a frequent action when switching buckets — clears all configured settings. A user who set part size to 50 MiB or disabled the listing cache loses that on every disconnect. This is almost certainly unintentional; credentials and settings should be cleared independently.

### 3. The resume path is serial, not concurrent

`uploadMultipart` uses a worker pool with configurable concurrency for fresh uploads:

```js
const concurrency = Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
await Promise.all(Array.from({ length: concurrency }, worker));
```

`handleResume` uploads remaining parts sequentially:

```js
for (const partNumber of remainingParts) {
  const chunk = await item.file.slice(start, end).arrayBuffer();
  const partResp = await client.send(new UploadPartCommand(...));
  ...
}
```

A resumed upload will be dramatically slower than a fresh one for files with many remaining parts. The resume path should use the same worker pool pattern.

### 4. No tests

Zero tests across the codebase. For an app with destructive, irreversible operations (batch delete, folder purge, multipart upload sessions), this is a real gap. At minimum, the lib/ modules are pure and easily testable without a browser environment: `format.js`, `provider.js`, `upload-queue.js`, `url-params.js`, and the state machine logic in `indexeddb.js` would all benefit from unit tests. The upload queue's concurrency behavior in particular is subtle and worth verifying mechanically.

### 5. `@anthropic-ai/claude-code` is in `dependencies`, not `devDependencies`

The CLAUDE.md correctly prohibits this from being committed or deployed, but it's in `package.json` under `dependencies`. This means it would be included if anyone were to run a standard npm deployment. It should be removed from `package.json` entirely — it's a global CLI tool that doesn't belong in project dependencies at all.

### 6. `_sessionFirstMount` is module-level mutable state

In `Browser.jsx`:

```js
let _sessionFirstMount = true;
```

This works correctly in production, but in development with hot module reloading it won't reset between reloads. It's also a hidden coupling between module load order and component behavior. Moving this into a ref initialized once per app session (e.g., via a ref in `App.jsx` passed down as a prop) would make the dependency explicit.

### 7. `HiddenVersions.handlePurgeAllConfirm` stops on first batch error

The purge-all path batches deletions in chunks of 1000 and throws on the first `DeleteObjects` error. If you have 2500 items and the second batch fails, the first 1000 are already gone and the UI shows an error with no indication of partial success. `Browser.jsx`'s folder delete (`handleFolderDeleteConfirm`) handles this correctly by accumulating errors. HiddenVersions should do the same.

---

## Spec Observations and Drift

### The spec's §6 "Out of Scope" list is now entirely implemented

§6 lists delete, rename, copy, and multiple profiles as out of scope for v0.1. All of delete (single, batch, folder, versioned), rename, and copy (via the rename copy-then-delete path) are fully implemented. This isn't a criticism — features were added intentionally — but the spec needs to be updated. Keeping an "Out of Scope" section that contradicts what's shipped creates confusion about the intended scope going forward.

### §4.6 says `lib-storage`; the implementation uses raw SDK commands

The spec still says "use `lib-storage`'s `Upload` class with `leavePartsOnError: true`" for initial multipart uploads. The implementation correctly uses raw `CreateMultipartUploadCommand`, `UploadPartCommand`, etc. — which is actually better because it gives full control over part concurrency, part size, and the upload ID. The spec's §4.15 acknowledgment that "lib-storage cannot resume within the same instance" was the correct reason to deviate. The spec should be updated to reflect the actual implementation approach.

### The spec mandates N=2 file concurrency default; the implementation uses N=3

§4.6: "Default N = 2." `UploadQueue.jsx`: `DEFAULT_FILE_CONCURRENCY = 3`. Minor, but worth aligning. If N=3 is the right default (reasonable — HTTP/2 makes N=2 conservative), update the spec. If N=2 was intentional, revert the code.

### §4.14 D1 deviation is resolved — update QUESTIONS.md

QUESTIONS.md notes D1 (Connection Failed state) as an unresolved minor deviation, but `App.jsx` does implement `onInitialListFailed` and transitions to `'failed'` correctly. The deviation is resolved; the note is stale.

---

## Spec Constraints Worth Reconsidering

### The `file://` requirement drives non-trivial complexity for uncertain return

The spec's §4.13 `file://` requirement is the root cause of several cross-cutting concerns:

- `FileBanner.jsx` (per-browser caveat detection and display)
- The 512-byte build invariant (required because the Range update check must work from a self-contained file served without range support on some setups)
- The `corsJson` wildcard origin branch in `SetupGuide.jsx`
- The `localStorage` null-origin shared namespace warning
- The `currentOrigin()` special case returning `'*'` for `file://`
- Safari SubtleCrypto caveat for resume hashing

The primary deployment target is `bucketer.hidayahtech.net` — a served HTTP origin. It's worth asking: who actually uses this from `file://`, and how often? If the answer is "occasionally, as a convenience," the current treatment is reasonable. If the answer is "essentially never," then `file://` should be downgraded to "best-effort, not officially supported" and several of these branches can be simplified or removed. The single-file output format is still worth keeping regardless — it's an excellent deployment property for an HTTP context too — but the `file://`-specific logic is separable from it.

This isn't a recommendation to remove `file://` support today. It's a flag that this requirement carries ongoing maintenance cost and should be a conscious, confirmed choice rather than inherited inertia from early spec decisions.

### The 512-byte invariant is now load-bearing technical debt

The build invariant is good engineering, but the constraint it enforces is rigid. Any structural change to the HTML `<head>` — adding a CSP meta tag, a theme-color, a preconnect hint — must either fit within 512 bytes or require coordinated changes to both `build.mjs` and `UpdateBanner.jsx`. This is manageable but worth being explicit about in team knowledge. The constant is already documented and synced between both files; the main risk is someone adding to the head without knowing the invariant exists.

---

## Missing Features Worth Flagging

These aren't requested or committed to — just observations about natural next steps and their complexity:

- **Upload progress survives page reload**: The resume record survives, but the queue UI doesn't. A user who refreshes mid-batch has to re-add files and manually resume each one. Persisting queue state to sessionStorage would close this gap.
- **Bulk download**: There's no way to download multiple files at once. This is genuinely out of scope (ZIP packaging requires either a server or a significant client-side library) but is the most common missing feature in this class of tool.
- **Object metadata editing**: HeadObject for display is implemented; `CopyObject` with updated metadata for editing isn't. This is a reasonable next feature given that rename already uses copy-then-delete.
- **Automatic retry with backoff**: §4.10 defers this. It remains the right call — the complexity it adds (retry budget tracking, distinguishing transient vs permanent errors) is non-trivial.

---

## Prioritized Action List

In rough priority order:

1. **Fix `clearCredentials()` to not delete settings** — this is a bug that affects any user who disconnects between sessions.
2. **Update QUESTIONS.md D1 deviation** — it's resolved; the stale note is misleading.
3. **Update the spec §6 and §4.6** — bring it in sync with what's actually shipped.
4. **Fix the resume path to use concurrent part uploads** — correctness plus significant performance impact for users with large partially-uploaded files.
5. **Fix `HiddenVersions.handlePurgeAllConfirm` error accumulation** — partial failure on purge-all leaves the user with no visibility into what was deleted.
6. **Remove `@anthropic-ai/claude-code` from `package.json` entirely** — it doesn't belong in project dependencies.
7. **Plan `Browser.jsx` extraction** — this doesn't need to happen in one pass, but having a plan (which hooks to extract first, what the seams are) will make each subsequent feature PR safer. The preview and delete flows are the cleanest candidates to extract first.
8. **Decide `file://` stance** — confirm intentional ongoing support or downgrade. Either answer is fine; the current ambiguity is the problem.
9. **Add tests for lib/ modules** — start with `upload-queue.js` (concurrency logic), `format.js` (edge cases), and `provider.js` (detection patterns). These require no browser environment.
