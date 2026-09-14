# Cloudflare R2 — Provider Verification (Bucketer v1.14.0)

Reviewed: 2026-06-04. Sources fetched on same date unless otherwise noted.
Primary reference: [S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/)
(fetched 2026-06-04).

---

## Summary

Bucketer's R2 assumptions are largely correct and the app will function well against R2. The
most important finding is about CORS: contrary to the early history of R2 (which forced users
to dashboard or wrangler), `PutBucketCors` via the S3 API (`aws s3api put-bucket-cors`) is
fully supported and confirmed in the compatibility matrix as a Class A operation. The SetupGuide's
R2 CORS instructions are therefore correct. One meaningful endpoint-coverage gap exists: jurisdictional
endpoints (`<account-id>.eu.r2.cloudflarestorage.com`, `<account-id>.fedramp.r2.cloudflarestorage.com`)
match the current `\.r2\.cloudflarestorage\.com$` regex and are handled correctly with `region='auto'`,
so no code change is needed there. The critical API compatibility gap is versioning: R2 does not implement
`PutBucketVersioning`, `GetBucketVersioning`, or `ListObjectVersions` — Bucketer's HiddenVersions panel
will return empty results against R2 and the user will see no indication of why. The SetupGuide is
missing a note about credit-card-on-file requirement for R2 activation, an account ID location
instruction (needed to construct the endpoint URL), and an optional step pointing users to the
Cloudflare dashboard for CORS as an alternative.

---

## Bucketer's assumptions vs R2 docs (per-behaviour)

### 1. Endpoint hostnames

**Result: ✓ with jurisdictional caveat (no code change needed)**

Bucketer's pattern: `/\.r2\.cloudflarestorage\.com$/i` (hostname-only match).

Documented R2 S3 endpoint shapes:
- Standard: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- EU jurisdiction: `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`
- FedRAMP jurisdiction: `https://<ACCOUNT_ID>.fedramp.r2.cloudflarestorage.com`

Source: [Data location](https://developers.cloudflare.com/r2/reference/data-location/) (fetched
2026-06-04) and web search confirming jurisdictional formats.

The regex anchors on `.r2.cloudflarestorage.com` which matches all three shapes. Good.

**Not matched by the regex:**
- Custom-domain endpoints (`mybucket.example.com`) — will fall through to `GENERIC`, which is
  acceptable since provider-specific behaviour for R2 (region `auto`) would not be applied.
  Custom domains accessed via Bucketer will work operationally but the region auto-fill will not
  fire; the user must set region `auto` manually. This is an acceptable limitation.
- `r2.dev` managed subdomains (`pub-<hash>.r2.dev`) — these are public-read CDN URLs, not S3
  API endpoints, so they are irrelevant to Bucketer's credential flow.
- Workers-routed domains — R2 accessed through a Cloudflare Worker is not an S3-compatible
  endpoint and Bucketer cannot connect to it directly.

No regex change needed. A minor UX improvement would be to document the custom-domain caveat
in the SetupGuide or connection form, but this is low priority.

---

### 2. Region resolution — `extractRegion` returns `'auto'` always

**Result: ✓**

Cloudflare's own AWS SDK v3 example uses `region: "auto"`, annotated "Required by SDK but not
used by R2." The R2 compatibility matrix release notes confirm: "Empty values and `us-east-1`
alias to `auto`" for compatibility.

For jurisdictional endpoints, the jurisdiction is encoded in the **hostname** (e.g., `.eu.`),
not in the region string. The SigV4 region for EU and FedRAMP jurisdictional buckets is still
`'auto'`. Bucketer's `extractRegion` correctly returns `'auto'` for all `*.r2.cloudflarestorage.com`
hostnames. No change needed.

Source: [aws-sdk-js-v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
(fetched 2026-06-04); [release notes](https://developers.cloudflare.com/r2/platform/release-notes/)
entry dated 2022-05-05.

---

### 3. Virtual-hosted-style vs path-style (`requiresPathStyle(R2)` → false)

**Result: ✓**

R2 supports both virtual-hosted style and path-style access. The official SDK example omits
`forcePathStyle`, defaulting to virtual-hosted. Community sources confirm both work:
`<bucket>.<account-id>.r2.cloudflarestorage.com` (virtual-hosted) and
`<account-id>.r2.cloudflarestorage.com/<bucket>` (path-style). R2 documentation recommends
virtual-hosted style implicitly via its examples.

Bucketer's `requiresPathStyle(R2) → false` matches the recommended path. No change needed.

Note on how virtual-hosted style resolves: the SDK takes the account-scoped base endpoint
(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) and prefixes the bucket name as a subdomain,
producing `https://<BUCKET>.<ACCOUNT_ID>.r2.cloudflarestorage.com` for each request. This is
still matched by Bucketer's provider-detection regex since detection operates on the
**user-entered endpoint hostname** (account-scoped), not the per-request resolved hostname.

Sources: [aws-sdk-js-v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/);
BucketMate blog analysis (fetched 2026-06-04); Cloudflare community thread on path-style usage.

---

### 4. SigV4 authentication

**Result: ✓**

R2's S3 API uses AWS Signature Version 4. The endpoint requires `region: "auto"` for the signing
scope. This is unchanged since R2's launch. Standard AWS SDK v3 credential flow (access key ID +
secret access key) is confirmed correct.

---

### 5. CORS — `PutBucketCors` via S3 API

**Result: ✓ (the SetupGuide is correct)**

This is the most historically fraught area. Prior to September 2022, R2 did not support
`PutBucketCors` via the S3 API, forcing users to the Cloudflare dashboard or wrangler CLI.

Current state (2026-06-04): The [S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/)
lists `GetBucketCors`, `DeleteBucketCors`, and `PutBucketCors` as **supported** operations (with
minor gaps: the `x-amz-expected-bucket-owner` validation header is unimplemented, which is
irrelevant to Bucketer's use case). `PutBucketCors` is classified as a **Class A** operation
in [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The [release notes](https://developers.cloudflare.com/r2/platform/release-notes/) show ongoing
refinement:
- 2023-10-23: `PutBucketCors` now rejects requests with invalid origins
- 2022-11-30: Fixed wildcard CORS rules + presigned URLs; fixed case-sensitivity in `AllowedHeaders`
- 2022-01-30 (sic: likely 2023): Fixed empty-string rejection in `AllowedHeaders`

The SetupGuide's step 3 text ("R2 has supported `put-bucket-cors` via the S3 API since September
2022") is correct. The `aws s3api put-bucket-cors --endpoint-url ... --bucket ...` command format
shown is correct.

**CORS JSON template check:** `cors-config.js` emits `AllowedHeaders` including `amz-sdk-invocation-id`
and `amz-sdk-request` explicitly (from BUG-012 fix). R2's 2022-11-30 case-sensitivity fix and the
2023 `AllowedHeaders` validation hardening suggest R2 will honor these explicit entries. The CORS
template shape (single rule in a `CORSRules` array with `AllowedOrigins`, `AllowedMethods`,
`AllowedHeaders`, `ExposeHeaders`, `MaxAgeSeconds`) matches R2's documented fields exactly.

One minor note: R2's CORS docs emphasise that `AllowedOrigins` must be `scheme://host[:port]` with
no path component. Bucketer uses `window.location.origin` which returns exactly this shape (no
trailing slash, no path). No change needed.

---

### 6. ListObjectsV2

**Result: ✓**

Confirmed supported in the compatibility matrix. MaxKeys parameter is honoured; the S3 maximum of
1000 applies. R2 rate-limits the REST API at 1,200 requests per five minutes across all operations
([Limits](https://developers.cloudflare.com/r2/platform/limits/), fetched 2026-06-04).
`Delimiter`, `Prefix`, and `ContinuationToken` are all supported (standard V2 pagination).
Bucketer's `defaultMaxKeys(R2) → 1000` matches the S3 API maximum.

---

### 7. PutObject — payload limits

**Result: ✓ with note**

Single-part (non-multipart) upload maximum: **5 GiB** (exactly 4.995 GiB per limits page).
This is slightly lower than the AWS S3 single-part limit of 5 GB; in practice the AWS SDK
automatically switches to multipart above 5 MB by default, so the ceiling is rarely reached.
Bucketer uses multipart for large files, which is correct behaviour.

Source: [Limits](https://developers.cloudflare.com/r2/platform/limits/) (fetched 2026-06-04).

---

### 8. Multipart upload

**Result: ✓**

R2's multipart limits ([Multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/),
fetched 2026-06-04):
- Minimum part size: **5 MiB** (except last part) — matches AWS S3 and Bucketer's `calcPartSize` floor
- Maximum part size: **5 GiB**
- Maximum parts: **10,000** — matches AWS S3 and Bucketer's `calcPartSize` ceiling
- Maximum object size via multipart: **5 TiB** (10,000 × 5 GiB)
- Incomplete multipart uploads are auto-aborted after **7 days** — noted in the SetupGuide as a
  positive (orphaned parts won't accumulate)

`ListParts` is in the compatibility matrix as supported, confirming Bucketer's resume-upload path
(which uses `ListParts` to find already-uploaded parts) will work.

The SetupGuide's multipart abort note is correct and useful.

---

### 9. GetObject + presigned URLs

**Result: ✓ with note on presign expiry**

`GetObject` is fully supported including conditional request headers (`If-Match`, `If-None-Match`,
`If-Modified-Since`, `If-Unmodified-Since`).

Presigned URL maximum expiry: **7 days (604,800 seconds)** — same as AWS S3.
Source: [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) (fetched 2026-06-04).

`ResponseContentType` and other `Response*` override query parameters: the presigned URL docs
mention the 7-day limit but do not explicitly confirm `ResponseContentType` support. The S3
compatibility matrix marks `GetObject` as supported with no noted gaps in response header overrides,
suggesting these work, but this cannot be confirmed with certainty from documentation alone.

---

### 10. HeadObject

**Result: ✓**

Listed as supported in the compatibility matrix with no notable gaps. Conditional headers supported.

---

### 11. CopyObject

**Result: ✓**

`CopyObject` is fully supported. Historical period of disablement (Oct–Nov 2022) is long resolved.
`UploadPartCopy` is also re-enabled.

No explicit size limit for `CopyObject` is documented beyond the general 5 TiB object limit.
R2 supports copying multipart objects (objects originally created via multipart upload) without
restriction, per release notes.

---

### 12. DeleteObject + DeleteObjects

**Result: ✓**

Both operations are confirmed supported in the compatibility matrix. `DeleteObjects` (batch delete)
supports up to **1,000 keys per request**, matching the S3 API maximum and Bucketer's batch logic
(`delete-queue.js` sends batches of up to 1,000). Bucketer's parallel delete (3 concurrent batches,
v1.13.20) is compatible with R2's concurrency model; rate-limiting is the more likely constraint
than any R2-specific restriction.

---

### 13. Versioning

**Result: ✗ — R2 does not support versioning**

All three versioning operations are **unimplemented** in R2's S3 API:
- `PutBucketVersioning` — unsupported
- `GetBucketVersioning` — unsupported
- `ListObjectVersions` — unsupported

Source: [S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) under
"Unimplemented bucket-level operations" (fetched 2026-06-04).

**Impact on Bucketer:** The HiddenVersions panel in Bucketer issues `ListObjectVersions` to
enumerate delete markers and non-current versions. Against R2, this call will either return an
error or an empty response, and the panel will appear empty with no user-visible explanation.
Bucketer does not currently handle the absent-versioning case gracefully for R2.

No `x-amz-version-id` response header will be present on PutObject responses.

---

### 14. ListBuckets

**Result: ✓ with permission caveat**

`ListBuckets` is listed as supported in the compatibility matrix.

**Permissions constraint:** `ListBuckets` requires an **account-level** API token (not a
bucket-scoped token). R2 API tokens scoped to a single bucket cannot list all buckets. This
differs from AWS IAM where `s3:ListAllMyBuckets` is a separate permission within a user's
credential set. R2 users who create a bucket-scoped token for Bucketer will be unable to use the
bucket-picker if it relies on `ListBuckets`; they must type the bucket name manually. The SetupGuide
should call this out.

---

### 15. API token permissions

**Result: documented, SetupGuide partially correct**

Minimum scopes for full Bucketer functionality:
- **"Workers R2 Storage Bucket Item Write"** (bucket scope) — read, write, list, delete objects,
  multipart uploads on a specific bucket
- **"Workers R2 Storage Bucket Item Read"** (bucket scope) — read + list only

For `ListBuckets` (bucket picker):
- **"Workers R2 Storage Read"** (account scope) — required additionally; a bucket-scoped token
  cannot list buckets

Token creation path in current dashboard: Storage & databases → R2 → Overview → "Manage" under
API Tokens → "Create Account API token" or "Create User API token".

The SetupGuide's step 2 says "Get your R2 API token from the Cloudflare dashboard → R2 → Manage
R2 API Tokens." This is directionally correct but doesn't explain the account-level-vs-bucket-level
scope distinction.

Source: [Authentication](https://developers.cloudflare.com/r2/api/tokens/) (fetched 2026-06-04).

---

## Drift findings (severity-ordered)

### [R2-01] HiddenVersions panel silently empty against R2 — Medium

- **Severity:** Medium (feature not working, no explanation to user)
- **Location:** `src/components/HiddenVersions.jsx` (or equivalent versioning component)
- **Issue:** R2 does not implement `ListObjectVersions`, `PutBucketVersioning`, or
  `GetBucketVersioning`. Bucketer's HiddenVersions panel issues these calls without checking
  whether the provider supports versioning, so against R2 it will silently show empty results
  or an unhandled error.
- **Recommendation:** Gate the versioning UI on `provider !== PROVIDERS.R2` (and any other
  non-versioning providers), or query `GetBucketVersioning` first and show a "Versioning not
  supported by this provider" message if it fails.

---

### [R2-02] SetupGuide missing account-ID location instructions — Low

- **Severity:** Low (user friction, not a functional error)
- **Location:** `src/components/SetupGuide.jsx`, `GuideR2`, step 2
- **Issue:** The endpoint URL `https://<account-id>.r2.cloudflarestorage.com` uses `<account-id>`
  as a placeholder but the SetupGuide does not tell the user where to find their Cloudflare
  account ID. New users must hunt for it.
- **Recommendation:** Add one sentence: "Find your Account ID in the Cloudflare dashboard
  right sidebar, or at `dash.cloudflare.com/` under your profile."

---

### [R2-03] SetupGuide missing account-level token scope note for ListBuckets — Low

- **Severity:** Low (user experience — ListBuckets silently fails with bucket-scoped token)
- **Location:** `src/components/SetupGuide.jsx`, `GuideR2`, step 2
- **Issue:** R2 API tokens scoped to a single bucket cannot call `ListBuckets`. Users who follow
  the guide and create a bucket-scoped "Object Read & Write" token will not be able to use
  any bucket-picker functionality in Bucketer. No warning is provided.
- **Recommendation:** Add a note: "For bucket auto-discovery (listing all your buckets), create
  an account-level token with 'Workers R2 Storage Read' permission. For single-bucket access,
  a bucket-scoped 'Object Read & Write' token is sufficient — enter the bucket name manually."

---

### [R2-04] No billing-readiness note in SetupGuide — Trivial

- **Severity:** Trivial (user friction at account setup, before Bucketer is involved)
- **Location:** `src/components/SetupGuide.jsx`, `GuideR2`
- **Issue:** Activating R2 on a Cloudflare account requires a payment method on file even
  though the free tier covers most small-scale usage (10 GB / 1 M Class A ops / 10 M Class B
  ops per month). Users without a payment method will hit a billing wall before they can create
  a bucket. The SetupGuide gives no warning.
- **Recommendation:** Add a one-line note in the preamble: "R2 requires a payment method on
  file to activate, even on the free tier." Link to [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

---

### [R2-05] Jurisdictional endpoints not mentioned — Trivial

- **Severity:** Trivial (affects enterprise/GDPR users only)
- **Location:** `src/components/SetupGuide.jsx`, `GuideR2`, step 2 / connection form hint
- **Issue:** EU and FedRAMP jurisdictional endpoint formats are not mentioned. Users of
  jurisdiction-restricted buckets will not know to use
  `https://<account-id>.eu.r2.cloudflarestorage.com` instead of the standard endpoint.
- **Recommendation:** Add a collapsed note: "EU jurisdiction: use
  `https://<account-id>.eu.r2.cloudflarestorage.com`. The region remains `auto`."

---

## Getting-started links (canonical, fetched 2026-06-04)

| Step | URL | Notes |
|------|-----|-------|
| 1. Create Cloudflare account | https://dash.cloudflare.com/sign-up | — |
| 2. Enable R2 / overview | https://developers.cloudflare.com/r2/get-started/ | Requires payment method on file |
| 3. Create a bucket | https://developers.cloudflare.com/r2/buckets/create-buckets/ | Naming: lowercase letters, numbers, hyphens; 3–63 chars; jurisdiction option available |
| 4. Create API token | https://developers.cloudflare.com/r2/api/tokens/ | "Object Read & Write" (bucket) or "Storage Read" (account) for ListBuckets |
| 5. Configure CORS | https://developers.cloudflare.com/r2/buckets/cors/ | Dashboard and `aws s3api put-bucket-cors` both supported |
| 6. S3 API + SDKs | https://developers.cloudflare.com/r2/get-started/s3/ | Endpoint: `https://<account-id>.r2.cloudflarestorage.com`; region: `auto` |
| S3 compatibility matrix | https://developers.cloudflare.com/r2/api/s3/api/ | Ground truth for supported operations |
| Presigned URLs | https://developers.cloudflare.com/r2/api/s3/presigned-urls/ | Max expiry: 7 days |
| Limits | https://developers.cloudflare.com/r2/platform/limits/ | Object size: 5 TiB; single-part upload: 5 GiB; 1,200 req/5 min rate limit |
| Pricing | https://developers.cloudflare.com/r2/pricing/ | Free tier; Class A/B rates; egress-free |
| Jurisdictional buckets | https://developers.cloudflare.com/r2/reference/data-location/ | EU + FedRAMP endpoints; region still `auto` |

---

## Cost / quota gotchas

### Free tier (Standard storage, per month)
- Storage: **10 GB**
- Class A operations (writes/mutations): **1 million requests**
- Class B operations (reads): **10 million requests**
- Egress: **free** (zero egress fees from R2 to any internet destination — the primary
  differentiator vs AWS S3)

Source: [Pricing](https://developers.cloudflare.com/r2/pricing/) (fetched 2026-06-04).

### Paid rates (Standard storage)
- Storage: $0.015 / GB-month
- Class A (PutObject, CreateMultipartUpload, UploadPart, CompleteMultipartUpload,
  PutBucketCors, etc.): $4.50 / million requests
- Class B (GetObject, HeadObject, ListObjectsV2, ListParts, etc.): $0.36 / million requests
- Egress: $0.00

### Infrequent Access storage
- Storage: $0.01 / GB-month (lower storage cost)
- Class A: $9.00 / million (double Standard)
- Class B: $0.90 / million (2.5× Standard)
- Data retrieval: $0.01 / GB
- Minimum storage duration: 30 days (charged even if deleted earlier)
- Egress: $0.00

### Bucketer operation count per UI action (Standard storage)

| Action | S3 operations issued | Class | Approx cost at free tier |
|--------|----------------------|-------|--------------------------|
| Browse folder | 1 × ListObjectsV2 | B | ~$0.036 / 100 k browses |
| Upload file (small, <5 MB) | 1 × PutObject | A | ~$4.50 / 1 M uploads |
| Upload file (large, multipart) | 1 × CreateMultipartUpload + N × UploadPart + 1 × CompleteMultipartUpload | A | $4.50 / 1 M initiate+complete calls; parts are also Class A |
| Download / preview | 1 × GetObject or presigned URL fetch | B | ~$0.036 / 100 k downloads |
| Delete (batch) | 1 × DeleteObjects per 1,000 keys | A | $4.50 / 1 M calls |
| CORS setup (one-time) | 1 × PutBucketCors | A | negligible (one-time) |

The free tier (1 M Class A, 10 M Class B) is generous for personal and small-team use.
A user who browses 5,000 folders, uploads 5,000 small files, and downloads 5,000 files per
month stays well within the free tier.

### Jurisdictional buckets
The pricing page does not specify separate pricing for jurisdictional buckets; they appear to
use the same Standard storage rates. The jurisdiction constrains data residency, not cost.

### R2 rate-limit caution for bulk operations
R2 enforces a **1,200 requests per 5 minutes** REST API rate limit across all operations on an
account. Bucketer's parallel delete (3 concurrent batch-delete calls) and multipart upload
(concurrent part uploads) could approach this ceiling for very large bulk operations. Each
`DeleteObjects` call counts as 1 request regardless of how many keys it contains (up to 1,000),
so batching to 1,000 keys per call is the right mitigation and Bucketer already does this.

---

## Recommendations for SetupGuide.jsx / README

Priority-ordered:

1. **[R2-01] Add versioning not-supported note** — When a user is connected to R2 (detected by
   provider), the HiddenVersions panel (or wherever versioning-specific UI appears) should show
   a provider-aware message: "Cloudflare R2 does not support S3 object versioning."

2. **[R2-02] Add account ID location hint** — In `GuideR2` step 2, after the endpoint URL
   placeholder, add: "Your Account ID is shown in the Cloudflare dashboard right sidebar."

3. **[R2-03] Add token scope guidance** — Distinguish bucket-scoped (sufficient for single-bucket
   use) from account-scoped (required for listing all buckets). One sentence is enough.

4. **[R2-04] Add billing prerequisite note** — "R2 requires a payment method on file even for
   free-tier usage." Saves first-time users a surprise at account setup.

5. **[R2-05] Add jurisdictional endpoint hint** — One collapsed note for EU/FedRAMP users.

6. **No change needed on CORS** — The `aws s3api put-bucket-cors` approach is correct and confirmed
   supported. The CORS JSON template shape is valid for R2. The `amz-sdk-invocation-id` /
   `amz-sdk-request` explicit headers (BUG-012 fix) are correctly included and will be honoured by R2.
