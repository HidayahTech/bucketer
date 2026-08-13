# Prefix-Scoped Access Keys — Design

**Date:** 2026-08-13 · **Issue:** [#60 — Support prefix-scoped access keys](https://gitlab.com/hidayahtech/bucketer/-/work_items/60) · **Target:** v1.50.0

Designed by a four-lens expert panel (B2/S3 API research, codebase architecture, UX,
QA/test architecture) convened 2026-08-13; decisions synthesized from the four reports.
The operator delegated design decisions to the panel and authorized ship-to-main.

## Problem

An access key restricted to a key-name prefix — a Backblaze B2 application key created
with a **namePrefix**, or an AWS IAM policy conditioned on `s3:prefix` — cannot use
Bucketer. Connecting lists the bucket root, which the key cannot list, so the user gets
`AccessDenied` and a dead end. Nothing in the UI lets them declare the scope their key
actually has.

## Research findings the design rests on

All fetched/tested 2026-08-13.

- **B2 scoping semantics (VERIFIED, official doc):** for namePrefix-restricted keys, a
  list request must supply a Prefix *equal to or more restrictive than* the key's
  namePrefix; object reads/writes/deletes are allowed only for keys under the prefix;
  CopyObject requires **both** source and destination inside the prefix.
  Source: https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys
- **Bucketer's call pattern is already compatible:** the client never calls
  HeadBucket/ListBuckets; every listing sends `Prefix` + `Delimiter: '/'`
  (`src/lib/list-objects.js`). Once the app starts and stays at the scoped prefix, a
  namePrefix key with only file-level capabilities works.
- **Auto-detection is impossible in-browser (EMPIRICAL):** B2's native
  `b2_authorize_account` does return the key's `namePrefix`
  (https://www.backblaze.com/apidocs/b2-authorize-account), but
  `api.backblazeb2.com` sends **no CORS headers** on preflight or response (tested live
  2026-08-13 with two origins). The browser blocks the call before JS sees anything.
  → The user must type the prefix; there is no detection path. **Declined scope.**
- **AWS generalization (VERIFIED, official doc):** IAM prefix restriction via
  `s3:ListBucket` + `Condition: StringLike {"s3:prefix": ["Development/*"]}` and object
  actions on `arn:...:bucket/Development/*`; denial is 403 `AccessDenied`. AWS has no
  API to introspect the effective prefix — same "user types it" UX applies.
  Source: https://docs.aws.amazon.com/AmazonS3/latest/userguide/walkthrough1.html
- **R2:** ordinary dashboard API tokens scope to buckets only (no prefix); prefix
  scoping exists only via the short-lived Temporary Credentials API, a credential
  lifecycle Bucketer doesn't store. Out of scope.
  Source: https://developers.cloudflare.com/r2/api/tokens/ ,
  https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- **Unresolved (flagged honestly):** whether a real B2/AWS 403 on a denied request
  carries CORS headers, or presents to `fetch()` as an opaque CORS-shaped failure.
  UX copy hedges for both (see Error recovery). Needs a live probe with a real
  restricted key to settle; not a ship blocker because the recovery path is the same.

## Design

### Concept

A connection gets one new optional field, **Base folder** (internal name `basePrefix`).
Contract identical to every existing prefix in the codebase: `''` = unscoped (today's
behavior, byte-for-byte); non-empty always ends in `/`. The base folder is this
session's **floor**: the initial listing starts there, navigation can never go above
it, and every surface that could issue a request outside it is clamped or validated.

Enforcement is client-side UI discipline mirroring the server-side restriction — the
server remains the actual authority. Navigation above the floor is *prevented*
(clamped), not attempted-and-denied.

### New module: `src/lib/base-prefix.js`

- `normalizeBasePrefix(raw)` — trim; strip leading `/`; collapse `//`; non-empty result
  gets exactly one trailing `/`; `''`/whitespace → `''`. Rejects nothing (pure
  normalization); validation is separate.
- `withinFloor(prefix, floor)` — `!floor || prefix.startsWith(floor)`.
- `clampToFloor(prefix, floor)` — `withinFloor ? prefix : floor`. Identity when
  `floor === ''` (the load-bearing back-compat invariant).

### Data model

- **Connection record** (`src/lib/connections.js`): `basePrefix` field, placed like
  `bucket` (a prefix restriction is inseparable from its bucket).
  `resolveConnection()` returns `basePrefix: conn.basePrefix || ''`. Absent field on
  old records → `''` (unscoped); no migration needed. Partial updates that omit it
  leave it untouched (existing `saveConnectionRecord` spread semantics).
- **Flat last-connected mirror** (`src/lib/storage.js`): `CREDENTIAL_KEYS.basePrefix =
  's3b_base_prefix'` — load/save/clear come free from the generic iteration. Without
  this, an ad-hoc (unsaved) scoped connection silently loses its floor on reload.
- **Validation** (`src/lib/credential-validation.js`): optional; error only on `..`
  segments or backslash; leading/trailing slashes are silently normalized on submit
  (same posture as endpoint trailing-slash strip). Spaces allowed — prefixes are
  arbitrary key fragments.

### UI

- **CredentialForm**: new field after Bucket Name — label `Base folder`, placeholder
  `photos/2024/` (echoes the sidebar S3 primer's example), hint: *"Only if your access
  key is limited to a folder inside the bucket — leave blank for full bucket access."*
  Submit passes `normalizeBasePrefix(form.basePrefix)`. The existing key-hygiene
  warning line gains: *"If your key is limited to a Name Prefix, enter that folder
  above as Base folder."*
- **SetupGuide (B2, step 2)** gains one sentence bridging B2's "Name Prefix" vocabulary
  to the Base folder field and naming the failure it prevents.
- **Breadcrumb**: new `floor = ''` prop. Segments above the floor are hidden entirely
  (not shown-disabled — a control whose only outcome is a 403 invites a doomed click).
  The leftmost crumb is the floor's leaf segment (e.g. `alice` for `team/alice/`), with
  `title="Your access starts here — team/alice/"`; clicking it navigates to the floor,
  never `''`. `floor=''` renders exactly today's output (regression anchor).
- **Browser**: initial prefix = `clampToFloor(hashPrefix, basePrefix)`;
  `navigateTo()` clamps as its first line (single choke point covering breadcrumb,
  popstate, folder clicks); passes `floor` to Breadcrumb and
  `initialPrefix={basePrefix}` to MovePickerModal. When the initial hash prefix was
  clamped, a small dismissible info notice: *"This link pointed to a folder outside
  this connection's base folder — showing &lt;floor&gt; instead."* The `!canList`
  guidance line gains a prefix-scoped-key sentence.
- **MovePickerModal**: seeds at the floor; `Breadcrumb floor` + clamped `onNavigate`
  (defense in depth; its ListObjectsV2 must never see `Prefix: undefined` while
  scoped). Unscoped connections keep opening at true root.
- **DuplicatesModal**: new `basePrefix` prop; scope `'bucket'` scans the floor instead
  of `''`; option relabeled `Entire scope` when scoped ("Whole bucket" is a promise the
  key can't keep). Unscoped: wording and behavior unchanged.
- **UploadQueue**: free-text destination validated with `withinFloor`; out-of-scope →
  inline field error ("Destination must stay under `team/alice/`") + upload action
  disabled, mirroring the `newFolderError` pattern. No silent autocorrect. No-op when
  unscoped.
- **CapabilityPanel**: unchanged — once probing happens at the floor, the existing
  "denied only after a real failure" model reports the truth with zero changes.
- **TransferHandoff / transfer-commands**: no direct edits — generated rclone/aws-cli
  commands already use `currentPrefix`, which is floor-clamped by construction.

### Error recovery (scoped key, no Base folder set)

Not detectable client-side; the root listing 403s exactly as today. Additions:

- **ErrorBlock**: when the parsed error is 403/AccessDenied and the connection has no
  base folder, a note in the existing CORS-heuristic style: *"This can mean the
  credentials are wrong — but it's also common for an access key to be restricted to a
  folder inside the bucket (Backblaze B2 calls this a Name Prefix). If that matches
  your key, set **Base folder** in the form above and reconnect."*
- The existing **CORS heuristic** text gains one sentence noting a prefix-restricted
  key can also present this way (covers the unresolved CORS-on-403 ambiguity).

### Share links

- `buildShareUrl` includes `basePrefix` unconditionally when set (same category as
  endpoint/bucket/provider/region: operationally necessary, not secret — withholding it
  makes the link not work). No param at all when empty.
- `readUrlParams` reads + normalizes it (length-capped, `..`-rejected like bucket);
  `hasUrlParams` recognizes it. It pre-fills the form (editable, like bucket).
- Hash param name `basePrefix` — deliberately distinct from the existing `prefix`
  (current-folder navigation state); both can be present; out-of-floor `prefix` clamps
  with the info notice above.

### E2E / mock

- **Mock S3 server** (`test/e2e/mock-s3/server.mjs`): standing `scopePrefix` config
  (null = unscoped default; cleared by `reset()`). Guards, evaluated before faults:
  ListObjectsV2/ListVersions deny (403 `AccessDenied` XML) when the request's Prefix is
  not within scope; object ops (get/head/put/delete/initiate-multipart) deny when the
  key is outside; CopyObject checks both sides; batch DeleteObjects returns per-key
  `AccessDenied` errors for out-of-scope keys. Multipart part-ops need no guard
  (no uploadId can exist for a denied initiate — asserted, not assumed).
  `logRequest` gains `isList` + `listPrefix` (query string is stripped today, which
  would make the root-list-absence assertion unwritable). Self-tests cover all of the
  above plus reset-clears-scope.
- **New spec `test/e2e/browser/prefix-scope.test.mjs`** (full 3×3 container matrix):
  1. Normal screen: connect with scoped mock + Base folder → file rows from inside the
     scope render (presence) AND no ListObjectsV2 with empty Prefix in
     `mock.requestLog` (absence, next to presence per Evidence Rules).
  2. Shared link: `#endpoint=…&bucket=…&keyId=…&basePrefix=…` → enter secret →
     same observable.
  3. Out-of-floor deep link (`prefix` outside floor) → clamped: floor listing renders,
     no out-of-scope list request issued.
  4. Recovery: scoped mock, no Base folder → root list 403 → ErrorBlock hint text
     visible.
- **Not-inert evidence** (feature analog of matched-pair): each new spec run against
  pre-feature main and shown to FAIL, then against the feature and shown to PASS; both
  runs recorded in the MR description.

### Harness-fidelity notes (per CLAUDE.md)

- The mock ignores SigV4 entirely; "scoped key" is a per-mock-instance standing
  constraint, not a second credential. An admin key and a scoped key coexisting on one
  live bucket is not representable in one run.
- The mock emits AWS-shaped `AccessDenied` XML; B2's exact wire-level denial format
  (and whether real 403s are CORS-readable in browsers) is not modeled. No e2e
  coverage: harness cannot represent B2's real denial/CORS behavior — only a live
  probe with a real restricted key can.

### Back-compat invariants (sideways verification)

1. `clampToFloor(x, '')` is identity — unscoped behavior byte-for-byte unchanged;
   entire existing suite stays green unmodified.
2. Breadcrumb/MovePicker with no floor render exactly as today (existing component
   tests pass unmodified).
3. `basePrefix` survives reload for saved connections AND ad-hoc connects (flat
   mirror); vault-offer and save-profile paths carry it.
4. Unscoped share links gain no `basePrefix=` param.
5. Hash `prefix` deep links still work (BUG-047 territory) — existing e2e specs pass
   unmodified.
6. `handleConnect`'s capability reset is untouched.

### Declined scope

- **B2 namePrefix auto-detection** — CORS-blocked at `api.backblazeb2.com`
  (empirical, 2026-08-13); would require a proxy, which conflicts with the
  client-side-only architecture.
- **R2 prefix scoping** — only exists via short-lived temporary credentials; different
  credential lifecycle.
- **Focus-jump button in ErrorBlock** — the form sits directly above the error on the
  failed-connect screen; a named-field hint suffices. Reconsider if users miss it.
- **Capability panel scope annotation** — the panel has no per-folder state; an
  annotation would claim precision it doesn't track.
