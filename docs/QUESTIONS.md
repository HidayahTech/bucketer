# Questions / Blockers

This file tracks questions that need your input and known gaps in the spec.
Updated as implementation proceeds.

---

## Open Questions

### Q1 — B2 multipart UploadId session duration *(resolved)*
B2 incomplete multipart uploads **do not expire automatically**. They persist indefinitely
until `AbortMultipartUpload` is called or a lifecycle rule triggers. No hard session timeout.

**Code updated:** `src/lib/indexeddb.js` now exports `uploadExpiryWarningMs(provider)` which
returns `null` for B2 (no warning needed) and 7 days for R2/others. The expiry warning banner
in the upload queue only fires for providers with a known expiry limit.

### Q2 — `ResponseContentDisposition` on B2 presigned URLs *(likely resolved)*
B2's S3-compatible API does appear to support `response-content-disposition` as a presigned URL
query parameter — it's part of the S3 spec that B2 claims compatibility with. A [Bun client issue](https://github.com/oven-sh/bun/issues/25750)
that looked like a B2 limitation turned out to be a bug in Bun's S3 client, not B2.

**Status:** Highly likely to work, but not confirmed from official B2 documentation. **Still worth
a quick manual test on a real B2 bucket** — download a file and confirm the browser prompts a
save dialog with the correct filename rather than opening it inline.

### Q3 — CSP header deployment
The app itself cannot set `Content-Security-Policy` headers (that requires the web server).
I've included the recommended CSP in `README.md`. You'll need to configure it in nginx/caddy/etc.
when self-hosting.

### Q4 — Notification API permission UX *(resolved)*
Chrome 84+ and Firefox 72+ require a user gesture for `Notification.requestPermission()` —
and our implementation calls it inside `addFiles()`, which is always triggered by either a
file input `onChange` or a drop zone click. Both are user gestures. This will work correctly
in all modern browsers. No action needed.

---

## Known Limitations / TODOs

- **No automatic retry with backoff** — deferred per spec §4.10 / §6.
- **No delete, rename, copy** — out of scope per §6.
- **No multiple saved credential profiles** — out of scope per §6.
- **MinIO `forcePathStyle` must be set via manual override** — the endpoint pattern is user-defined so auto-detection is impossible. The UI includes a manual provider selector.
- **Safari `file://` SubtleCrypto** — marked as inconsistent in the spec. The file identity hash in resume records uses SubtleCrypto; on Safari from `file://` this may fail silently. Fallback: name+size+lastModified match is still checked.

---

## Minor Spec Deviations (Non-blocking)

### D1 — "Connection Failed" session state
The spec (§4.14) defines a **Connection Failed** session state triggered by the initial listing probe.
In the current implementation, `createS3Client()` rarely throws (AWS SDK doesn't validate credentials
at construction time), so the app immediately transitions to `Connected` and shows the listing error
inline in the Browser component.

**Effect:** The listing error is shown with full diagnostic detail (CORS masking guidance, raw error).
The user can retry via Refresh Permissions. The spec's stated goal ("Error shown with diagnostic detail")
is achieved, though the session label shows as Connected rather than Connection Failed.

**To fully align:** Add an `onInitialListFailed` callback from Browser → App to transition to 'failed'.
Left as a known minor deviation for v0.1.

### D2 — Sidebar form re-connects via splash state *(resolved)*
~~When the user submits new credentials from the sidebar while connected, the app briefly transitions
through the splash/connecting state.~~ Fixed: sidebar form passes `reconnect: true` to `handleConnect`,
which skips the 'connecting' transition and stays in 'connected' state while the new client is created.

---

## Decisions Made During Implementation

| Decision | Rationale |
|----------|-----------|
| Preact + esbuild + vanilla CSS | User-selected at session start |
| Single inlined HTML output | Required by §4.3 for `file://` Chrome compatibility |
| 7-day UploadId expiry warning threshold | Matches R2's known value; B2 unconfirmed (Q1) |
| N=2 upload concurrency default | Spec §4.6 |
| B2 default MaxKeys=200, others 1000 | Spec §4.7 |
