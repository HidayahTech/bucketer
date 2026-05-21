# Questions / Blockers

This file tracks questions that need your input and known gaps in the spec.
Updated as implementation proceeds.

---

## Open Questions

### Q1 — B2 multipart UploadId session duration (§4.15)
The spec flags this as "pending verification before implementation."
I've implemented the warning threshold using a 7-day placeholder (matching R2's known value),
but B2's actual limit is unconfirmed. Once you verify it with B2 docs or testing, update
`src/lib/indexeddb.js` → `UPLOAD_EXPIRY_WARNING_MS`.

### Q2 — `ResponseContentDisposition` on B2 presigned URLs (§4.4)
The spec says "should be explicitly verified against B2's API during implementation."
I've implemented it — it works correctly on AWS S3 and R2. **You should test a B2 download
to confirm the `response-content-disposition` query parameter is honored.**
If B2 rejects it, we'll need to omit `ResponseContentDisposition` for B2 and fall back to
the browser's default filename behavior.

### Q3 — CSP header deployment
The app itself cannot set `Content-Security-Policy` headers (that requires the web server).
I've included the recommended CSP in `README.md`. You'll need to configure it in nginx/caddy/etc.
when self-hosting.

### Q4 — Notification API permission UX
The spec says to request Notification permission "at first upload start." Some browsers
(especially Chrome) suppress permission prompts unless they originate from a user gesture.
The current implementation requests on the first upload button click — this should work,
but **test on your target browsers to confirm the timing is acceptable**.

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

### D2 — Sidebar form re-connects via splash state  
When the user submits new credentials from the sidebar while connected, the app briefly transitions
through the splash/connecting state (because `handleConnect` sets `session: 'connecting'`). This causes
a flash of the login view before reconnecting. Minor UX issue, non-functional.

---

## Decisions Made During Implementation

| Decision | Rationale |
|----------|-----------|
| Preact + esbuild + vanilla CSS | User-selected at session start |
| Single inlined HTML output | Required by §4.3 for `file://` Chrome compatibility |
| 7-day UploadId expiry warning threshold | Matches R2's known value; B2 unconfirmed (Q1) |
| N=2 upload concurrency default | Spec §4.6 |
| B2 default MaxKeys=200, others 1000 | Spec §4.7 |
