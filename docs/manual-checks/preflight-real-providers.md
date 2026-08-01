# Manual check — pre-flight probe classification against real providers

**Why this exists.** The download pre-flight's status-code table (`download-preflight.js`)
was originally validated only against a mock whose status codes the author chose — and the
one provider-specific behavior that matters most was wrong in exactly the way that habit
invites: AWS returns **403, not 404**, for a missing key when the caller lacks
`s3:ListBucket`, so a single deleted object could stop an entire job (postmortem catalog
defect 7). The engine now requires a streak of consecutive denials before blocking, which
bounds that failure — but the classification itself has **still never been measured against
a real provider**. A mock cannot honestly test a table whose values the mock copied from
the table's author.

**When to run it.** Before any release that changes `download-preflight.js`'s
classification (`kindForStatus`) or the engine's blocking rules (`DENIED_BLOCK_STREAK`,
`isBlocking`), and once against each newly supported provider. Record the results in the
table below with the date, credentials shape, and observed codes — this file is the log.

## The checks

Use a scratch bucket. Every probe is `GET` with `Range: bytes=0-0` on a presigned URL, the
exact shape the engine sends.

1. **Missing key, full-permission credentials.** Delete an object, probe its presigned
   URL. Expected: `404` → MISSING → that file fails, job continues.
2. **Missing key, no `s3:ListBucket`.** Same probe with credentials lacking ListBucket.
   AWS documents `403` here. Expected: DENIED for that file only; job must continue unless
   a streak follows. *This is the catalog-7 scenario.*
3. **Expired/rotated credentials.** Probe any live key with a revoked keypair. Expected:
   `403` on every key → DENIED streak → job blocks with the credentials message.
4. **Clock skew.** Presign with system clock offset > 15 min. Expected: `403`
   (RequestTimeTooSkewed surfaces as 403 at the HTTP layer) → streak → block.
5. **Archived object (AWS).** Probe a GLACIER / DEEP_ARCHIVE object. Record the actual
   status (`403 InvalidObjectState` expected) — confirms archived objects are per-file
   failures, not job-wide blocks.
6. **Empty object.** Probe a 0-byte object. Expected: `416` → OK (readable). This is the
   one the table already gets right by design; confirm per provider anyway.
7. **Missing CORS rule.** Probe from a browser origin the bucket's CORS does not allow.
   Expected: thrown fetch → NETWORK → immediate job-wide block.

## Results log

| Date | Provider | Check | Observed | Matches table? | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | No real-provider run recorded yet. Until a row exists for AWS checks 1–2, treat the 403-for-missing behavior as *documented, not measured*. |
