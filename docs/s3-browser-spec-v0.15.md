# S3 Browser — Specification
**Version:** 0.15
**Status:** Draft
**Date:** 2026-05-19
**Changes from v0.15 from v0.14:** Corrected "personal-use tool" framing in §4.9 and §4.11 to reflect that the application serves any user who supplies valid bucket credentials, not a single personal user.

**Changes from v0.14 from v0.13.1:** Tightened REQ-7. Removed stale signing utility reference from §4.3. Cut §4.4 transitive dependency paragraph. Tightened §4.2 file:// mention to cross-reference §4.13. Fixed §4.6 queueSize default (4 not 3); softened concurrency math; clarified queueSize as recommendation. Specified §4.7 page-size override as application setting in localStorage. Updated §4.12 capability state to localStorage with Refresh Permissions action and credential-change reset. Tightened §4.15 startedAt field. Added MinIO forcePathStyle caveat to §4.8. Added summary intro to §5 Provider Matrix.

**Changes from v0.13.1 (bugfix from v0.13):** Corrected §4.6 and §4.15: `lib-storage` is restored as the upload mechanism. `upload.uploadId` is a public property set immediately after `CreateMultipartUpload` completes, confirmed from source code. `lib-storage` with `leavePartsOnError: true` is used for initial uploads; raw SDK commands are used only for the resume path. IndexedDB schema simplified — `completedParts` field removed; `ListParts` is the ground truth on resume.

**Changes from v0.13 from v0.12:** Added REQ-8 (best-effort resumable uploads). Rewrote §4.6 upload section: raw multipart SDK commands replace lib-storage for files ≥ 5 MB; dynamic part size calculation; UX requirements for long-running uploads (speed/ETA, beforeunload, Notification API, 50 GB native tool guidance). Added §4.15 (Resumable Upload State: IndexedDB schema, file identity, resume sequence, UploadId expiration, duplicate detection, concurrent tab conflict). Updated §4.11 (resumability now implemented). Updated §4.14 (Resuming state). Removed resumable uploads from §6 Out of Scope. Updated §4.10 (upload retry reflects resume model).

**Changes from v0.12 from v0.11:** Added §4.13 `file://` protocol compatibility table and implementation requirement for browser-context banner. Updated §4.2 (file:// as supported context; localhost for dev; preflight-masks-auth snag). Updated §4.3 (inlined JS build for file:// Chrome compatibility). Updated §4.4 (ResponseContentDisposition for downloads). Updated §4.6 (abort Upload instance on failure). Updated §4.7 (navigation resets listing state and ContinuationToken). Updated §4.10 (CORS masking guidance; upload abort cross-reference). Updated §4.14 (prefix navigation state flush).

**Changes from v0.11 from v0.10:** Rewrote §4.12 (capability detection): removed write-probe in favour of natural list probe + optimistic enablement with graceful failure. Updated REQ-7 to reflect reactive model. Updated §4.9 CSP (connect-src deployment guidance, meta-tag warning). Updated §4.5 (softened Credential Management API language; clarified sessionStorage is reduced-persistence, not secure). Updated §4.10 (cancellation: explicit note that abort only runs on graceful in-app cancellation). Added memory expectations to §4.13. Added §4.14 (UI and Session State Model).

**Changes from v0.9:** Resolved all open review feedback. Added §1 General Design Principles. Added REQ-7 (capability detection). Added §3.9 Security Model, §3.10 Failure Handling, §3.11 Browser-Only Consequences, §3.12 Browser Compatibility. Simplified upload to single stack (removed XHR path). Updated §3.3 (vendored dependencies, no CDN). Updated §3.5 (secret key as password credential). Updated §3.7 (progressive listing, per-provider page-size defaults). Updated §3.8 (manual provider override). Updated §3.6 (softened N=2 wording). Updated §4 Group A (IND-1 demoted). Closed all previously open questions.

---

## 1. Purpose

A browser-based web application that allows a user to browse, download, and upload objects in an S3-compatible object storage bucket (primary target: Backblaze B2). No backend is involved at any point in normal operation. All assets are served from a single self-hosted domain; no external runtime dependencies.

---

## 2. General Design Principles

These principles govern all decisions in this specification. Where a decision is not explicitly specified, these principles apply by default.

**Principle 1 — Sensible defaults with optional manual overrides.** The application should work correctly out of the box for the common case. Where behavior may need adjustment for edge cases, an override should be available rather than requiring users to know implementation details upfront.

**Principle 2 — Prefer simplicity; require justification for complexity.** If a requirement or preference leads to additional dependencies, branching logic, or implementation complexity that seems disproportionate to its value, it should be flagged and confirmed before implementation proceeds rather than accepted uncritically.

---

## 3. Requirements

| ID | Requirement |
|----|-------------|
| REQ-1 | The user shall provide a storage endpoint URL, bucket name, key ID, and secret key to configure access. |
| REQ-2 | The application shall list objects in the configured bucket. |
| REQ-3 | The application shall allow the user to download any listed object. |
| REQ-4 | The application shall allow the user to upload one or more files to the bucket. |
| REQ-5 | The application shall operate entirely within the browser — no server-side component. |
| REQ-6 | Any persistent state shall reside only within the browser (no external calls for state). |
| REQ-7 | The application shall disable operations not permitted by the supplied credentials, indicate why, and surface clear explanations — including raw provider errors — when permission failures occur. |
| REQ-8 | The application shall support best-effort resumable uploads for all multipart uploads (files ≥ 5 MB), persisting resume state across browser sessions using IndexedDB. |

> **Scope note:** Delete, rename, copy, and bucket management operations are explicitly out of scope for this version.

---

## 4. Implementation Decisions

Each decision below identifies the requirement(s) it serves. Decisions not traceable to a requirement are excluded.

---

### 4.1 Use the S3-Compatible API

**Serves:** REQ-2, REQ-3, REQ-4, REQ-5

Backblaze B2 exposes an S3-compatible endpoint at `https://s3.<region>.backblazeb2.com`. <sup>[[B2-1]](#ref-b2-1)</sup> All target operations (list, get, put) are available there.

Using this API rather than the B2 native API (`api.backblazeb2.com`) is justified because:
- The AWS SDK for JavaScript v3 supports it without modification
- It generalizes to other providers (Wasabi, MinIO, etc.) by changing only the endpoint — fulfilling REQ-1's provider-agnostic credential model with no code changes

**Snag:** B2 does not support virtual-hosted-style URLs (e.g. `bucket.s3.region.backblazeb2.com`). Path-style URLs must be forced. Failure to do this causes all requests to fail in a way that is difficult to distinguish from an auth error — the bucket name ends up in the wrong part of the URL. See §4.3 and §5, Group A.

---

### 4.2 CORS Configuration (Provider-Side Prerequisite)

**Serves:** REQ-5

Browsers enforce the same-origin policy. Without CORS headers from the provider, the browser will block every API response regardless of whether the request succeeded. This is a **blocking prerequisite** — the application cannot function without it.

**Primary deployment target** is a self-hosted domain. `AllowedOrigins` should be set to the specific origin (e.g. `https://s3browser.yourdomain.com`).

**`file://` protocol** is a supported but secondary deployment context. Browsers send `Origin: null` from `file://`; add `"null"` to `AllowedOrigins` to enable it. See §4.13 for the full per-browser compatibility breakdown and the implementation requirement for a context warning banner.

**Local development** should use a loopback server (`http://localhost` or `http://127.0.0.1`) rather than opening the HTML file directly. `localhost` is a guaranteed secure context in all browsers, eliminates the `null` origin issue, and ensures consistent storage API behavior. `file://` should be treated as a supported runtime option for end users, not the recommended development workflow.

Required methods: `GET`, `PUT`, `HEAD`, `POST`
Required headers: `Authorization`, `Content-Type`, `Content-MD5`, `x-amz-*`, `ETag`
Expose headers: `ETag`, `Content-Length`, `Content-Type`
`MaxAgeSeconds`: use `3600` or less — **B2 enforces a hard ceiling of 86400 (24 hours)**. Values above this will be rejected. R2 and AWS have no stated upper bound. <sup>[[B2-2]](#ref-b2-2)</sup>

**Recommended configuration method:** AWS CLI targeting the provider's S3 endpoint. B2's web console CORS UI does not expose all needed fields.

**Snag (B2-specific):** If a B2 bucket has CORS rules set via the B2 Native API, applying S3-compatible CORS rules will fail with "The bucket contains B2 Native CORS rules." <sup>[[B2-3]](#ref-b2-3)</sup> The native rules must be removed first using the B2 CLI before S3 CORS rules can be applied. Users coming from previous B2 Native API setups will hit this.

**Snag:** CORS is set per bucket. If the user points the app at a bucket they do not control, CORS cannot be configured and the app will not work. This must be documented clearly in the UI.

**Snag — preflight masks auth errors:** Browser `OPTIONS` preflight requests do not include the S3 `Authorization` header. If the endpoint URL, bucket name, or credentials are incorrect, some providers reject the preflight with a `403` or `401` before evaluating CORS rules at all. The browser then reports this purely as a CORS violation, completely hiding the underlying auth or routing error. This is one of the most reliably misleading error states in S3 browser integration. See §4.10 for implementation guidance on surfacing this correctly.

**Note (Wasabi):** Wasabi requires no CORS configuration. It automatically returns permissive CORS headers for any request that includes an `Origin` header. Wasabi users can skip this prerequisite entirely. <sup>[[WA-1]](#ref-wa-1)</sup>

---

### 4.3 AWS SDK for JavaScript v3 and Dependency Management

**Serves:** REQ-2, REQ-3, REQ-4, REQ-5

`@aws-sdk/client-s3` provides typed commands for all required operations:

| Requirement | SDK Command |
|-------------|-------------|
| REQ-2 (list) | `ListObjectsV2Command` |
| REQ-3 (download) | Presigned URL via `@aws-sdk/s3-request-presigner` (see §4.4) |
| REQ-4 (upload) | `Upload` from `@aws-sdk/lib-storage` (see §4.6) |

Client must be instantiated with:
- `endpoint`: user-supplied (REQ-1)
- `region`: extracted from endpoint URL where pattern is known, otherwise user-supplied (see §5, Group C)
- `credentials`: `{ accessKeyId, secretAccessKey }` from user input (REQ-1)
- `forcePathStyle`: derived from provider identity (see §4.8 and §5, Group A)

**Snag (B2-specific):** Backblaze B2 explicitly prohibits use of the master application key with the S3-compatible API. <sup>[[B2-1]](#ref-b2-1)</sup> Users must create a dedicated application key. This is a common first-time setup failure and should be surfaced in the app's credential help text.

#### Dependency management

All JavaScript dependencies shall be vendored — bundled and served from the same domain as the application. No external CDN imports at runtime (no `esm.sh`, no `unpkg`, no `jsdelivr`).

**Rationale:** Serving assets from a single domain is required for:
- A workable Content Security Policy (see §4.9)
- Elimination of CDN availability as a failure mode
- Supply chain integrity — third-party CDNs can serve modified code
- Consistent behavior across network environments

**Build requirement:** A minimal build step (e.g. `esbuild`, `vite`, or `rollup`) is required to bundle dependencies into a single self-hosted JS file. The application is no longer a single-file artifact in the source sense, but all runtime assets originate from one domain. Dependency versions must be pinned in `package.json`.

**Affected packages:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`.

**`file://` compatibility note:** Chrome blocks cross-origin ES module imports from `file://` contexts, which means a multi-file deployment (separate HTML + JS bundle) will fail silently in Chrome when opened as a local file. To support `file://` usage across all target browsers, the build should produce a fully self-contained HTML file with the JS bundle inlined via a `<script>` tag. This is achievable with standard bundlers (esbuild `--bundle`, vite `build` with inline configuration). Firefox does not have this restriction, but aligning on inlined output ensures consistent behaviour. See §4.13 for the full per-browser `file://` breakdown.

---

### 4.4 Presigned URLs for Download

**Serves:** REQ-3

Rather than piping `GetObject` response bytes through JavaScript, generate a presigned URL using `@aws-sdk/s3-request-presigner` and trigger a standard browser download. This:
- Eliminates the need to buffer object data in JavaScript
- Works correctly for objects of any size
- Requires no additional permissions beyond what REQ-3 already needs

All providers in scope support presigned GET URLs via the S3-compatible API. See §5, Group E.

**`ResponseContentDisposition`:** When generating the presigned URL, the `GetObjectCommand` input must include a `ResponseContentDisposition` parameter to force a clean browser download with the correct filename:

```
ResponseContentDisposition: 'attachment; filename="<leaf-name>"'
```

Where `<leaf-name>` is the final segment of the object key (everything after the last `/`). Without this, objects stored with a generic content type (e.g. `application/octet-stream`) may open in a browser tab as raw bytes, or download with a mangled filename. Baking the disposition into the presigned URL query parameters ensures consistent download behaviour regardless of the object's stored metadata.

**Verification note:** B2's S3-compatible API supports `response-content-disposition` as a presigned URL parameter, but this should be explicitly verified against B2's API during implementation, as B2 has historically had subtle metadata handling differences from AWS S3.


---

### 4.5 Credential Storage

**Serves:** REQ-1, REQ-6

The four credential fields from REQ-1 persist across interactions and optionally across sessions.

| Field | Storage | Input treatment | Rationale |
|-------|---------|-----------------|-----------|
| Endpoint URL | `localStorage` | Text | Not sensitive |
| Bucket name | `localStorage` | Text | Not sensitive |
| Key ID | `localStorage` | Text | Low sensitivity |
| Secret key | `sessionStorage` | **Password field** | Sensitive; cleared on tab close |
| Provider identity | `localStorage` | — (derived) | Not sensitive |

**Secret key treatment:** The secret key input must use `type="password"` — masked on screen, excluded from browser autofill suggestions for general text, and not logged to the console or DOM. The browser's native credential manager (Credential Management API, `PasswordCredential`) may be used opportunistically where supported and reliable, allowing the browser to offer to save and autofill the secret key securely. Implementations should fall back to `sessionStorage` silently when the API is unavailable or behaves inconsistently (notably Safari and some mobile browsers). This is consistent with how passwords are treated in well-behaved web applications.

**Snag:** `sessionStorage` and `localStorage` store values as plaintext at the storage layer. `sessionStorage` provides reduced persistence duration — it is cleared on tab close — but is not meaningfully secure storage. Some browsers with aggressive session restoration may persist `sessionStorage` across crashes. The password field treatment mitigates user-facing exposure; the underlying plaintext storage risk is accepted for this use case and is documented in the security model (§4.9).

---

### 4.6 Upload Implementation and Concurrency

**Serves:** REQ-4

#### Upload path by file size

| File size | SDK method | Resumable |
|-----------|-----------|-----------|
| < 5 MB | `PutObjectCommand` — single atomic request | No — operation is atomic; restart is cheap |
| ≥ 5 MB | `lib-storage` `Upload` with `leavePartsOnError: true` | Yes — via §4.15 |

Progress for files below the multipart threshold reflects request completion (indeterminate indicator). This is consistent with actual browser capabilities for single-request uploads and avoids a dual-stack design (Principle 2).

#### `lib-storage` for multipart uploads

`lib-storage`'s `Upload` class exposes a public `uploadId` property that is set as soon as `CreateMultipartUpload` completes — before any parts are uploaded and before any failure can occur. This makes it directly usable for resumable uploads without dropping to raw SDK commands for the initial upload attempt.

Required configuration:
- `leavePartsOnError: true` — prevents `lib-storage` from automatically calling `AbortMultipartUpload` on failure, leaving the multipart session open for resume
- `partSize` — set dynamically per file (see below)
- `queueSize` — controls internal part-level parallelism (default 4). May optionally be reduced if total concurrent requests across two simultaneous file uploads is a concern for the target environment.

**`uploadId` extraction:** In the first `httpUploadProgress` event handler, `upload.uploadId` is already populated. Persist it to IndexedDB at this point (see §4.15). On failure, the value remains accessible on the `Upload` instance.

**Resume path:** `lib-storage` cannot resume a partially completed multipart upload within the same instance. On resume, raw SDK commands are used: `ListParts` to recover completed parts, then `UploadPartCommand` for remaining parts, then `CompleteMultipartUploadCommand`. The `UploadId` is portable — it does not matter that `lib-storage` created it.

#### Dynamic part size calculation

Part size must be calculated per file to stay within the 10,000-part limit enforced by all providers:

```
partSize = max(5 MB, ceil(fileSize / 10,000))
```

Examples: a 10 GB file → 5 MB parts (minimum floor); a 250 GB file → 26 MB parts; a 10 TB file → 1 GB parts.

The calculated part size must be stored in the resume record (§4.15) and reproduced exactly on resume. Using a different part size on resume causes `CompleteMultipartUpload` to fail because the provider expects a consistent part layout.

#### UX requirements for long-running uploads

- **Speed and time remaining:** Display rolling-average upload speed and estimated time remaining, derived from bytes transferred and elapsed time.
- **`beforeunload` warning:** Register `window.addEventListener('beforeunload', ...)` while any upload is active. The browser must prompt before tab close.
- **Page Visibility API:** On `visibilitychange`, log when the tab becomes hidden. Uploads continue — browsers do not pause active network requests — but the event aids post-failure diagnosis.
- **Completion notification:** Request Notification API permission at first upload start. Fire a notification on completion including filename and destination. Required for uploads measured in hours where the user will not be watching the tab.
- **Large file guidance:** For files above 50 GB, display a non-blocking dismissible note recommending native tools (`rclone`, B2 CLI, AWS CLI) as an alternative. These tools support resumability, checksumming, and bandwidth throttling outside browser constraints. Users may proceed in-browser after acknowledging.

#### Concurrency model

Uploads use a bounded concurrency queue: N upload slots run simultaneously; additional files wait and are promoted as slots free up.

**Default N = 2**, chosen as a conservative default to avoid saturating browser resources and to leave headroom for other concurrent requests (listing, downloads). N=2 is not derived from a precise connection pool calculation — HTTP/2 multiplexing makes such calculations provider- and browser-dependent — but is a pragmatic starting point that can be adjusted if profiling shows it is too conservative.

`lib-storage` internally parallelizes part uploads within each file (`queueSize`, default 4). N=2 at the file level is a conservative default chosen to avoid saturating browser resources; the exact concurrent request count depends on queueSize and whether uploads happen to run in parallel.

**Snag (B2):** Browser tab closure or navigation during a multipart upload will leave an incomplete multipart upload on B2. B2 does not automatically clean these up, and incomplete uploads are billed as storage. Lifecycle rules to abort incomplete multipart uploads should be set on the bucket. This is a user documentation concern, not app logic.

**Snag — multipart failure handling:** On any non-resumable failure (UploadId expired, user-initiated abort, unrecoverable error), the implementation must call `AbortMultipartUploadCommand` immediately to clean up in-flight parts server-side, clear the IndexedDB resume record (§4.15), and mark the file as failed in the queue. For transient failures (network interruption), the implementation should retain the resume record and offer the user the option to resume rather than immediately aborting. See §4.10 and §4.15.

**Note (R2 contrast):** R2 automatically aborts incomplete multipart uploads after 7 days by default. No lifecycle rule is needed for R2. <sup>[[CF-3]](#ref-cf-3)</sup>

---

### 4.7 Object Listing, Hierarchy Simulation, and Pagination

**Serves:** REQ-2

S3 has no native folder concept. Hierarchy is simulated using `Delimiter: "/"` and `Prefix` parameters in `ListObjectsV2`. The response returns:
- `Contents`: objects at the current level
- `CommonPrefixes`: "subdirectories" to navigate into

#### Pagination model

On navigating to a prefix, the application fetches one page of results and renders it immediately. If more results exist (indicated by `IsTruncated: true` in the response), a **Load More** button is shown below the listing. Each press of Load More fetches the next page and appends it to the current view. Pagination is entirely user-driven — no automatic background fetching occurs.

Each page is fetched using `ListObjectsV2` with a `MaxKeys` parameter. The default page size varies by provider:

| Provider | Default `MaxKeys` per page | Rationale |
|----------|---------------------------|-----------|
| Backblaze B2 | 200 | List operations are billed as Class C; each Load More press is a visible, deliberate action that incurs a cost the user can reason about |
| All other providers | 1000 | API maximum per call; no per-call cost concern |

These are defaults. The page size is configurable via the application settings panel, persisted in `localStorage` alongside other configuration. (Principle 1)

**Rationale (Principle 2):** Automatic background pagination requires a state machine tracking in-flight requests, handling navigation-away mid-fetch, and coordinating with cache invalidation. User-driven pagination is simpler to implement and more predictable to use — the listing state does not change while the user is interacting with it.

**Snag:** `ListObjectsV2` is a Class C operation on B2 and incurs per-call cost. <sup>[[B2-2]](#ref-b2-2)</sup> The Load More model makes this cost legible — each button press maps to one API call. The app must not re-fetch on every keystroke of any search/filter — filtering operates against the in-memory cache of already-loaded results.

**Cache invalidation:** The in-memory listing cache for the current prefix is invalidated and re-fetched after a successful upload batch completes.

**Navigation resets listing state:** Navigating to a new prefix — including entering a simulated subdirectory (`CommonPrefixes` entry) or pressing back to a parent prefix — must completely flush the current in-memory results array and reset `ContinuationToken` to `null`. Failure to do so will cause the next `Load More` fetch to continue pagination from the wrong position in the wrong prefix and append results from the previous directory to the new one. This state reset must occur synchronously before the first listing fetch for the new prefix is issued.

---

### 4.8 Provider Identity and Manual Override

**Serves:** REQ-1, REQ-4, REQ-5 (transitive — gates provider-specific behavior in §4.3, §4.6)

To apply provider-specific behavior (`forcePathStyle`, region derivation, CORS guidance) without affecting other providers, the app must establish provider identity at configuration time.

#### Detection strategy

Provider identity is established by matching the endpoint URL against known patterns when the user saves configuration. The result is stored alongside other non-sensitive credential fields (REQ-6).

| Endpoint pattern | Auto-detected provider | Behavior applied |
|-----------------|----------------------|-----------------|
| `*.r2.cloudflarestorage.com` | Cloudflare R2 | `forcePathStyle: false`; `region: "auto"` |
| `*.backblazeb2.com` | Backblaze B2 | `forcePathStyle: true`; region extracted from URL segment |
| `*.wasabisys.com` | Wasabi | `forcePathStyle: false`; region extracted from URL; no CORS config needed |
| Anything else | Generic S3 | `forcePathStyle: false`; region extracted from URL or user-supplied |

**MinIO note:** MinIO is not detectable by endpoint pattern (the URL is user-defined) and typically requires `forcePathStyle: true`, which conflicts with the Generic S3 default of `false`. MinIO users must use the manual override. This should be called out in setup documentation.

#### Manual override

Auto-detection fails for reverse proxies, custom domains, and non-standard deployments. A manual provider selector must be available in the UI, defaulting to the auto-detected value but overridable by the user (Principle 1).

The override is stored in `localStorage` alongside other configuration.

**Snag:** If `forcePathStyle` is set incorrectly, requests fail in a way that is difficult to distinguish from an auth error. The manual override allows users to correct this without needing to know why it happens.

**Note:** The official Cloudflare JS v3 example does not set `forcePathStyle` for R2. <sup>[[CF-4]](#ref-cf-4)</sup> The account-ID endpoint structure routes bucket access via path naturally without forcing it. `forcePathStyle: false` (SDK default) is correct for R2.

---

### 4.9 Security Model

**Serves:** REQ-5, REQ-6

#### Threat assumptions

This application is intended for use by any user who supplies valid bucket credentials — endpoint, bucket name, key ID, and secret key. It is not anonymously accessible; access requires a valid credential set. Any holder of a valid key has full access to whatever operations that key permits. The primary threat surface is:

1. **XSS** — A successful cross-site scripting attack against the app's origin gives the attacker immediate access to in-memory credentials and any credentials persisted in `localStorage`/`sessionStorage`. Because credentials provide direct bucket access, the consequences of XSS are severe.
2. **Credential theft via storage inspection** — Physical or remote access to the browser profile exposes `localStorage` contents, including key ID and endpoint. The secret key in `sessionStorage` is cleared on tab close, reducing but not eliminating window of exposure.
3. **Supply chain** — Tampered dependencies could exfiltrate credentials. Vendored dependencies with pinned versions (§4.3) are the primary mitigation.

#### Content Security Policy

A strict CSP must be defined for the application's serving domain. Because all dependencies are vendored (§4.3), the CSP can restrict script execution to `'self'` only, with no external script sources required.

**`script-src` is the strongest part of the CSP and is fully achievable.** Recommended baseline for script and style directives:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  img-src 'self' data:;
  connect-src <see below>;
```

**`connect-src` requires care.** The browser enforces `connect-src` against every outbound fetch or XHR, including S3 API calls. The correct value depends on which endpoints are in use:

| Scenario | Recommended `connect-src` value |
|---|---|
| Known providers only (B2, R2, Wasabi) | `'self' https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com` |
| Custom or unknown endpoints (MinIO, proxies, enterprise) | `'self' https:` |

Because REQ-1 allows the endpoint URL to be supplied at runtime by the user, the application cannot guarantee at deploy time which origins it will need to contact. For deployments that must support arbitrary endpoints, `connect-src https:` (all HTTPS origins) is the only workable option. This is weaker than enumerating specific origins but still meaningful when combined with `script-src 'self'`, which prevents injected scripts.

**Deployment guidance:** Operators who know their target provider(s) at deploy time should enumerate specific origins. Operators deploying a general-purpose instance should use `connect-src https:` and document the tradeoff. The CSP should be set as an HTTP response header (via the web server), not a `<meta>` tag, since `<meta>` CSP cannot restrict navigation and offers weaker protection.

**Snag:** A CDN-based dependency model (e.g. `esm.sh`) would require weakening `script-src` to allow third-party origins, significantly reducing CSP effectiveness. Vendored dependencies are a prerequisite for a meaningful `script-src 'self'` policy. This is the primary reason the dependency model changed in this version.

#### Credential handling

- Secret key: masked input (`type="password"`), stored only in `sessionStorage` or browser Credential Management API, never `localStorage`, never logged
- Key ID and endpoint: stored in `localStorage`; not secret but should not be embedded in page source
- All credential fields: cleared on explicit "disconnect" action by the user

#### Credential scoping guidance

Users should be strongly encouraged (via UI guidance at credential entry) to use bucket-scoped application keys with minimum necessary permissions. For a read/download-only use case, keys should not include write permissions. This limits blast radius in the event of credential compromise.

#### Browser trust assumption

The application assumes the user's browser and browser profile are not compromised. It provides no protection against an attacker with local access to the browser profile.

---

### 4.10 Failure Handling and Recovery

**Serves:** REQ-4, REQ-2, REQ-3

The application is in early active development. Error visibility is a priority: errors should surface the underlying provider response, not just a generic message.

#### Error presentation

Every error state must communicate:

1. **What happened** — human-readable description of the failed operation
2. **Consequence** — what state the system may be in as a result (e.g. "Parts of this file may have been uploaded and will accrue storage charges until cleaned up")
3. **Resolution guidance** — what the user can do (e.g. "Check your bucket's incomplete multipart uploads and abort them via the B2 console or CLI")
4. **Raw backend error** — the HTTP status code, error code, and error message from the provider response, shown in a collapsible detail panel

#### CORS errors masking auth failures

The browser's CORS layer can obscure the true cause of failures, particularly during the initial listing probe. When an `OPTIONS` preflight fails — due to incorrect credentials, a wrong endpoint URL, or a mistyped bucket name — the provider rejects the preflight before evaluating CORS rules. The browser sees only a CORS violation and reports no HTTP status code or response body. This makes auth failures indistinguishable from genuine CORS misconfiguration in the browser console.

**Implementation guidance:** When the initial `ListObjectsV2` probe fails with a network or CORS error, the error message shown to the user must explicitly note: *"This may be a CORS error, or it may be an authentication or routing failure masked by the browser's CORS layer. Verify your endpoint URL, bucket name, and credentials using a non-browser tool (e.g. curl or the AWS CLI) to see the actual error response."*

#### Retry behavior

- **Upload:** On transient failure (network interruption), the resume record is retained in IndexedDB and the user is offered Resume or Dismiss. On non-resumable failure (UploadId expired, auth error, unrecoverable provider error), `AbortMultipartUploadCommand` is called, the IndexedDB record is cleared, and the file is marked failed. The user may re-add the file to start fresh. No automatic retry in v0.1.
- **Listing:** Failed listing requests show an error with a manual retry button. Load More failures show inline with a retry option.
- **Download:** Failed presigned URL generation or download initiation shows an error. The user may retry.

**No automatic backoff in v0.1.** Automatic retry with exponential backoff is a natural future addition but introduces state complexity (distinguishing transient from permanent errors, managing retry counters) that is deferred.

#### Multipart upload failure consequences

If a multipart upload fails mid-flight (network error, credential expiry, tab closure):
- B2: incomplete parts remain and are billed as storage until aborted. The app must surface this consequence explicitly when a multipart failure occurs.
- R2: incomplete uploads are automatically aborted after 7 days. <sup>[[CF-3]](#ref-cf-3)</sup> The app should note this in the error message to reduce user anxiety.

The app shall show which provider is in use so users know which consequence applies.

#### Cancellation

In-progress uploads may be cancelled by the user. Cancellation of a multipart upload must call `AbortMultipartUpload` to clean up in-flight parts on the provider side. If the abort call itself fails, the user must be notified with the same consequence and resolution guidance as a mid-flight failure.

**Important limitation:** `AbortMultipartUpload` is only called for graceful in-app cancellation — a deliberate user action within a running tab. It will not execute if the tab crashes, the browser is force-quit, the machine sleeps, or the network connection disappears before the abort can be issued. In these cases, incomplete multipart uploads are orphaned with the same consequences as a mid-flight failure (see above). Users should not assume that upload cleanup is guaranteed regardless of how the session ends.

---

### 4.11 Browser-Only Architecture Consequences

**Serves:** REQ-5

The absence of a backend is a deliberate design constraint (REQ-5). This section documents what that constraint categorically prevents, so these tradeoffs are explicit rather than implicit.

| Capability | Status | Reason |
|---|---|---|
| Temporary credential brokering (STS / OAuth) | Not available | Requires a server to issue short-lived tokens |
| Server-side policy mediation | Not available | No intermediate layer between browser and provider |
| Centralized audit logging | Not available | All operations appear directly under user credentials with no application-layer record |
| True resumable uploads | **Best-effort, implemented** | Upload ID and completed parts persisted in IndexedDB; resume offered on reconnect. Cross-session resumability is possible but limited by UploadId expiration on the provider side. See §4.15. |
| Credential revocation | Not available | No session layer; revocation requires rotating the key at the provider |
| Multi-user access control | Not available | Any user with the credentials has full key-level access |

These are accepted tradeoffs for a browser-only, credentials-supplied application with no backend. If any of these capabilities become requirements in the future, a backend component would need to be introduced.

---

### 4.12 Capability Detection

**Serves:** REQ-7

The application reflects known permission state in the UI and surfaces clear explanations when operations fail due to insufficient permissions. Detection is a combination of one natural probe (listing) and optimistic enablement with graceful failure for all other operations.

#### Why not write-probe upload permissions

An earlier design wrote a sentinel object (`_s3browser_probe`) and deleted it to test upload permissions. This approach was rejected because a write probe has unacceptable operational side effects on buckets that are not fully under the user's control:

- **Event notifications / webhooks:** A `PutObject` triggers any bucket notification rules configured on the provider, firing automation the user may not expect.
- **Replication:** Cross-region or cross-bucket replication picks up the probe object.
- **Versioning:** A `DeleteObject` on a versioned bucket creates a delete marker rather than removing the object, leaving permanent versioned artifacts.
- **Object Lock / WORM:** Deletion may be prohibited entirely, leaving the probe object permanently.
- **Lifecycle rules:** A probe object at a matching key prefix could trigger lifecycle actions.
- **Cost:** Every `PutObject` and `DeleteObject` is a billable operation on metered providers.

Writing to a bucket the user is trying to inspect is presumptuous. Optimistic enablement with clear failure messaging is both simpler and safer.

#### Detection model

| Operation | Detection method | UI behavior if denied |
|-----------|-----------------|----------------------|
| List / Browse | First `ListObjectsV2` call on navigation (naturally occurs anyway) | Browsing disabled; error shown with explanation |
| Download | Optimistic — presigned URL generation always succeeds client-side | Disabled after first `GetObject` failure with permission error |
| Upload | Optimistic — assume permitted until denied | Disabled after first upload failure with permission error |

**List** is the only operation that is probed naturally at connection time — the first navigation attempt either succeeds or returns `AccessDenied`. No additional API call is required.

**Download and upload** are optimistically enabled and the UI reflects a failure only after an actual attempt returns a permission error. This matches how well-behaved web applications handle capability discovery: try, then adapt.

#### Capability state

Capability state is stored in `localStorage` so that known-denied operations persist across sessions — a user with a read-only key does not see upload enabled on every new tab only to have it fail on first attempt.

Capability state remains advisory: permissions can change server-side at any time. Actual operation errors always take precedence and update the stored state immediately. The application must provide an explicit **Refresh Permissions** action (available wherever credentials are managed) that clears the stored capability state and re-runs the listing probe. Changing or clearing credentials must also automatically clear all stored capability state.

**UX:** Operations known to be denied show a tooltip or inline note explaining that the current credentials do not permit that action, with a suggestion to check key permissions at the provider. Operations not yet attempted are shown as enabled.

---

### 4.13 Browser Compatibility

**Serves:** REQ-5

#### Supported browsers

| Browser | Support tier | Notes |
|---------|-------------|-------|
| Firefox (current and current-1) | Primary | Full support required |
| Chrome / Chromium (current and current-1) | Primary | Full support required |
| Safari (current and current-1) | Secondary | Support required; known caveats apply (see below) |
| Mobile browsers | Best-effort | Not a primary target; layout should not break |

#### Safari-specific caveats

Safari has a history of non-standard behavior in areas this application depends on heavily:

- **Large Blob handling:** Safari imposes lower memory limits on `Blob` objects in JavaScript. Downloads of very large objects via presigned URL offload to the browser (avoiding JS buffering), which mitigates this. Upload of very large files via `lib-storage` may encounter memory pressure on Safari — this should be tested explicitly.
- **`sessionStorage` behavior:** Safari in private browsing mode throws on `sessionStorage` writes rather than failing silently. The credential storage layer must handle this gracefully.
- **Credential Management API:** Safari's implementation of the Credential Management API has historically lagged. The secret key storage path should fall back to `sessionStorage` if `PasswordCredential` is unavailable.
- **Streaming downloads:** Safari's handling of `Content-Disposition: attachment` from cross-origin presigned URLs has had inconsistencies. Test download behavior explicitly.

#### Memory expectations

Very large uploads and downloads may require substantial browser memory, particularly on Safari and mobile devices. Because downloads are handled via presigned URLs (the browser fetches directly, not through JavaScript), download memory pressure is low for most cases. Uploads stream through `lib-storage`, which buffers one part at a time; memory usage scales with part size rather than total file size. Users uploading very large files on memory-constrained devices (mobile, older hardware) should be aware that the browser may terminate the page if memory limits are exceeded.

#### `file://` protocol compatibility

The application supports the `file://` protocol (local file operation) as a secondary runtime context, with browser-specific caveats. The `file://` origin sends `Origin: null` consistently across all browsers; this is reliable and does not vary.

The following table documents which features work in each target browser when running from `file://`:

| Feature | Chrome / Chromium | Firefox | Safari |
|---------|:---:|:---:|:---:|
| SubtleCrypto (SDK signing) | ✅ | ✅ | ⚠️ Inconsistent |
| `sessionStorage` / `localStorage` | ✅ (null-origin scoping — shared across all local files) | ✅ | ⚠️ Unreliable in private mode |
| Single-file HTML with inlined JS | ✅ | ✅ | ⚠️ Generally works |
| Multi-file HTML + separate JS bundle | ❌ Blocked (ES module CORS) | ✅ | ⚠️ Unknown |
| `Origin: null` preflight | ✅ | ✅ | ✅ |
| Credential Management API | ❌ Not available | ❌ Not available | ❌ Not available |

**Chrome note:** Chrome blocks cross-origin ES module imports from `file://` entirely. A single-file HTML with inlined JS (produced by the build, per §4.3) avoids this. Additionally, `localStorage` in Chrome under `file://` uses a shared null origin — all local HTML files share the same storage namespace, which can cause key ID and endpoint values from one project to appear in another if both use this app.

**Firefox note:** The most permissive of the three. `file://` operation is reliable for single- and multi-file deployments.

**Safari note:** The least predictable. SubtleCrypto availability, storage APIs in private mode, and module loading all have known inconsistencies. Safari users running from `file://` should expect the most friction.

**Implementation requirement — browser context banner:** When the app detects it is running from a `file://` origin (`window.location.protocol === 'file:'`), it must display a dismissible informational banner. The banner should:

1. Identify that the app is running from a local file
2. Detect the current browser (via user agent, for informational purposes only — not for behaviour changes) and display the relevant row of caveats from the table above
3. Recommend using a local development server (`http://localhost`) for more reliable behaviour
4. Not block use of the application — it is informational only and must be dismissible

The banner content must reference the specific known limitations for the detected browser so users understand why a feature may not be working rather than assuming the app is broken.

#### Unsupported environments

- Internet Explorer (any version)
- Legacy Edge (EdgeHTML)
- WebViews in mobile apps (no explicit support)

---


### 4.14 UI and Session State Model

**Serves:** REQ-2, REQ-3, REQ-4, REQ-7

The application has enough behavioral complexity that a lightweight state model reduces implementation ambiguity. This is not a formal finite state machine — states can overlap — but defines the primary conditions the UI must represent.

#### Session states

These are mutually exclusive primary states governing overall UI mode:

| State | Description | Triggered by |
|-------|-------------|-------------|
| **Disconnected** | No credentials configured or credentials cleared. Only credential entry UI is shown. | App load with no saved credentials; user disconnect action |
| **Connecting** | Credentials saved; initial `ListObjectsV2` probe in flight to establish list permission. | User saves credentials |
| **Connected** | Initial list probe succeeded. Browsing, upload, and download UI are shown. | Successful first listing |
| **Connection Failed** | Initial list probe returned an error (auth failure, network error, CORS misconfiguration). Error shown with diagnostic detail. | First listing returns error |
| **Resuming** | App has detected an existing IndexedDB resume record and is verifying identity and calling `ListParts` before continuing upload. | User selects Resume on queued file with existing record |

#### Capability states

These are independent per-operation flags, updated reactively:

| Operation | States | Transition |
|-----------|--------|------------|
| List / Browse | Permitted → Denied | `AccessDenied` on any `ListObjectsV2` call |
| Download | Assumed permitted → Denied | `AccessDenied` on presigned URL use |
| Upload | Assumed permitted → Denied | `AccessDenied` or `403` on any upload attempt |

All operations start as **assumed permitted** once Connected. State transitions to **Denied** are permanent for the session unless credentials are changed.

#### Activity states

These are concurrent and do not block each other:

| State | Description |
|-------|-------------|
| **Idle** | No operations in progress |
| **Listing** | A `Load More` fetch is in flight for the current prefix |
| **Uploading** | One or more files are in the upload queue (active or pending slots) |
| **Uploading — Error** | One or more files in the queue have failed; others may still be in progress |

#### Error state

Errors do not replace the session state — they surface inline alongside the relevant operation. A listing error does not disconnect the session; an upload error does not stop other uploads in the queue. The session remains Connected unless a permission error transitions the relevant capability to Denied.

#### Prefix navigation and listing state

Navigating to a new prefix (entering a subdirectory or returning to a parent) is a state transition that must synchronously:

1. Clear the current in-memory results array
2. Reset `ContinuationToken` to `null`
3. Dismiss any visible `Load More` control
4. Begin a fresh first-page fetch for the new prefix

This must happen before any listing fetch for the new prefix is issued. See §4.7 for the listing behaviour specification.

### 4.15 Resumable Upload State

**Serves:** REQ-8

All multipart uploads (≥ 5 MB) are resumable across browser sessions. Resume state is persisted in IndexedDB, which survives tab close and browser restart and is available in all target browsers.

#### IndexedDB schema

Store name: `s3browser_uploads`
Record key: `{provider}:{endpoint}:{bucket}:{destinationKey}`

| Field | Type | Description |
|-------|------|-------------|
| `uploadId` | string | `UploadId` from `CreateMultipartUpload`, extracted from `upload.uploadId` on the first `httpUploadProgress` event |
| `partSize` | number | Part size in bytes — must be reproduced exactly on resume |
| `fileIdentity` | object | See below |
| `destinationKey` | string | Object key in the bucket |
| `startedAt` | number | Unix timestamp of when the upload began. Used to warn the user if the session may be approaching the provider's multipart expiry limit. Warning threshold is pending verification of B2's session duration (flagged as a pre-implementation task). |

Completed parts (PartNumber + ETag) are not stored locally — `ListParts` is called on resume to obtain the authoritative list from the provider. This avoids the risk of a locally stale part list caused by a crash between a part upload completing and the ETag being persisted.

#### File identity

When the user resumes, they must re-select the file via the file picker. The browser does not retain `File` handles across sessions. The implementation verifies the re-selected file against the stored identity before resuming:

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Filename |
| `size` | Yes | File size in bytes — most reliable discriminator |
| `lastModified` | Yes | File modification timestamp |
| `contentHash` | Recommended | SHA-256 of first and last 64 KB of file content, computed via SubtleCrypto. Protects against a different file that coincidentally shares name, size, and modification time. |

If the identity check fails, the app must warn the user and require confirmation before proceeding. It must not silently upload wrong-file data to an in-progress multipart session.

#### Resume sequence

1. User selects a file that has an existing IndexedDB record (matched by destination key)
2. App offers **Resume** or **Restart** — not automatic
3. If Resume:
   a. Verify file identity against the stored record (see above)
   b. Call `ListParts` against the stored `UploadId` — this is the authoritative list of what the provider has received
   c. If `NoSuchUpload`: UploadId has expired → clear IndexedDB record → inform user they must restart → stop
   d. Use the `ListParts` result as the completed parts list (ETags included)
   e. Continue uploading remaining parts using raw `UploadPartCommand` calls with the stored `partSize`, starting from the first part number not in the `ListParts` result
   f. Finalise with `CompleteMultipartUploadCommand` once all parts are uploaded
   g. Clear the IndexedDB record on success
4. If Restart: call `AbortMultipartUploadCommand` with the stored `UploadId`, clear the IndexedDB record, begin a fresh `lib-storage` upload

#### UploadId expiration

Provider multipart sessions have finite lifetimes. R2 expires sessions after 7 days. <sup>[[CF-3]](#ref-cf-3)</sup> B2's session duration limit must be verified before implementation — for very slow connections, a 250 GB upload may exceed it.

When `ListParts` returns `NoSuchUpload` the implementation must:
1. Clear the stale IndexedDB record
2. Inform the user clearly: the upload session has expired and cannot be resumed
3. Require a fresh start — do not attempt to create a new session silently

#### Duplicate detection

If a file is queued whose destination key already has an in-progress IndexedDB record, the app must detect this before calling `CreateMultipartUpload` and offer Resume or Restart. Silently creating a second `UploadId` for the same destination key would leave the first session orphaned and billing storage on B2.

#### Concurrent tab conflict

The IndexedDB record key includes the destination key. If two tabs attempt to write a resume record for the same destination key simultaneously, the second write overwrites the first. The implementation should detect an active upload for a given key (stored flag in the record) and warn the user if the same destination key is being uploaded from another tab.

#### IndexedDB and `file://` context

IndexedDB is available from `file://` in all target browsers but inherits the same null-origin scoping quirks as `localStorage` (see §4.13). In Chrome, all local files share one IndexedDB namespace — resume records from one project may be visible to another if both use this app. This is a known limitation of the `file://` context.


## 5. Provider Compatibility Catalog

**Serves:** REQ-1 (credential/endpoint model), REQ-2, REQ-3, REQ-4 (operation availability), REQ-5 (CORS prerequisite)

Provider differences fall into five groups. Each group represents a distinct dimension of variance with a discrete implementation impact. Differences within a group are handled in one place in the code; they do not multiply.

---

### Group A — Request Routing Style

Whether the SDK sends requests as path-style (`endpoint/bucket/key`) or virtual-hosted-style (`bucket.endpoint/key`). Controlled by the `forcePathStyle` SDK client option.

| Provider | Style Required | `forcePathStyle` | Source |
|----------|---------------|-----------------|--------|
| Backblaze B2 | Path only | `true` (mandatory) | <sup>[[B2-1]](#ref-b2-1)</sup> |
| MinIO (self-hosted) | Path default | `true` (recommended) | |
| AWS S3 | Virtual-hosted preferred | `false` (default) | <sup>[[AWS-2]](#ref-aws-2)</sup> |
| Wasabi | Either | `false` (default) | <sup>[[WA-2]](#ref-wa-2)</sup> |
| Cloudflare R2 | Virtual-hosted | `false` (default) | <sup>[[CF-4]](#ref-cf-4)</sup> |
| DigitalOcean Spaces | Either | `false` (default) | |

**Implementation impact:** One boolean on S3Client instantiation, derived from provider identity (§4.8). Setting `true` universally is not safe for R2 (which expects virtual-hosted style by default per official documentation). Per-provider values via §4.8 are required.

**Snag:** If `forcePathStyle` is wrong for the provider, requests fail in a way that is difficult to distinguish from an auth error. The manual provider override (§4.8) allows correction without code changes.

**Note on AWS path-style deprecation:** AWS deprecated path-style access for buckets created after September 2020. Path-style still functions for pre-deprecation buckets and for non-AWS S3-compatible providers. The deprecation does not affect this application's target providers. <sup>[[AWS-2]](#ref-aws-2)</sup>

---

### Group B — Endpoint URL Shape

The structure of the endpoint URL the user must supply (REQ-1), and whether region is embedded in it.

| Provider | Endpoint pattern | Region in URL? | Source |
|----------|-----------------|----------------|--------|
| Backblaze B2 | `https://s3.{region}.backblazeb2.com` | Yes | <sup>[[B2-1]](#ref-b2-1)</sup> |
| Wasabi | `https://s3.{region}.wasabisys.com` | Yes | <sup>[[WA-2]](#ref-wa-2)</sup> |
| AWS S3 | `https://s3.{region}.amazonaws.com` | Yes | <sup>[[AWS-2]](#ref-aws-2)</sup> |
| DigitalOcean Spaces | `https://{region}.digitaloceanspaces.com` | Yes | |
| Cloudflare R2 | `https://{accountId}.r2.cloudflarestorage.com` | No | <sup>[[CF-4]](#ref-cf-4)</sup> |
| MinIO | User-defined | No | |

**Implementation impact:** For providers where region is embedded in the endpoint URL, the app can extract it automatically. For R2 and MinIO, region must be supplied separately or use a placeholder. See Group C.

---

### Group C — Region Model

How the provider uses (or ignores) the `region` parameter required by the AWS SDK client.

| Model | Members | SDK `region` value | Source |
|-------|---------|-------------------|--------|
| AWS-standard codes | AWS S3, Wasabi (partial), DigitalOcean Spaces | Standard code (e.g. `us-east-1`) | <sup>[[AWS-2]](#ref-aws-2), [[WA-2]](#ref-wa-2)</sup> |
| Proprietary codes | Backblaze B2 | B2-specific (e.g. `us-west-004`, `eu-central-003`) | <sup>[[B2-1]](#ref-b2-1)</sup> |
| Region-free | Cloudflare R2 | `"auto"` (also accepts `"us-east-1"` or empty as aliases) | <sup>[[CF-2]](#ref-cf-2)</sup> |
| Self-defined | MinIO | Deployment-specific; `"us-east-1"` as placeholder is common | |

**Snag:** B2's region codes do not match AWS region codes. A user supplying `us-west-2` when connecting to B2 will get auth or routing errors.

**Snag:** R2 does not use a conventional region. The SDK requires a non-empty string; `"auto"` is Cloudflare's documented value.

**Implementation impact:** Region cannot be reliably extracted from endpoint URL alone across all providers. For B2 it can (region segment is present and correct). For R2 and MinIO it cannot. If the app parses the endpoint for region, it must only do so when the pattern matches a known provider format (§4.8), with an explicit user-supplied field as fallback (Principle 1).

---

### Group D — CORS Configuration Method

How CORS rules are applied to the bucket. This affects setup documentation, not application code.

| Method | Members | Source |
|--------|---------|--------|
| S3 API (`PutBucketCors`) + Dashboard | AWS S3, Backblaze B2, Cloudflare R2, MinIO, DigitalOcean Spaces | <sup>[[B2-2]](#ref-b2-2), [[CF-5]](#ref-cf-5)</sup> |
| Automatic (no config) | Wasabi | <sup>[[WA-1]](#ref-wa-1)</sup> |

**Cloudflare R2 correction (from v0.7):** R2 has supported `PutBucketCors` via the S3 API since September 2022. AWS CLI pointed at the R2 endpoint works. <sup>[[CF-5]](#ref-cf-5), [[CF-6]](#ref-cf-6)</sup>

**Wasabi behavior:** Wasabi automatically returns permissive CORS headers whenever an `Origin` header is present. `PutBucketCors` is not supported and not needed. <sup>[[WA-1]](#ref-wa-1)</sup>

**Implementation impact:** Zero — the app does not call `PutBucketCors`. This distinction belongs in user-facing setup documentation only.

---

### Group E — Upload Size Limits

Single-PUT object size limits and multipart constraints.

| Provider | Max single-part PUT | Min multipart part | Max object size (multipart) | Source |
|----------|--------------------|--------------------|----------------------------|----|
| AWS S3 | 5 GiB | 5 MiB | ~48.8 TiB | <sup>[[AWS-1]](#ref-aws-1)</sup> |
| Backblaze B2 | 5 GB | 5 MB | 10 TB | <sup>[[B2-4]](#ref-b2-4), [[B2-5]](#ref-b2-5)</sup> |
| Wasabi | 5 GiB | 5 MiB | ~5 TiB | <sup>[[WA-2]](#ref-wa-2)</sup> |
| Cloudflare R2 | ~4.995 GiB | 5 MiB | ~4.995 TiB | <sup>[[CF-1]](#ref-cf-1)</sup> |
| MinIO | Configurable | 5 MiB (default) | Configurable | |

**R2 size limit (corrected from v0.6):** R2's max object size is ~4.995 TiB via multipart, comparable to other providers. An earlier version of this spec incorrectly stated 5 GB. <sup>[[CF-1]](#ref-cf-1)</sup>

**R2 multipart part uniformity:** R2 requires all parts except the last to be the same size. <sup>[[CF-3]](#ref-cf-3)</sup> `lib-storage` uses a fixed `partSizeInBytes` by default, satisfying this automatically. Custom multipart implementations must use uniform part sizes.

**R2 incomplete multipart cleanup:** R2 automatically aborts incomplete multipart uploads after 7 days by default. <sup>[[CF-3]](#ref-cf-3)</sup>

---

### Provider Matrix Summary

The following table summarises the per-provider values across Groups A–E above. All entries are derived from those sections; consult the relevant group for rationale and sources.

| | Group A (`forcePathStyle`) | Group B (endpoint) | Group C (region) | Group D (CORS config) | Group E (max object) |
|---|---|---|---|---|---|
| **Backblaze B2** | `true` | `s3.{region}.backblazeb2.com` | Proprietary codes | API + Dashboard | 10 TB |
| **AWS S3** | `false` | `s3.{region}.amazonaws.com` | Standard codes | API + Dashboard | ~48.8 TiB |
| **Wasabi** | `false` | `s3.{region}.wasabisys.com` | Standard-ish codes | Automatic | ~5 TiB |
| **Cloudflare R2** | `false` | `{accountId}.r2.cloudflarestorage.com` | Region-free (`"auto"`) | API + Dashboard | ~4.995 TiB |
| **MinIO** | `true` | User-defined | Self-defined | API + Dashboard | Configurable |
| **DigitalOcean Spaces** | `false` | `{region}.digitaloceanspaces.com` | Standard-ish codes | API + Dashboard | ~5 TiB |

---

### What Does Not Vary

The following are uniform across all providers in scope and require no provider-specific handling:

- **Signing algorithm:** AWS Signature v4 — identical across all
- **Core operation set:** `ListObjectsV2`, `GetObject`, `PutObject`, multipart upload — all supported
- **Presigned URL generation:** Supported by all listed providers for GET (REQ-3)
- **`Delimiter`/`Prefix` listing:** All support standard parameters for hierarchy simulation (REQ-2)
- **Credential shape:** Access Key ID + Secret Access Key — identical across all providers

---

## 6. Out of Scope (v0.1)

| Item | Reason deferred |
|------|-----------------|
| Object delete | Not a stated requirement |
| Credential encryption at rest | Accepted risk; Credential Management API addresses primary concern |
| Multiple saved profiles | Useful but not required |
| Provider presets UI (Wasabi, R2, etc.) | Generalization is structural (§5); presets are a convenience feature |
| Offline / service worker support | Not required |
| Bucket CORS configuration UI | Prerequisite configured externally |
| Automatic retry with backoff | Deferred from §4.10; added complexity not justified for v0.1 |
| Multi-user access control | Requires backend; see §4.11 |

---

## 7. Open Questions

All previously open questions (Q1–Q6) are resolved. No open questions remain for v0.1 scope.

---

## 8. References

Organized by provider. Citations appear as superscripts in the relevant sections above.

### Backblaze B2

<a name="ref-b2-1"></a>**[B2-1]** Backblaze. *Introduction to the S3-Compatible API* — endpoint format, region codes, path-style requirement, master key restriction, SigV4 authentication.
<https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api>

<a name="ref-b2-2"></a>**[B2-2]** Backblaze. *Enable CORS with the S3-Compatible API* — CORS configuration via S3 API, MaxAgeSeconds ceiling [0, 86400], Class C listing costs.
<https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-s3-compatible-api>

<a name="ref-b2-3"></a>**[B2-3]** Backblaze. *Cross-Origin Resource Sharing Rules* — Native vs S3 CORS rule conflict, CORS rule structure and limits.
<https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules>

<a name="ref-b2-4"></a>**[B2-4]** Backblaze. *Cloud Storage Files* — 5 GB single-file upload limit via CLI/Native API.
<https://www.backblaze.com/docs/cloud-storage-files>

<a name="ref-b2-5"></a>**[B2-5]** Backblaze. *Cloud Storage Large Files* — multipart upload, part size range (5 MB–5 GB), 10 TB max object.
<https://www.backblaze.com/docs/cloud-storage-large-files>

### Cloudflare R2

<a name="ref-cf-1"></a>**[CF-1]** Cloudflare. *R2 Platform Limits* — object size ~4.995 TiB, single-part upload ~4.995 GiB, 10,000 max parts.
<https://developers.cloudflare.com/r2/platform/limits/>

<a name="ref-cf-2"></a>**[CF-2]** Cloudflare. *R2 S3 API Compatibility* — region must be `"auto"` (or `us-east-1`/empty as aliases).
<https://developers.cloudflare.com/r2/api/s3/api/>

<a name="ref-cf-3"></a>**[CF-3]** Cloudflare. *Upload Objects* — multipart minimum part size 5 MiB, uniform part size requirement, 7-day auto-abort of incomplete multipart uploads.
<https://developers.cloudflare.com/r2/objects/upload-objects/>

<a name="ref-cf-4"></a>**[CF-4]** Cloudflare. *AWS SDK JS v3 Example* — official `S3Client` instantiation omits `forcePathStyle`; uses `region: "auto"` and account-ID endpoint.
<https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/>

<a name="ref-cf-5"></a>**[CF-5]** Cloudflare. *R2 Release Notes* — `PutBucketCors` added to R2 S3 API in September 2022; subsequent bug fixes to CORS validation.
<https://developers.cloudflare.com/r2/platform/release-notes/>

<a name="ref-cf-6"></a>**[CF-6]** Kian Akhavan (independent). *Configuring CORS on Cloudflare R2* — supplemental practical confirmation of `PutBucketCors` via S3 API on R2.
<https://kian.org.uk/configuring-cors-on-cloudflare-r2/>

### Wasabi

<a name="ref-wa-1"></a>**[WA-1]** Wasabi. *Bucket CORS Support With the Wasabi S3 API* — Wasabi automatically returns permissive CORS headers; `PutBucketCors` not supported.
<https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api>

<a name="ref-wa-2"></a>**[WA-2]** Wasabi. *API Reference Center* — endpoint base URL `https://s3.<region>.wasabisys.com`, SigV4 authentication, S3 compatibility scope.
<https://docs.wasabi.com/apidocs/api-guides>

### AWS S3

<a name="ref-aws-1"></a>**[AWS-1]** Amazon Web Services. *S3 Multipart Upload Limits* — max object 48.8 TiB, part size 5 MiB–5 GiB, max 10,000 parts.
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>

<a name="ref-aws-2"></a>**[AWS-2]** Amazon Web Services. *S3 Virtual Hosting of Buckets* — virtual-hosted style as preferred/default; path-style deprecated for buckets created after September 2020.
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html>

### Independent / Supplemental

<a name="ref-ind-1"></a>**[IND-1]** Team AWS. *AWS S3 URL Formats Explained* — supplemental commentary confirming B2, MinIO, Wasabi, and DigitalOcean Spaces commonly require or default to path-style. Not a normative source; provider-specific behavior derives from official documentation above.
<https://teamaws.com/aws-s3-url-formats-explained-path-style-vs-virtual-hosted-style/>
