# Backblaze B2 — Provider Verification (Bucketer v1.14.0)

**Review date**: 2026-06-04  
**Bucketer version**: v1.14.0  
**Sources fetched**: see "Getting-started links" section below

---

## Summary

Bucketer's B2 assumptions are largely correct but carry three drift risks. The most significant is the path-style URL assumption: B2's S3-compatible API now explicitly documents support for **both** virtual-hosted-style and path-style addressing, which means `requiresPathStyle(B2) → true` is not technically wrong, but it is no longer a *requirement* — it is a conservative choice whose rationale should be updated in code comments. The second risk is that the **CORS `AllowedHeaders` fix from BUG-012 remains fully aligned with current B2 behaviour**: Backblaze's own documentation confirms that CORS preflight headers are matched literally, wildcards only apply within the same prefix group, and `amz-sdk-invocation-id` / `amz-sdk-request` (which carry no `x-amz-` prefix) are not covered by `x-amz-*` — the explicit listing in `cors-config.js` is the only correct solution. The third risk is the `defaultMaxKeys=200` justification comment, which says ListObjectsV2 is "Class C (billed per call)" — current B2 pricing shows Class C operations are **free** for all pay-as-you-go accounts; the comment is misleading and should be updated, though keeping a smaller default is still a defensible UX choice for cost-transparency at the UI level.

**Recommended Application Key capabilities** for a Bucketer user (minimal set): `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`, `listBuckets` or `listAllBucketNames`, `readBuckets` (needed for `GetBucketCors`), `writeBuckets` (needed for `PutBucketCors` / `DeleteBucketCors`). `shareFiles` is not required for Bucketer's presigned-URL flow, which uses SigV4 signing rather than B2's native download authorisation tokens.

---

## Bucketer's assumptions vs B2 docs (per-behaviour)

### 1. Endpoint hostname pattern ✓

**Bucketer**: `*.backblazeb2.com$` (anchored, case-insensitive hostname match in `PATTERNS`)  
**B2 docs**: All S3-compatible endpoints are of the form `s3.<region>.backblazeb2.com`. No other hostname variants are documented (no CDN alias, no legacy short hostname).  
**Verdict**: Correct and sufficient. The `$` anchor prevents false positives on custom-prefixed hostnames such as `mybackblazeb2.com`.

Source: [How to Call the Backblaze B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api) (fetched 2026-06-04)

---

### 2. Region extraction regex ✓ (with minor gap)

**Bucketer**: `/^s3\.([^.]+)\.backblazeb2\.com$/i` → captures region segment  
**B2 docs (current regions)**:

| Logical region | S3 region ID | Endpoint |
|---|---|---|
| US West | `us-west-002`, `us-west-004` (and legacy `us-west-001`) | `s3.us-west-004.backblazeb2.com` |
| US East | `us-east-005` | `s3.us-east-005.backblazeb2.com` |
| EU Central | `eu-central-003` | `s3.eu-central-003.backblazeb2.com` |
| CA East | `ca-east-001` (inferred from naming pattern) | `s3.ca-east-001.backblazeb2.com` |

The regex correctly captures all of these since region IDs all match `[^.]+`. The fallback to `'us-east-1'` when extraction fails is a potential surprise: B2 uses its own region strings for SigV4 signing (e.g. `us-west-004`), not AWS region names. In practice, if a user pastes a correct B2 endpoint the regex will match and no fallback is exercised; the fallback only matters for an unparseable endpoint. It is therefore not a production bug but is worth noting for edge-case diagnostics.

Source: [Where are the Backblaze Cloud Storage Data Centers](https://www.backblaze.com/docs/cloud-storage-data-regions) (fetched 2026-06-04); [Backblaze adds US East region](https://www.backblaze.com/blog/backblaze-adds-us-east-region-expanding-location-choices-and-cloud-replication-options/) (fetched 2026-06-04)

---

### 3. Path-style URL requirement ⚠ (outdated rationale, not a bug)

**Bucketer**: `requiresPathStyle(B2) → true`  
**B2 docs**: The B2 S3-compatible API **supports both** URL styles:
- Virtual-hosted: `https://bucketname.s3.us-east-005.backblazeb2.com`
- Path-style: `https://s3.us-east-005.backblazeb2.com/bucketname`

The docs note that "the AWS SDKs and most integrations require only an endpoint URL" (meaning they append the bucket in the path themselves when you supply a base endpoint rather than a bucket-qualified hostname). Forcing path-style via `forcePathStyle: true` in the AWS SDK v3 client config is therefore still valid — it matches how users supply a plain regional endpoint — but the code comment `// B2 and MinIO require path-style URLs` overstates the constraint.

**Impact**: No functional impact today. If B2 were ever to enforce virtual-hosted style (unlikely), the current setting would break. More concretely, `forcePathStyle: true` suppresses virtual-hosted HTTPS for the SDK, which means any future B2 feature that requires a bucket-specific hostname would be unavailable. Recommend updating the comment to reflect "conservative choice for SDK compatibility with user-supplied regional endpoints" rather than "required".

Source: [How to Call the Backblaze B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api) (fetched 2026-06-04)

---

### 4. CORS configuration ✓ (BUG-012 fix remains correct)

**Bucketer (`cors-config.js`)**:
```json
"AllowedHeaders": ["Authorization", "Content-Type", "Content-MD5",
                   "x-amz-*", "amz-sdk-invocation-id", "amz-sdk-request", "ETag"]
```

**B2 docs**: CORS preflight matching rules require that *every* value in `Access-Control-Request-Headers` appears in the rule's `allowedHeaders` list. Wildcard matching uses a trailing `*` syntax that is anchored to a literal prefix: `x-bz-info-*` matches `x-bz-info-name` but not `amz-sdk-invocation-id`. The `x-amz-*` wildcard therefore covers `x-amz-content-sha256`, `x-amz-date`, etc., but **does not cover** `amz-sdk-invocation-id` or `amz-sdk-request` because neither begins with `x-amz-`. AWS SDK v3 injects both headers on every S3 request (see aws/aws-sdk-js-v3#1376), and without them in `allowedHeaders`, B2 rejects the preflight with a CORS error that has no clear diagnostic message in the browser.

The explicit listing of both `amz-sdk-*` headers in `cors-config.js` is therefore the correct and necessary fix. No Backblaze documentation explicitly names these headers (they are an AWS SDK v3 implementation detail), but the CORS mechanics confirm why they must be present.

Additionally, the `SetupGuide.jsx` B2 guide correctly includes a Step 3 to detect and clear any existing native B2 CORS rules before applying S3-compatible rules. This is documented B2 behaviour: rules set via the S3 API and rules set via the native API are stored in separate namespaces and the docs warn that native rules and S3 rules are returned separately — a `GetBucketCors` S3 call does not see native rules and vice versa. However, from testing and community reports, the presence of native rules does not block S3 CORS rules from applying; the documented risk is inconsistency rather than breakage. The SetupGuide's defensive step is still correct: clearing native rules avoids confusing duplicates and ensures a clean state.

Sources:  
- [Cloud Storage Cross-Origin Resource Sharing Rules](https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules) (fetched 2026-06-04)  
- [Set the CORS on an Existing Backblaze Bucket (s3-put-bucket-cors)](https://www.backblaze.com/apidocs/s3-put-bucket-cors) (fetched 2026-06-04)  
- [aws/aws-sdk-js-v3 CORS issue #1376](https://github.com/aws/aws-sdk-js-v3/issues/1376) (context)

---

### 5. ListObjectsV2 ✓ (class billing comment outdated — see [B2-01])

**Bucketer**: Uses `ListObjectsV2` with Delimiter, Prefix, MaxKeys (default 200), ContinuationToken. `defaultMaxKeys(B2) → 200` with comment "Class C (billed per call)".  
**B2 docs**: ListObjectsV2 is fully supported with all four parameters. Delimiter and Prefix work as documented. The maximum value of MaxKeys is 1000 (S3-standard). Pagination via `IsTruncated` + `NextContinuationToken` is implemented identically to S3.

**Class billing**: ListObjectsV2 is a **Class C** operation — but Class C operations are **free** for all standard pay-as-you-go B2 accounts. The comment in `provider.js` saying they are "billed per call" is factually incorrect per current B2 pricing. The 200-key default is still a reasonable UX choice (smaller pages mean less latency per page, visible progress for large buckets), but the billing rationale in the comment should be corrected.

Sources:  
- [Another Way to List Objects Within a Bucket (s3-list-objects-v2)](https://www.backblaze.com/apidocs/s3-list-objects-v2) (fetched 2026-06-04)  
- [Backblaze B2 API Transaction Pricing](https://www.backblaze.com/cloud-storage/transaction-pricing) (fetched 2026-06-04)

---

### 6. PutObject ✓

**B2 docs**: PutObject is supported. Single-part uploads are limited to 5 GB. Content-Type is accepted as supplied; B2 auto-detects `application/octet-stream` if Content-Type is absent. The API requires SigV4 (v2 signatures are rejected). No minimum object size.

No divergence from Bucketer's usage pattern. Bucketer uses multipart for files above a configurable threshold (default ~8 MB with `calcPartSize`), which is well above B2's 5 GB single-part maximum.

Source: [Introduction to the S3-Compatible API](https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api) (fetched 2026-06-04)

---

### 7. Multipart upload ✓

**B2 docs (S3-compatible)**:
- `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload` are all documented as supported S3-compat operations.
- **Minimum part size**: 5 MB (5,000,000 bytes) — same as S3 standard. This matches Bucketer's `calcPartSize` floor constraint.
- **Maximum parts**: 10,000 (same as S3 and B2 native).
- **Maximum part size**: 5 GiB (5,368,709,120 bytes).
- `ListParts` is supported for upload resume inspection.

B2 native uses `b2_start_large_file` / `b2_upload_part` with a recommended minimum of 5 MB as well. The S3-compat layer enforces the same 5 MB floor, so `calcPartSize`'s lower bound of `5 * 1024 * 1024` bytes is correct.

Sources:  
- [Upload One Part in a Multipart Large File Upload (s3-upload-part)](https://www.backblaze.com/apidocs/s3-upload-part) (fetched 2026-06-04)  
- [Backblaze multipart upload search results / Live Read docs](https://www.backblaze.com/docs/cloud-storage-enable-live-read-with-the-s3-compatible-api) (fetched 2026-06-04)

---

### 8. GetObject + presigned URLs ? (partial)

**B2 docs**: B2's S3-compatible API supports SigV4 presigned URLs. The B2 native download authorisation token maximum expiry is 604,800 seconds (7 days); presigned URL expiry for S3-compat URLs follows the same 7-day cap (this is standard SigV4 `X-Amz-Expires` maximum).

**ResponseContentType override**: Not confirmed via B2-specific documentation. B2 supports standard `response-content-type` query parameters for `GetObject`, but their handling of this parameter in presigned URLs is not explicitly documented. In practice, AWS SDK v3 presign for B2 works through community reports, but the exact parameter pass-through has not been confirmed in official B2 docs for this review cycle.

Bucketer uses presigned URLs for file preview (`GetObject` with `ResponseContentDisposition`). If B2 strips response override parameters on presigned requests, previews would serve with the original stored Content-Type rather than inline. This has not been reported as a field bug and appears to work in practice, but carries an unconfirmed documentation status.

Source: [Does B2 support Pre-Signed URLs?](https://help.backblaze.com/hc/en-us/articles/360047815993) (403 at review time — known to require login); [B2 get download authorization](https://www.backblaze.com/apidocs/b2-get-download-authorization) (fetched 2026-06-04)

---

### 9. HeadObject ✓

**B2 docs**: `HeadObject` is listed as a supported S3-compatible operation. Returns object metadata (Content-Type, Content-Length, ETag, Last-Modified) with no body. No B2-specific deviations are documented.

Source: [Introduction to the S3-Compatible API](https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api) (fetched 2026-06-04)

---

### 10. CopyObject ✓ (with same-account restriction)

**B2 docs**: `CopyObject` is supported. Single-part copy is limited to **5 GB**. For objects larger than 5 GB, `UploadPartCopy` must be used (multipart copy). Cross-bucket copy is supported when both buckets belong to the **same account** — cross-account copy is not supported.

**Unsupported**: Object tagging (`x-amz-tagging`) is explicitly rejected. The `x-amz-tagging-directive` header is accepted but silently ignored. Changing the checksum algorithm during copy is not supported.

No Bucketer operations currently depend on tagging, so the tagging restriction has no impact.

Source: [Create a Copy of an Existing Object (s3-copy-object)](https://www.backblaze.com/apidocs/s3-copy-object) (fetched 2026-06-04)

---

### 11. DeleteObject + DeleteObjects ✓ (versioning semantics matter)

**B2 docs**: Both single-object and batch-delete (`DeleteObjects`) are supported. The batch operation follows S3's 1000-object maximum per request. Partial-error responses follow S3's mixed `Deleted`/`Error` shape.

**Versioning interaction (critical)**: B2 buckets are versioned by default. `DeleteObject` without a `VersionId` creates a **hide marker** (B2's equivalent of a delete marker) on top of the existing version history — it does not immediately delete storage. Subsequent `ListObjectsV2` calls will not return the object, but a `ListObjectVersions` call will show the hide marker. Bucketer's `HiddenVersions` panel, which queries `ListObjectVersions`, will correctly surface these markers as `DeleteMarker` entries because B2 maps hide markers to the S3 `<DeleteMarker>` element in the S3-compat `ListObjectVersions` response.

To permanently remove a file and all its versions, `DeleteObject` must be called **with an explicit `VersionId`** for each version. Bucketer's batch-delete path uses `DeleteObjectsCommand` with keys only (no VersionId) — this is the correct behaviour for a "soft delete" UI, but users who expect permanent deletion with immediate storage reclaim may be surprised. This is a UX documentation gap, not a code bug.

Sources:  
- [Cloud Storage File Versions](https://www.backblaze.com/docs/cloud-storage-file-versions) (fetched 2026-06-04)  
- [List Metadata of Versions of Objects (s3-list-object-versions)](https://www.backblaze.com/apidocs/s3-list-object-versions) (fetched 2026-06-04)

---

### 12. Versioning ✓ (semantics understood correctly)

**B2 docs**: All B2 buckets are versioned by default; there is no API call to "enable versioning" as there is in S3 (where buckets start unversioned). B2's native `b2_hide_file` creates a hide marker; the S3-compat layer exposes these as `<DeleteMarker>` entries in `ListObjectVersions` responses with `IsLatest: true` and no ETag or size. Historical upload versions are exposed as `<Version>` entries. The `VersionId` in S3 responses corresponds to B2's file ID.

Bucketer's `HiddenVersions` panel iterates `ListObjectVersions` and distinguishes `DeleteMarker` entries from regular versions — this mapping is correct for B2.

Source: [How to Use S3-Compatible API Bucket Versions in Backblaze B2](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions) (fetched 2026-06-04)

---

### 13. ListBuckets ✓ (capability note — see recommendations)

**B2 docs**: `ListBuckets` (`s3:ListAllMyBuckets`) is a Class C (free) operation. It requires **either** the `listBuckets` capability **or** the `listAllBucketNames` capability on the application key. The `listAllBucketNames` capability is specifically designed for "SDK compatibility" — the AWS SDK v3 calls `ListBuckets` internally to verify the endpoint during client initialisation, and a bucket-restricted key with only `listBuckets` will fail this check unless `listAllBucketNames` is also granted. The SetupGuide Step 2 instructs users to create an application key with "access to this bucket" but does not explicitly mention adding `listAllBucketNames` — this is a documentation gap in the SetupGuide.

Source: [How to Use Backblaze B2 S3-Compatible App Keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys) (fetched 2026-06-04)

---

### 14. Application Key capabilities ✓ (mapping documented — [B2-02])

Per current Backblaze documentation, the S3-compatible API maps capabilities as follows:

| B2 Capability | S3-Compat Operations Unlocked |
|---|---|
| `listFiles` | `ListObjectsV2`, `ListMultipartUploads`, `ListParts` |
| `readFiles` | `GetObject`, `HeadObject`, `CopyObject` (source) |
| `writeFiles` | `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `DeleteObject` (by name — hides current version) |
| `deleteFiles` | `DeleteObject` (by VersionId — permanent), `AbortMultipartUpload` |
| `listBuckets` | `ListBuckets`, `HeadBucket` |
| `listAllBucketNames` | `ListBuckets` (for SDK initialisation with bucket-restricted keys) |
| `readBuckets` | `GetBucketCors`, `GetBucketVersioning`, `GetBucketLocation` |
| `writeBuckets` | `PutBucketCors`, `DeleteBucketCors` |

**Minimum set for Bucketer**: `listFiles` + `readFiles` + `writeFiles` + `deleteFiles` + `listBuckets` + `listAllBucketNames` + `readBuckets` + `writeBuckets`. The last two are only required for CORS setup (one-time operation); a day-to-day usage-only key can omit `readBuckets` and `writeBuckets`.

Source: [Cloud Storage Application Key Capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities) (fetched 2026-06-04)

---

### 15. Class C billing for `defaultMaxKeys=200` ⚠ — see [B2-01]

As noted under item 5 above: Class C operations (ListObjectsV2, ListBuckets, and all listing/admin operations) are **free** for standard pay-as-you-go B2 customers. The comment in `provider.js` that says "ListObjectsV2 is a Class C operation (billed per call)" is factually wrong. Class D operations (event notification outbound calls) are the only billed transaction type.

Source: [Backblaze B2 API Transaction Pricing](https://www.backblaze.com/cloud-storage/transaction-pricing) (fetched 2026-06-04)

---

## Drift findings (severity-ordered)

### [B2-01] `defaultMaxKeys` comment incorrectly states Class C operations are billed — Low

**Location**: `src/lib/provider.js:96–97`  
**Current comment**:
```js
// B2: 200 because ListObjectsV2 is a Class C operation (billed per call); smaller pages
// make the cost of browsing legible.
```
**Reality**: Class C operations are free for all pay-as-you-go accounts. The comment misleads maintainers and could confuse users who read it. The `defaultMaxKeys=200` default is still reasonable (faster page loads, natural "browse" feeling) but should be justified differently.  
**Recommended fix**:
```js
// B2: 200 rather than 1000. Class C operations (ListObjectsV2) are free, but smaller
// pages keep the UI feeling like paginated browsing rather than a bulk dump. Users can
// override in Settings.
```

---

### [B2-02] SetupGuide Step 2 omits `listAllBucketNames` capability guidance — Low

**Location**: `src/components/SetupGuide.jsx:108–115` (GuideB2, Step 2)  
**Issue**: The guide tells users to create an application key with "access to this bucket" but does not mention that the AWS SDK v3 calls `ListBuckets` during client initialisation and requires `listAllBucketNames` on bucket-restricted keys. Without it, users with bucket-restricted keys may see an opaque authentication error on first connection.  
**Recommended fix**: Add a parenthetical note in Step 2: "If you restrict this key to a single bucket, also enable **Allow List All Bucket Names** — the AWS SDK calls ListBuckets on startup and needs this flag to succeed."

---

### [B2-03] Path-style comment overstates the constraint — Informational

**Location**: `src/lib/provider.js:89–91`  
**Current comment**: "B2 and MinIO require path-style URLs"  
**Reality**: B2 supports both virtual-hosted and path-style. Path-style is a correct and safe choice for the SDK's `forcePathStyle: true`, but is not strictly required.  
**Recommended fix**: Update comment to: "B2: forcePathStyle keeps the SDK from rewriting the endpoint to a bucket-qualified hostname — safe for path-style-compatible providers. B2 supports both styles but path-style matches how users enter a plain regional endpoint."

---

### [B2-04] Presigned URL `response-content-type` override unconfirmed on B2 — Informational

**Location**: Bucketer preview logic (not B2-specific code; generic `GetObjectCommand` presign)  
**Issue**: B2 does not explicitly document support for `ResponseContentType` / `ResponseContentDisposition` query parameters on presigned `GetObject` requests. This feature works in practice but lacks official documentation confirmation.  
**Risk**: If a future B2 API change strips unrecognised query parameters from signed URLs, previews would serve files with their stored Content-Type rather than the requested override. Not currently a bug.  
**Recommended action**: Add a comment in the presign code noting this is unconfirmed on B2 and test explicitly if previews break on B2 in a future version.

---

## Getting-started links (canonical, fetched 2026-06-04)

| Step | Resource | URL | Notes |
|---|---|---|---|
| 1 | Create Backblaze account | https://www.backblaze.com/sign-up/cloud-storage | Personal and business accounts use the same B2 product. Business accounts get additional HIPAA/compliance options. |
| 2 | Create a B2 bucket | https://www.backblaze.com/docs/cloud-storage-buckets | Choose region at account creation time (cannot change later). Use lowercase-only names for S3-compat compatibility. Default lifecycle: "keep all versions". |
| 3 | Create an Application Key | https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys | Do NOT use the master key. Enable `listAllBucketNames` ("Allow List All Bucket Names") if restricting to a single bucket. |
| 4 | Apply CORS | https://www.backblaze.com/apidocs/s3-put-bucket-cors | Use `aws s3api put-bucket-cors` with `--endpoint-url`. Check/clear native rules first (`b2 bucket get <bucket>`). |
| 5 | S3-compat API reference | https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api | Full operation list and B2-specific behaviour notes. |
| 6 | App key capabilities | https://www.backblaze.com/docs/cloud-storage-application-key-capabilities | Maps B2 capabilities to S3-compat operations. |
| 7 | Regions and data centres | https://www.backblaze.com/docs/cloud-storage-data-regions | US West, US East, EU Central, CA East. Region is set per-account. |
| 8 | Transaction pricing | https://www.backblaze.com/cloud-storage/transaction-pricing | Classes A/B/C free; Class D (event notifications only) billed at $0.004/10k. |

---

## Cost / quota gotchas affecting Bucketer UX

**Free tier**:
- 10 GB storage always free
- Up to 3× average monthly stored data per month in egress free (e.g. 30 GB stored → 90 GB/month free egress)
- All Class A, B, C API calls free (unlimited)
- Class D (event notifications): 2,500 free/day, then $0.004 per 10,000

**Class operations relevant to Bucketer**:

| Bucketer action | S3 call | Class | Cost |
|---|---|---|---|
| List objects (browse folder) | `ListObjectsV2` | C | Free |
| List buckets | `ListBuckets` | C | Free |
| Download file / preview | `GetObject` | B | Free |
| Head object | `HeadObject` | B | Free |
| Upload file | `PutObject` / multipart | A | Free |
| Delete object | `DeleteObject` | A | Free |
| Delete objects (batch) | `DeleteObjects` | A | Free |
| CORS setup | `PutBucketCors` / `GetBucketCors` | C | Free |

**All Bucketer operations fall in free tiers** — the `defaultMaxKeys=200` comment's billing rationale is therefore a historical artifact. The only meaningful cost for a typical Bucketer user is:
- **Storage**: $6.95/TB/month beyond 10 GB free
- **Egress**: $0.01/GB beyond 3× monthly storage (or free via Cloudflare/Fastly/Bunny.net proxy)

**Egress and preview UX**: B2's egress-free allowance is generous (3× stored). For a 10 GB bucket the user gets 30 GB/month of free previews and downloads. Above that, at $0.01/GB, previewing many large files could add cost. Bucketer's `prefetchSizeLimit` setting (introduced in the performance work) is relevant here: it limits how much data is fetched during hover-to-prefetch, directly reducing accidental egress on B2.

**Cloudflare Bandwidth Alliance / B2 Overdrive**: B2 egress is free when traffic routes through Cloudflare, Fastly, bunny.net, CacheFly, CoreWeave, Equinix Metal, Vultr, or phoenixNAP. If Bucketer is deployed behind Cloudflare (e.g. as a Workers/Pages site), downloads from B2 buckets configured as Cloudflare R2 mirrors or accessed via a Cloudflare-proxied custom domain are egress-free. Direct browser-to-B2 traffic (the Bucketer default) does consume the 3× free allowance. If a user is concerned about egress cost, a Cloudflare proxy between the browser and B2 eliminates egress charges entirely.

**Minimum retention**: None. B2 has no minimum storage duration fee (unlike Wasabi's 90-day minimum or AWS Glacier's tiered minimums). Deleting a file immediately after upload incurs no penalty beyond the upload bandwidth used.

**Versioning cost note**: Since B2 buckets are always versioned, "deleted" files (hide-marked) still consume storage until their version history is explicitly purged. Users with aggressive lifecycle rules or frequent overwrites should be aware that hidden versions accumulate quietly. Bucketer's HiddenVersions panel makes this visible, which is the correct UX response.

---

## Recommendations for SetupGuide.jsx / provider.js

1. **Fix the `defaultMaxKeys` comment** (`provider.js:96–97`). Change from "billed per call" to a UX/pagination justification. One-line change, no code change. See [B2-01].

2. **Add `listAllBucketNames` guidance** in SetupGuide `GuideB2` Step 2. Add a sentence: "If restricting this key to a single bucket, also enable **Allow List All Bucket Names** so the AWS SDK can initialise correctly." See [B2-02].

3. **Update path-style comment** (`provider.js:89`). Soften from "require" to "conservative choice for SDK compatibility". See [B2-03].

4. **Consider adding a `ca-east-001` example** in the SetupGuide Step 2 region hint. Currently shows `us-west-004` as the example; CA East users may be confused. The region field's placeholder text could list all four patterns.

5. **Document the versioning-vs-permanent-delete distinction** somewhere in the UI or README. B2's always-on versioning means `DeleteObject` produces a hide marker, not immediate storage reclaim. The HiddenVersions panel addresses this for users who discover it, but a tooltip or note on the delete confirmation dialog ("On B2, files are hidden until version history is purged") would reduce support confusion.
