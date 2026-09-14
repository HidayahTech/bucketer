# Provider Verification — Bucketer v1.14.0

**Date:** 2026-06-04
**Scope:** Every S3 behaviour Bucketer relies on, verified against the official documentation of each supported provider (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, DigitalOcean Spaces, MinIO).
**Method:** Six provider lanes run in parallel (4 × Sonnet, 2 × Haiku), each fetching live vendor docs at 2026-06-04 and comparing them to the assumptions encoded in `src/lib/provider.js`, `src/lib/cors-config.js`, `src/lib/s3-client.js`, and `src/components/SetupGuide.jsx`. Raw per-provider outputs preserved at `docs/review-v1.14.0/06-providers/{aws,backblaze-b2,cloudflare-r2,wasabi,digitalocean-spaces,minio}.md`.

---

## Executive Summary

Bucketer's provider abstraction is mostly correct and ages well. The path-style flag, region-extraction regexes, CORS template (including the BUG-012 `amz-sdk-*` headers), default MaxKeys per provider, multipart limits, and `needsCorsConfig` flags all hold up against current docs. No provider rejects Bucketer's CORS JSON shape; BUG-012's defence against the `x-amz-*` wildcard gap is still required and still correct.

What did *not* hold up cleanly, in order of practical impact on users:

1. **Wasabi silently charges 90 days of storage on every delete** under Pay-as-You-Go pricing. Bucketer's unified delete UX, batch delete, and HiddenVersions purge all dispatch `DeleteObject(s)` with no provider-specific warning. A user uploading test data and deleting it five minutes later is still billed for 89 more days at full storage rates. This is a real financial surprise the app does nothing to surface.
2. **Cloudflare R2 doesn't implement versioning at all** — `PutBucketVersioning`, `GetBucketVersioning`, and `ListObjectVersions` are all on R2's unimplemented list. Bucketer's HiddenVersions panel issues these calls regardless of provider and shows the empty result with no explanation. Users will assume their versions disappeared.
3. **HTTPS Bucketer → HTTP MinIO is blocked by browser mixed-content policy.** The default local MinIO install is HTTP; the canonical production Bucketer deployment is HTTPS. Every request fails silently in DevTools. Bucketer's MinIO guide doesn't mention this.
4. **`extractRegion()` for AWS misses the user-friendly endpoint shape.** The console URL most AWS users will paste — `mybucket.s3.us-west-2.amazonaws.com` — does not match Bucketer's path-style regex. Region extraction falls back to `us-east-1` and SigV4 signs with the wrong region: `SignatureDoesNotMatch` for any bucket outside us-east-1. Same trap also affects dualstack endpoints.
5. **S3 Express One Zone is silently misdetected as standard AWS S3.** Its endpoints end in `.amazonaws.com` so the provider pattern matches; its auth model (session-based via `CreateSession`) and CORS flow don't apply. A user with an Express bucket would follow the wrong setup steps.

Documentation drift is mostly low-severity but adds up: the `defaultMaxKeys=200` comment for B2 references "Class C billed per call" which is *factually wrong* — B2 Class C is free for all PAYG accounts; the path-style comment in `provider.js` says B2 and MinIO "require" path-style when B2 in fact supports both styles; Wasabi's region list in code comments is missing four current regions and doesn't map legacy alias endpoints (`s3.nl-1.wasabisys.com` → `eu-central-1`); the SetupGuide R2 step omits where to find the Account ID, the billing-card-required signal, and the bucket-scoped-token-can't-list-buckets caveat; the SetupGuide B2 step omits the `listAllBucketNames` capability flag that the AWS SDK requires on startup against bucket-restricted keys.

Two genuinely *positive* discoveries: **DigitalOcean Spaces now supports object versioning** (recent change — see [Enable Spaces versioning](https://docs.digitalocean.com/products/spaces/how-to/enable-versioning/)) — Bucketer's HiddenVersions panel works on Spaces buckets that have versioning enabled, with no code change. And **Cloudflare R2's `PutBucketCors` via the S3 API is fully supported** ([R2 S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) lists it as a Class A operation; the [R2 buckets CORS doc](https://developers.cloudflare.com/r2/buckets/cors/) confirms the S3-API path) — the SetupGuide's `aws s3api put-bucket-cors` command for R2 is correct, contrary to early-R2 community memory that you had to use Wrangler.

For provider-choice guidance: see Section 6. The short version is — R2 is the best value if you don't need versioning; B2 is the best value if you do (and have a Cloudflare proxy in front of egress); DO Spaces is the easiest to set up and the most forgiving (no per-request fees, included CDN); Wasabi is the cheapest *per stored GB* but only if you can guarantee long retention; MinIO is the only self-hosted option; AWS S3 remains the safest "the docs are right and someone has hit this before you" choice.

---

## 1. Compatibility Matrix

Every cell is verified against the cited vendor doc fetched on 2026-06-04. Symbols: ✓ supported / matches Bucketer's assumption · ⚠ supported with a caveat worth surfacing · ✗ not supported · `?` not explicitly documented (works in practice). Footnotes are in section 2. Primary docs that establish multiple cells per provider are listed at the end of this section ("Primary sources"); per-finding URLs are in section 3.

| Behaviour | AWS S3 | Backblaze B2 | Cloudflare R2 | Wasabi | DO Spaces | MinIO |
|---|---|---|---|---|---|---|
| Endpoint pattern detection | ✓ ⚠[a] | ✓ | ✓ | ✓ | ✓ | n/a (manual) |
| Region extraction | ⚠[b] | ✓ | ✓ (`auto`) | ✓ ⚠[c] | ✓ | n/a |
| Path-style vs virtual-hosted | ✓ (virtual) | ⚠[d] (works either way; comment overstates) | ✓ (virtual) | ⚠[e] (Wasabi recommends path) | ✓ (virtual) | ✓ (path default) |
| SigV4 | ✓ | ✓ | ✓ (region `auto`) | ✓ | ✓ | ✓ |
| CORS via `s3api put-bucket-cors` | ✓ | ✓ | ✓ | ✗ (auto-permissive)[f] | ⚠[g] | ✓ |
| CORS `amz-sdk-*` headers needed | ✓ (BUG-012 fix valid) | ✓ (origin of BUG-012) | ✓ | n/a (wildcard `*`) | ✓ | ✓ |
| ListObjectsV2 (MaxKeys, Delimiter, Prefix, Token) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PutObject (single-shot, ≤ 5 GB) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Multipart (5 MB min, 10 000 max) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ListParts (resume support) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GetObject + presigned URLs | ✓ | ✓ | ✓ | ✓ | ✓ ⚠[h] | ✓ |
| `ResponseContentType` query override | ✓ | `?` | `?` | `?` | ✓ | ✓ |
| Presigned URL max expiry | 7 days | 7 days | 7 days | 7 days | `?` (probably 7) | 7 days |
| HeadObject | ✓ | ✓ | ✓ | ✓ | ✓ (inferred) | ✓ |
| CopyObject | ✓ ⚠[i] | ✓ ⚠[j] | ✓ | ✓ | ✓ ⚠[k] | ✓ |
| DeleteObject + DeleteObjects (1000 batch) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Versioning + ListObjectVersions | ✓ | ✓ (always-on)[l] | ✗[m] | ✓ | ⚠[n] (opt-in, recent) | ✓ |
| ListBuckets | ✓ ⚠[o] | ✓ ⚠[p] | ✓ ⚠[q] | ✓ | ✓ ⚠[r] | ✓ |
| 90-day minimum retention | ✗ | ✗ | ✗ (IA tier: 30 d) | ✓ ⚠[s] (HIGH) | ✗ (Cold tier: 30 d) | ✗ |
| Per-request API fees | ✓ ($/M) | ✗ (Class A/B/C free) | ✓ ($/M, generous free tier) | ✗ | ✗ | n/a |
| Egress fees | ✓ ($/GB) | ✓ (free up to 3× stored) | ✗ (free) | ✓ (free up to stored) | ✓ (1 TB free) | n/a |

### Primary source documents (per provider, fetched 2026-06-04)

These docs establish multiple rows of the matrix at once. Per-finding citations are in section 3.

**AWS S3**
- [Amazon S3 endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/s3.html) — endpoint patterns, regions, object/multipart limits
- [Virtual hosting of buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html) — virtual-hosted vs path-style; legacy global endpoint = us-east-1; dotted-name SSL caveat
- [Configuring CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html) — AllowedMethods set, AllowedHeaders wildcard semantics, ExposeHeaders
- [Multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — 5 MiB / 10 000 / 48.8 TiB
- [ListObjectVersions API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html) — versioning response shape and IAM action name
- [DeleteObjects API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html) — batch ≤ 1000; per-key error shape
- [Bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html) — 3–63 chars, reserved suffixes
- [Sharing objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) — 7-day max for SigV4

**Backblaze B2**
- [How to call the B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api) — endpoint formats, path-style support
- [B2 S3-compatible app keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys) — capability → S3 operation mapping; `listAllBucketNames` for SDK startup
- [B2 application key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities) — full capability reference
- [B2 transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing) — Class A/B/C free; Class D billed
- [B2 CORS rules](https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules) — wildcard prefix-matching behaviour
- [B2 file versions](https://www.backblaze.com/docs/cloud-storage-file-versions) — always-on versioning; hide markers
- [B2 data regions](https://www.backblaze.com/docs/cloud-storage-data-regions) — region list

**Cloudflare R2**
- [R2 S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) — ground truth for supported/unimplemented operations including versioning gap
- [R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/) — 5 TiB / 10 000 parts / 5 GiB single-PUT / 1200 req per 5 min
- [R2 buckets — CORS](https://developers.cloudflare.com/r2/buckets/cors/) — PutBucketCors via S3 API and dashboard
- [R2 multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/) — 5 MiB min, 7-day auto-abort
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) — 7-day max
- [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/) — bucket vs account scope, ListBuckets requirement
- [R2 data location / jurisdictional buckets](https://developers.cloudflare.com/r2/reference/data-location/) — EU / FedRAMP endpoint shapes
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) — free tier; Class A/B; egress-free
- [R2 AWS SDK v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/) — confirms `region: 'auto'`

**Wasabi**
- [Wasabi service URLs by region](https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions) — full endpoint and region list, incl. legacy aliases
- [Bucket CORS support in Wasabi S3 API](https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api) — auto-permissive defaults; PutBucketCors *not* supported
- [Wasabi minimum storage duration policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work) (last updated 2026-01-09) — 90-day Pay-Go / 30-day RCS
- [Wasabi multipart uploads](https://docs.wasabi.com/docs/how-does-wasabi-handle-multipart-uploads) — 5 MB min, S3-compatible limits
- [Wasabi presigned URLs](https://docs.wasabi.com/docs/how-do-i-generate-pre-signed-urls-for-temporary-access-with-wasabi) — 7-day max
- [Wasabi pricing FAQ](https://wasabi.com/pricing/faq) — egress acceptable-use; 1 TB monthly minimum

**DigitalOcean Spaces**
- [Using DO Spaces with AWS S3 SDKs](https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/) — endpoint shape, virtual-hosted recommendation, AWS CLI region quirk
- [Spaces S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/) — supported / unsupported operation list
- [Spaces availability](https://docs.digitalocean.com/products/spaces/details/availability/) — current region list
- [Spaces limits](https://docs.digitalocean.com/products/spaces/details/limits/) — multipart limits, rate limits, batch delete
- [Configuring CORS](https://docs.digitalocean.com/products/spaces/how-to/configure-cors/) — XML examples in docs (JSON inferred)
- [Enable Spaces versioning](https://docs.digitalocean.com/products/spaces/how-to/enable-versioning/) — recent addition; opt-in via CLI
- [Spaces presigned URLs and file permissions](https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/) — CDN-caching caveat
- [Managing access to Spaces](https://docs.digitalocean.com/products/spaces/how-to/manage-access/) — key scope model

**MinIO**
- [MinIO S3 API compatibility](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) — operation list
- [MinIO CORS configuration](https://docs.min.io/aistor/administration/cors-configuration/) — bucket-level and global methods
- [MinIO core settings](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/) — `MINIO_DOMAIN` required for virtual-hosted; default is path-style
- [Enable network encryption (TLS)](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/) — required for HTTPS Bucketer → MinIO
- [Identity and access management](https://docs.min.io/enterprise/aistor-object-store/administration/iam/) — service accounts, IAM policies
- [Thresholds and limits](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/thresholds/) — multipart 5 MB min
- [`mc share download`](https://docs.min.io/aistor/reference/cli/mc-share/mc-share-download/) — 168 h default presigned expiry
- [Objects and versioning](https://docs.min.io/enterprise/aistor-object-store/administration/objects-and-versioning/) — bucket versioning, ListObjectVersions

---

## 2. Matrix footnotes

- **[a] AWS endpoint coverage gap.** Bucketer's `*.amazonaws.com$` pattern correctly fires for all current AWS endpoint shapes, but treats *all* of them as standard S3. **S3 Express One Zone** (`<bucket>.s3express-<az-id>.<region>.amazonaws.com`) and **S3 on Outposts** (`*-*.<outpost>.s3-outposts.<region>.amazonaws.com`) both end in `.amazonaws.com` and get the standard AWS guide and behaviour, which is wrong for both. See drift finding **PV-04**.
- **[b] AWS region-extraction regex.** The current regex `^s3\.([^.]+)\.amazonaws\.com$` only matches the *service* endpoint form. A user who pastes the *virtual-hosted bucket* URL (`mybucket.s3.us-west-2.amazonaws.com`) gets `null`, falling back to `us-east-1`, producing `SignatureDoesNotMatch`. Same gap exists for dualstack (`s3.dualstack.<region>.amazonaws.com`). See **PV-03**.
- **[c] Wasabi region edge case.** The regex `^s3\.([^.]+)\.wasabisys\.com$` correctly captures region for the canonical `s3.<region>.wasabisys.com` form. Legacy aliases (`s3.nl-1.wasabisys.com`, `s3.de-1.wasabisys.com`, etc.) are detected as Wasabi but extract the alias slug (`nl-1`) instead of the SigV4 region (`eu-central-1`). Recommend mapping aliases or documenting them. See **PV-12**.
- **[d] B2 path-style.** Bucketer asserts `requiresPathStyle(B2)=true`. B2 docs now state both styles are supported; setting `forcePathStyle: true` is still a safe and correct choice, but the in-code comment "B2 and MinIO require path-style URLs" overstates the constraint. See **PV-09**.
- **[e] Wasabi path-style.** Wasabi explicitly *recommends* path-style ("greatest flexibility in bucket naming"). Bucketer uses virtual-hosted. Both work; users with dots in their bucket name will hit SSL wildcard mismatches with the current setting. See **PV-08**.
- **[f] Wasabi CORS.** Wasabi does not implement `PutBucketCors` / `GetBucketCors` over the S3 API. Instead it returns `Access-Control-Allow-Origin: *` *automatically* on any request that carries an `Origin` header. Bucketer's `needsCorsConfig(WASABI)=false` is correct: there is no CORS setup step for Wasabi users.
- **[g] DO Spaces CORS JSON.** DO Spaces' published docs show only XML CORS examples and the `s3cmd setcors` command. JSON via `aws s3api put-bucket-cors` is inferred from the "S3-compatible API" claim; it works in practice but the absence of an explicit doc confirmation is a soft risk. See **PV-13**.
- **[h] DO Spaces presigned URLs and CDN.** Presigned URLs cannot be cached by the Spaces CDN. Combined with the included CDN, a user issuing many presigned downloads will see effectively-double bandwidth charges. Bucketer doesn't warn users about this. See **PV-14**.
- **[i] AWS CopyObject.** Single-call CopyObject caps at 5 GB; objects above need `UploadPartCopy`. Bucketer's rename (copy-then-delete) doesn't gate on size. Source: [CopyObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html) and [UploadPartCopy API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPartCopy.html), both fetched 2026-06-04.
- **[j] B2 CopyObject.** Same 5 GB single-call cap. Cross-account copy not supported; tagging headers silently ignored. None of these affect Bucketer today. Source: [B2 s3-copy-object](https://www.backblaze.com/apidocs/s3-copy-object), fetched 2026-06-04.
- **[k] DO Spaces CopyObject.** Cross-region / cross-cluster copy not supported. Bucketer doesn't do cross-region copy, so no impact. Source: [Spaces S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/), fetched 2026-06-04.
- **[l] B2 versioning.** B2 buckets are *always versioned* — there is no API call to enable/disable. `DeleteObject` without a `VersionId` creates a *hide marker*, exposed to Bucketer's HiddenVersions panel as an S3 `<DeleteMarker>`. Permanent deletion requires explicit version-id delete. Source: [B2 file versions](https://www.backblaze.com/docs/cloud-storage-file-versions) and [B2 S3-compat bucket versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions), both fetched 2026-06-04.
- **[m] R2 versioning.** Not implemented at all. `ListObjectVersions`, `PutBucketVersioning`, `GetBucketVersioning` are on R2's unimplemented list. Bucketer's HiddenVersions panel will return empty / error against R2. Source: [R2 S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/), fetched 2026-06-04. See **PV-02**.
- **[n] DO Spaces versioning.** Recently added; **opt-in** via `aws s3api put-bucket-versioning`. Bucketer's panel will work transparently on buckets where versioning is enabled — no code change needed. Source: [Enable Spaces versioning](https://docs.digitalocean.com/products/spaces/how-to/enable-versioning/), fetched 2026-06-04.
- **[o] AWS `s3:ListAllMyBuckets`.** Required for Bucketer's planned v2.0 multi-bucket flow; must target `Resource: "*"` and is often denied by narrowly-scoped IAM policies. Source: [S3 IAM action reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) and [ListBuckets API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html), both fetched 2026-06-04. See **PV-17**.
- **[p] B2 `listAllBucketNames`.** AWS SDK v3 calls `ListBuckets` during client initialisation; bucket-restricted keys must also have the `listAllBucketNames` capability or initialisation fails. Source: [B2 application key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities), fetched 2026-06-04. See **PV-11**.
- **[q] R2 ListBuckets scope.** R2 API tokens are either bucket-scoped or account-scoped. Bucket-scoped tokens *cannot* call `ListBuckets`. Bucketer's bucket-picker will silently return nothing for users on bucket-scoped tokens. Source: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), fetched 2026-06-04. See **PV-06**.
- **[r] DO Spaces ListBuckets scope.** Requires "Full access" or "All (Buckets and Objects)" permission. Limited-bucket-scope keys can't list all buckets. Source: [Managing access to Spaces](https://docs.digitalocean.com/products/spaces/how-to/manage-access/), fetched 2026-06-04.
- **[s] Wasabi 90-day retention.** Pay-as-You-Go customers are billed for 90 days of storage on every object, even if deleted on day 1. Reserved Capacity Storage customers: 30 days. Bucketer's delete UX has no provider-specific warning. Source: [Wasabi minimum storage duration policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work) (updated 2026-01-09, fetched 2026-06-04). **Highest-impact finding in this review.** See **PV-01**.

---

## 3. Cross-provider findings (severity-ordered)

### PV-01 — Wasabi 90-day retention is silently billed; delete UX has no warning — HIGH

- **Provider:** Wasabi (Pay-as-You-Go)
- **Source:** [Wasabi minimum storage duration policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work) — updated 2026-01-09, fetched 2026-06-04
- **Mechanic:** Every object stored under Wasabi PAYG accrues a "Timed Deleted Storage" charge for the unused portion of 90 days when deleted before day 90. Rate: $6.99/TB/month (subject to change on or after 2026-07-01). At 1 TB × delete-on-day-1, the surprise charge is ≈ $20.97. RCS customers: 30-day minimum.
- **Bucketer impact:** Delete flow (single, batch, folder, HiddenVersions purge) dispatches `DeleteObject(s)` with no provider gate or warning text. A user trying the app with Wasabi and clearing out a test bucket of 500 × 1 MB files on day 5 is billed for 85 more days of storage — silent until the next invoice.
- **Recommendation:**
  1. In `App.jsx` delete confirmation dialog and `HiddenVersions.jsx` purge-all dialog, when `provider === PROVIDERS.WASABI`, show:
     > *Wasabi billing note:* Wasabi charges for a minimum of 90 days of storage per object (30 days for Reserved Capacity). Deleting today may still incur storage charges for up to 89 more days.
  2. Add the same callout to `SetupGuide.jsx`'s `GuideWasabi` as a "Cost considerations" step.

### PV-02 — Cloudflare R2 doesn't support versioning; HiddenVersions panel silently shows nothing — MEDIUM

- **Provider:** Cloudflare R2
- **Source:** [R2 S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) — fetched 2026-06-04. `ListObjectVersions`, `PutBucketVersioning`, `GetBucketVersioning` are on the "unimplemented" list.
- **Bucketer impact:** `HiddenVersions.jsx` calls `ListObjectVersionsCommand` regardless of provider. Against R2 the call errors or returns an empty `<Version>` array and the panel shows nothing. The user has no way to tell whether their bucket actually has no versions or whether R2 simply doesn't support the feature.
- **Recommendation:** Gate the HiddenVersions UI on provider capability. Either (a) hide the panel entirely when `provider === PROVIDERS.R2`, or (b) attempt `GetBucketVersioning` on first open and render a "Cloudflare R2 does not support S3 object versioning" empty state on `NotImplemented` / unsupported-operation errors. Option (b) is more future-proof in case R2 ever adds it.

### PV-03 — AWS `extractRegion()` misses virtual-hosted endpoint format — MEDIUM

- **Provider:** AWS S3
- **Location:** `src/lib/provider.js:72` — `^s3\.([^.]+)\.amazonaws\.com$`
- **Source:** [AWS S3 — Virtual hosting of buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html) — fetched 2026-06-04. The recommended endpoint form is virtual-hosted (`<bucket>.s3.<region>.amazonaws.com`); the AWS Console also displays this form.
- **Bucketer impact:** A user who pastes the virtual-hosted bucket URL falls through to the `us-east-1` fallback and gets `SignatureDoesNotMatch` for any non-`us-east-1` bucket. Also misses dualstack endpoints (`s3.dualstack.<region>.amazonaws.com`).
- **Recommendation:** Extend the regex to also match:
  - `^[^.]+\.s3\.([^.]+)\.amazonaws\.com$` (virtual-hosted bucket)
  - `^s3\.dualstack\.([^.]+)\.amazonaws\.com$` (dualstack)
  - `^s3-fips\.([^.]+)\.amazonaws\.com$` (FIPS)
  - `^s3-fips\.dualstack\.([^.]+)\.amazonaws\.com$` (FIPS dualstack)
  - `^s3-([^.]+)\.amazonaws\.com$` (legacy dash-style)

  Or: keep the regex narrow and have `SetupGuide`'s AWS step explicitly tell users to enter the *service* endpoint (`https://s3.<region>.amazonaws.com`), not the bucket URL.

### PV-04 — S3 Express One Zone and S3 on Outposts are silently misdetected as standard AWS — MEDIUM

- **Provider:** AWS S3 (variants)
- **Location:** `src/lib/provider.js:36` PATTERNS array
- **Sources:** [S3 Express One Zone high-performance directory buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html) and [CreateSession (Express auth)](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateSession.html) (session-based auth model); [S3 on Outposts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/S3onOutposts.html) and [S3 on Outposts hostname format](https://docs.aws.amazon.com/AmazonS3/latest/userguide/S3onOutpostsAPI.html) (access-point-only addressing). All fetched 2026-06-04.
- **Bucketer impact:** Endpoints for these services end in `.amazonaws.com` and match the AWS pattern, so the user gets the standard AWS setup guide. Express's auth model and Outposts' addressing model are different and the standard guide is wrong for both. Niche today, but a silent misclassification is worse than a friendly error.
- **Recommendation:** Add narrower patterns *before* the generic AWS pattern:
  ```js
  { re: /\.s3express-[^.]+\.[^.]+\.amazonaws\.com$/i, provider: PROVIDERS.GENERIC /* or new EXPRESS variant */ },
  { re: /\.s3-outposts\.[^.]+\.amazonaws\.com$/i,    provider: PROVIDERS.GENERIC },
  ```
  And surface a "This is an AWS S3 variant Bucketer hasn't been validated against — proceed at your own risk" banner when GENERIC fires off an `*.amazonaws.com` host.

### PV-05 — MinIO mixed-content: HTTPS Bucketer → HTTP MinIO is silently blocked — HIGH (in production deployments)

- **Provider:** MinIO
- **Source:** Browser mixed-content policy + [MinIO TLS docs](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/) — fetched 2026-06-04
- **Bucketer impact:** Default MinIO install is HTTP on localhost:9000. Default production Bucketer deployment is HTTPS. Every S3 request from a Bucketer page at `https://bucketer.example.com` to `http://localhost:9000` is blocked by the browser. The error appears only in DevTools; the app surface shows "request failed" with no helpful explanation. This is not Bucketer's bug, but the SetupGuide doesn't mention it.
- **Recommendation:** Add a warning to `GuideMinIO` in `SetupGuide.jsx`:
  > **HTTPS Bucketer + HTTP MinIO:** If you're using a hosted Bucketer (https://…), your MinIO server must also be HTTPS. Browsers block HTTPS pages from talking to HTTP servers (mixed-content policy). Either run Bucketer locally over `file://` / HTTP, or enable TLS on MinIO ([guide](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/)).

### PV-06 — R2 bucket-scoped API tokens can't call ListBuckets — MEDIUM (for v2.0)

- **Provider:** Cloudflare R2
- **Source:** [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/) — fetched 2026-06-04
- **Bucketer impact:** v1.x users typing in a single bucket are fine. For v2.0's multi-bucket flow, R2 users who follow the SetupGuide will create a bucket-scoped "Object Read & Write" token, which cannot list buckets. The bucket picker silently shows nothing.
- **Recommendation:** SetupGuide R2 step should explain the scope choice:
  > For bucket auto-discovery (Bucketer 2.0), create an **account-level** token with "Workers R2 Storage Read". For single-bucket access, a **bucket-scoped** "Object Read & Write" token is sufficient — but you'll need to type the bucket name manually.
  Also: when v2.0 ships, gracefully fall back to manual bucket entry when `ListBuckets` returns 403/Forbidden on any provider.

### PV-07 — Rename's copy-then-delete is not transactional; failures leave duplicates — MEDIUM (already a known v1.14.0 bug)

- **Providers:** All
- **Bucketer impact:** The v1.14.0 review (CRIT-1 in the consolidated v1.14.0 review) found that `Browser.jsx:564` calls `new DeleteObjectCommand(...)` without importing it, so every rename throws *after* copy succeeds. Fixing that one-line bug doesn't address the underlying design: copy → delete is not atomic on any S3 provider. Network failures, IAM denials on the delete half, or B2's hide-marker behaviour on delete-by-name can all leave the user with two files where they expected one.
- **Recommendation:** When the delete step of a rename fails, the error message must explicitly say "the copy succeeded; the original remains" and offer a one-click retry of the delete. Not provider-specific, but the matrix shows that every provider lets a partial state happen.

### PV-08 — Wasabi: virtual-hosted style causes SSL errors on dotted bucket names — LOW

- **Provider:** Wasabi
- **Location:** `src/lib/provider.js:93` — `requiresPathStyle(WASABI) → false`
- **Source:** [Wasabi — How do I use AWS-SDK with Wasabi?](https://docs.wasabi.com/docs/how-do-i-use-aws-sdk-with-wasabi) and [Bucket naming considerations](https://docs.wasabi.com/docs/wasabi-bucket-and-object-naming-conventions) — Wasabi docs recommend path-style URLs for "greatest flexibility in bucket naming." Both fetched 2026-06-04.
- **Recommendation:** Either change to `true`, or add an SSL caveat for dotted bucket names in the Wasabi SetupGuide. AWS has the same gotcha (drift PV-15).

### PV-09 — B2 path-style is recommended for SDK ergonomics, not required — LOW (comment fix)

- **Provider:** Backblaze B2
- **Location:** `src/lib/provider.js:89–91`
- **Source:** [B2 S3-compat API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api) — fetched 2026-06-04. Confirms both styles supported.
- **Recommendation:** Update comment to "B2 supports both styles; we force path-style because users supply a plain regional endpoint, not a bucket-qualified hostname." Behaviour unchanged.

### PV-10 — B2 `defaultMaxKeys=200` billing-rationale comment is factually wrong — LOW (comment fix)

- **Provider:** Backblaze B2
- **Location:** `src/lib/provider.js:96–97`
- **Source:** [B2 transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing) — fetched 2026-06-04. Class A, B, and C operations are *all free* for PAYG. Only Class D (event notifications, irrelevant to Bucketer) is billed.
- **Recommendation:** Change the comment to a UX justification: "Smaller page size keeps the UI feeling like paginated browsing rather than a 1000-row dump; users can override in Settings." Default value can stay at 200 if preferred for UX, or be raised to 1000 to match other providers — both are now defensible.

### PV-11 — B2 SetupGuide omits `listAllBucketNames` Application Key capability — LOW

- **Provider:** Backblaze B2
- **Location:** `src/components/SetupGuide.jsx` (B2 branch, Step 2)
- **Source:** [B2 Application Key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities) — fetched 2026-06-04
- **Mechanic:** AWS SDK v3 calls `ListBuckets` during client initialisation. A B2 Application Key scoped to a single bucket and missing `listAllBucketNames` ("Allow List All Bucket Names") makes the client throw on first use.
- **Recommendation:** Add to SetupGuide B2 Step 2:
  > If you restrict this key to a single bucket, also enable **Allow List All Bucket Names** so the AWS SDK can initialise.

### PV-12 — Wasabi legacy alias endpoints extract the wrong region — LOW

- **Provider:** Wasabi
- **Location:** `src/lib/provider.js:62–68`
- **Source:** [Wasabi service URLs](https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions) — fetched 2026-06-04
- **Mechanic:** Legacy alias hostnames like `s3.nl-1.wasabisys.com`, `s3.de-1.wasabisys.com`, `s3.uk-1.wasabisys.com`, `s3.fr-1.wasabisys.com`, `s3.uk-2.wasabisys.com`, `s3.it-1.wasabisys.com` get detected as Wasabi but the regex extracts the alias slug (`nl-1`) rather than the canonical SigV4 region (`eu-central-1`). Signing fails subtly.
- **Recommendation:** Build a small alias map and translate at extraction time:
  ```js
  const WASABI_ALIASES = { 'nl-1': 'eu-central-1', 'de-1': 'eu-central-2', 'uk-1': 'eu-west-1', 'fr-1': 'eu-west-2', 'uk-2': 'eu-west-3', 'it-1': 'eu-south-1' };
  ```
  Also update code comments to enumerate the current 16 Wasabi regions (the new ones are `us-west-2`, `ca-central-1`, `eu-west-3`, `eu-south-1`).

### PV-13 — DO Spaces JSON CORS not explicitly documented — LOW (mitigated, but verify)

- **Provider:** DigitalOcean Spaces
- **Source:** [Spaces CORS](https://docs.digitalocean.com/products/spaces/how-to/configure-cors/) — fetched 2026-06-04. Only XML examples published.
- **Mechanic:** DO claims full S3 compatibility and lists AWS SDK as supported; JSON-via-`PutBucketCors` works in practice. The risk is purely "no explicit confirmation."
- **Recommendation:** Add an integration smoke-test that POSTs the Bucketer CORS JSON to a real DO Space and reads it back. Low effort, eliminates the documentation soft spot.

### PV-14 — DO Spaces presigned URLs disable CDN caching; effectively double bandwidth — LOW

- **Provider:** DigitalOcean Spaces
- **Source:** [Spaces presigned URLs](https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/) — fetched 2026-06-04
- **Mechanic:** Spaces CDN does not cache responses to presigned URLs. The 1 TB monthly egress allowance can be eaten twice if you serve many presigned downloads of the same files. Affects users who use Bucketer's share-link feature against a CDN-enabled Space.
- **Recommendation:** When Bucketer issues a presigned URL from a Spaces endpoint, surface a one-line warning in the share-link UI: "DigitalOcean Spaces CDN cannot cache presigned URLs. For cacheable downloads, use public-read object ACLs."

### PV-15 — AWS dotted bucket names break SSL on virtual-hosted style — LOW

- **Provider:** AWS S3
- **Source:** [AWS Virtual Hosting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html) — fetched 2026-06-04
- **Mechanic:** AWS's wildcard SSL cert (`*.s3.<region>.amazonaws.com`) only matches single-label bucket names. `my.bucket.example` → `my.bucket.example.s3.us-east-1.amazonaws.com` fails SSL match.
- **Recommendation:** SetupGuide AWS step should note: "Avoid dots in S3 bucket names — they break HTTPS virtual-hosted addressing, which Bucketer uses for AWS."

### PV-16 — No lifecycle-rule guidance for abandoned multipart uploads — LOW

- **Provider:** AWS (recommended), B2 (free Class A), others variable
- **Source:** AWS S3 [multipart upload best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html); R2 auto-aborts after 7 days; B2 no documented automatic cleanup.
- **Mechanic:** Multipart uploads that error out leave their parts in place, billed at storage rates. AWS recommends a lifecycle rule (`AbortIncompleteMultipartUpload`) to clean them. R2 auto-aborts at 7 days (no user action needed). Bucketer's resume window already covers this for "normal" failures, but tab-close and total abandonment still leak parts.
- **Recommendation:** SetupGuide AWS step adds an optional CLI command to install a 7-day `AbortIncompleteMultipartUpload` lifecycle rule. For B2, document that abandoned parts must be manually pruned.

### PV-17 — AWS `s3:ListAllMyBuckets` required for v2.0 multi-bucket; often denied by narrow IAM — LOW (v2.0 only)

- **Provider:** AWS
- **Sources:** [ListBuckets API reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html) and [Actions, resources, and condition keys for Amazon S3 → s3:ListAllMyBuckets](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) (fetched 2026-06-04). The latter confirms `s3:ListAllMyBuckets` only accepts `Resource: "*"`.
- **Mechanic:** `ListBuckets` requires `s3:ListAllMyBuckets` (note the misleading IAM action name), and it can only target `Resource: "*"`. Narrowly scoped users in restricted accounts often don't have it.
- **Recommendation:** When v2.0 ships, fall back to manual bucket entry on `AccessDenied`. Same advice applies for R2 bucket-scoped tokens (PV-06) and DO Spaces limited keys (matrix footnote [r]).

### PV-18 — Stale "5 TB max object" in any user-facing docs — NIT

- **Provider:** AWS
- **Source:** [Amazon S3 endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/s3.html) lists "Object size per account: 48.828125 Terabytes" in the service quotas table (fetched 2026-06-04). [Multipart upload best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) confirms the figure.
- **Recommendation:** Search-and-replace any "5 TB" references that come from older S3 lore.

### PV-19 — CORS clipboard command interpolates raw bucket/endpoint (defense-in-depth) — NIT

- **Provider:** All
- **Cross-reference:** This is SEC-3 in the v1.14.0 consolidated review. Single fix benefits all providers.

---

## 4. Per-provider quick reference

Each provider's full verification doc lives at `docs/review-v1.14.0/06-providers/<provider>.md`. This section captures the headline status.

### AWS S3 — `06-providers/aws.md`

- **Overall:** Fundamentally correct for the standard regional bucket case. Watch for the virtual-hosted endpoint extraction (PV-03) and Express/Outposts misdetection (PV-04).
- **Setup gotcha:** Service endpoint vs bucket URL — see SetupGuide recommendation in section 5.
- **Minimum IAM policy:** See appendix A.1.

### Backblaze B2 — `06-providers/backblaze-b2.md`

- **Overall:** All major behaviours correct; BUG-012 CORS fix still required and still valid. Three low-severity comment / setup-guide fixes (PV-09, PV-10, PV-11).
- **Setup gotcha:** Application Key needs `listAllBucketNames` if bucket-restricted (PV-11).
- **Minimum App Key capabilities:** `listFiles` + `readFiles` + `writeFiles` + `deleteFiles` + `listBuckets` + `listAllBucketNames` + `readBuckets` + `writeBuckets` (last two only needed for one-time CORS setup).

### Cloudflare R2 — `06-providers/cloudflare-r2.md`

- **Overall:** Strong fit. `region='auto'`, virtual-hosted, no per-egress fee, free tier ample for personal use. Versioning is the headline gap (PV-02).
- **Setup gotcha:** Endpoint requires `<account-id>` in the hostname; SetupGuide doesn't tell users where to find it (PV-06 details).
- **CORS:** `aws s3api put-bucket-cors` is fully supported. The SetupGuide's R2 instructions are correct.

### Wasabi — `06-providers/wasabi.md`

- **Overall:** `needsCorsConfig(WASABI)=false` correct (Wasabi auto-permissive). 90-day retention is the dominant concern (PV-01). Path-style preference (PV-08) and region-list drift (PV-12) are minor.
- **Setup gotcha:** Wasabi's free trial is **30 days, no credit card**; PAYG kicks in after with **1 TB minimum monthly charge** even at near-zero usage. Document this.
- **Minimum IAM policy:** See appendix A.2 — note `s3:DeleteObject` covers both `DeleteObject` and `DeleteObjects`.

### DigitalOcean Spaces — `06-providers/digitalocean-spaces.md`

- **Overall:** Substantially correct. Versioning is now supported (recent addition); HiddenVersions panel works on Spaces with versioning enabled. Two soft documentation gaps (PV-13, PV-14).
- **Setup gotcha:** AWS CLI region quirk — always use `us-east-1` in the CLI config regardless of endpoint region; endpoint URL is what determines actual data location.
- **CDN caveat:** Presigned URLs are not CDN-cached. Use public ACLs for shareable cacheable downloads.

### MinIO — `06-providers/minio.md`

- **Overall:** All behaviours match. `aws s3api put-bucket-cors` does work against MinIO. Path-style default is correct.
- **Setup gotcha:** Mixed-content (PV-05) is the dominant issue. SetupGuide must mention this for production deployments.
- **Alternate setup paths:** Server-startup `MINIO_API_CORS_ALLOW_ORIGIN` env var bypasses per-bucket CORS entirely; `mc cors set` is the official CLI alternative to `aws s3api`.

---

## 5. Getting-started links — ready to drop into README or SetupGuide

All links fetched on 2026-06-04 and confirmed live unless otherwise noted.

### AWS S3

1. [Create AWS account](https://aws.amazon.com/premiumsupport/knowledge-center/create-and-activate-aws-account/)
2. [Create an S3 bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html) — avoid dots in name; Block Public Access can stay on (Bucketer uses signed requests).
3. [Create an IAM user with an access key](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html) — apply the policy in appendix A.1; do not use root credentials.
4. [Apply CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html) — Bucketer's SetupGuide already generates the correct `aws s3api put-bucket-cors` command.
5. Connect with endpoint `https://s3.<region>.amazonaws.com` — *not* the virtual-hosted bucket URL.

### Backblaze B2

1. [Sign up for Backblaze](https://www.backblaze.com/sign-up/cloud-storage) — personal and business plans are the same B2 product.
2. [Create a B2 bucket](https://www.backblaze.com/docs/cloud-storage-buckets) — region is set per-account at signup, cannot be changed later. Use lowercase-only names. Default lifecycle: keep all versions.
3. [Create an Application Key](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys) — **enable `listAllBucketNames` if scoping to a single bucket** or AWS SDK initialisation will fail.
4. [Apply CORS via S3 API](https://www.backblaze.com/apidocs/s3-put-bucket-cors) — Bucketer's SetupGuide generates this. The native B2 CORS rules (`b2 bucket update`) are separate; clear those first if previously set.
5. [Reference: S3-compat operation list](https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api).
6. [Reference: Region/endpoint table](https://www.backblaze.com/docs/cloud-storage-data-regions).
7. [Reference: Transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing) — Class A/B/C all free; only Class D (event notifications, not used by Bucketer) is billed.

### Cloudflare R2

1. [Sign up for Cloudflare](https://dash.cloudflare.com/sign-up).
2. [Enable R2 / overview](https://developers.cloudflare.com/r2/get-started/) — **requires a payment method on file** even at free-tier usage.
3. [Create a bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/) — naming: lowercase letters, numbers, hyphens, 3–63 chars; jurisdiction option (standard / EU / FedRAMP).
4. [Create an API token](https://developers.cloudflare.com/r2/api/tokens/) — "Object Read & Write" bucket-scope is sufficient for single-bucket use; account-scope "Storage Read" required for ListBuckets in v2.0.
5. [Configure CORS](https://developers.cloudflare.com/r2/buckets/cors/) — `aws s3api put-bucket-cors` works since Sept 2022; dashboard also works.
6. Find your Account ID in the Cloudflare dashboard sidebar.
7. Connect with endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`. For EU jurisdiction: `https://<account-id>.eu.r2.cloudflarestorage.com`.
8. [Reference: S3 API compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) — versioning, ACLs, and a handful of bucket lifecycle operations are unimplemented.

### Wasabi

1. [Sign up for Wasabi](https://docs.wasabi.com/docs/signing-up-for-wasabi) — 30-day trial, **no credit card required**. After trial: PAYG with 1 TB minimum monthly charge.
2. [Region and endpoint list](https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions). Use `s3.<region>.wasabisys.com`. Legacy bare `s3.wasabisys.com` is us-east-1.
3. Create a bucket via Wasabi Console. Names follow AWS conventions (3–63 chars, lowercase, hyphens). Avoid dots.
4. [Create a sub-user + access key](https://docs.wasabi.com/docs/creating-a-user-account-and-access-key) — do not use root credentials.
5. **No CORS step.** Wasabi returns `Access-Control-Allow-Origin: *` automatically.
6. **Read this before deleting anything:** [90-day minimum retention policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work).
7. Connect with endpoint `https://s3.<region>.wasabisys.com`.

### DigitalOcean Spaces

1. [Sign up for DigitalOcean](https://www.digitalocean.com/).
2. [Create a Space](https://docs.digitalocean.com/products/spaces/how-to/create/). Choose region from [Spaces availability](https://docs.digitalocean.com/products/spaces/details/availability/).
3. [Create a Spaces access key](https://docs.digitalocean.com/products/spaces/how-to/manage-access/) — scope to bucket with Read/Write/Delete is sufficient; full access required for ListBuckets.
4. [Configure CORS](https://docs.digitalocean.com/products/spaces/how-to/configure-cors/) — Bucketer's SetupGuide generates the JSON `aws s3api put-bucket-cors` command.
5. *Optional:* [Enable versioning](https://docs.digitalocean.com/products/spaces/how-to/enable-versioning/) — required to make Bucketer's HiddenVersions panel useful on Spaces. Recent addition.
6. Connect with endpoint `https://<region>.digitaloceanspaces.com` (e.g. `https://nyc3.digitaloceanspaces.com`). AWS CLI region in the credentials profile: always `us-east-1`.

### MinIO

1. [Deploy MinIO via Docker](https://docs.min.io/enterprise/aistor-object-store/installation/container/install/):
   ```bash
   docker run -dt -p 9000:9000 -p 9001:9001 \
     -e MINIO_ROOT_USER=minioadmin \
     -e MINIO_ROOT_PASSWORD=minioadmin \
     -v ~/minio/data:/minio/data \
     minio/minio:latest server /minio/data
   ```
2. Open MinIO Console at `http://localhost:9001` (`minioadmin` / `minioadmin`). Create a bucket.
3. Create a service account (recommended over root): Console → Administrator → Users → Service Account.
4. [Configure CORS](https://docs.min.io/aistor/administration/cors-configuration/) — `aws s3api put-bucket-cors` works fully. Alternative: `mc cors set` or `MINIO_API_CORS_ALLOW_ORIGIN` env var at server startup.
5. **For HTTPS-hosted Bucketer:** [Enable TLS on MinIO](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/) — mixed-content policy blocks HTTPS→HTTP otherwise.
6. Connect with endpoint `http://localhost:9000` (or your TLS host), region `us-east-1`, provider **MinIO** (manual selection — not auto-detected).

---

## 6. Provider-choice guidance

A condensed compatibility-and-fit table that can become the basis for a "Which provider should I use?" section in `README.md` or a first-run helper. Trade-offs from the lane outputs; price tags are 2026-06-04 indicative, citing the official pricing page per provider:

- AWS — [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/) and [Amazon S3 free tier](https://aws.amazon.com/free/?all-free-tier.q=S3)
- B2 — [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing) and [B2 transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing); Bandwidth Alliance partners listed at [B2 Cloud Replication / egress partners](https://www.backblaze.com/cloud-storage/integrations/cloudflare-r2)
- R2 — [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Wasabi — [Wasabi pricing](https://wasabi.com/pricing) and [pricing FAQ](https://wasabi.com/pricing/faq)
- DO Spaces — [DigitalOcean Spaces pricing](https://www.digitalocean.com/pricing/spaces-object-storage)
- MinIO — self-hosted; no vendor pricing (operational cost only)

| Provider | Best for | Strengths with Bucketer | Watch-outs |
|---|---|---|---|
| **Cloudflare R2** | Personal use, hobby projects, anyone serving downloads to the open internet | Zero egress fees; generous free tier (10 GB / 1 M Class A / 10 M Class B per month); `region='auto'` is one-shot config; CORS via S3 API works correctly | No versioning at all; requires payment method on file even on free tier; bucket-scoped tokens can't list buckets |
| **Backblaze B2** | Long-term archive at low cost; high egress through Cloudflare or other Bandwidth-Alliance partner | All API operations free (no per-call cost); 10 GB free storage; egress free up to 3× monthly storage; always-versioned (good for safety) | Always-versioned means deleted files take storage until version-purged; `listAllBucketNames` capability easy to forget; CORS preflight is the strictest of all providers — Bucketer's BUG-012 fix is mandatory |
| **DigitalOcean Spaces** | Small teams, predictable billing, included CDN | No per-request fees; included CDN; 1 TB egress free; reasonable rate limits; recently added versioning | $5/mo base even at near-zero usage; presigned URLs disable CDN caching; only two ACL options (private / public-read); some region-vs-CLI-region confusion |
| **Wasabi** | Long-retention storage where files stay > 90 days | Cheapest per stored GB ($6.99/TB/mo); 30-day no-CC trial; no per-request fees; egress free up to monthly storage volume | **90-day minimum retention** — deleting test data on day 1 still bills 89 more days; 1 TB minimum monthly charge after trial; recommend path-style which Bucketer currently doesn't use |
| **AWS S3** | Reference implementation; ecosystem maturity; existing AWS bills | Most documentation, most community knowledge, broadest IAM granularity, every feature is supported | Most expensive per-request and per-egress; complex IAM; SetupGuide URL gotcha (PV-03) catches many users on first connect |
| **MinIO** | Self-hosted, air-gapped, on-prem, NAS / homelab | No vendor account; no per-request or egress cost; full S3 API coverage; supports versioning | Mixed-content with HTTPS Bucketer (PV-05); you maintain the server; backup is your problem |

A rough decision flow chart for the README:

- *"I want to try Bucketer with no upfront cost or commitment"* → **Cloudflare R2** (10 GB free) or **Wasabi** (30-day no-CC trial).
- *"I want versioning / HiddenVersions to work"* → **AWS S3**, **B2** (always-on), **Wasabi**, **MinIO**, or **DO Spaces with versioning explicitly enabled**. Not R2.
- *"I plan to do a lot of egress (sharing public downloads)"* → **R2** (zero egress) > **B2 via Cloudflare proxy** (egress free through Bandwidth Alliance) > **DO Spaces** (1 TB free) > others.
- *"I want predictable monthly billing"* → **DO Spaces** ($5 base, simple) or **Wasabi** (1 TB min flat).
- *"I need on-prem / air-gapped"* → **MinIO**, no other choice.
- *"I have an existing AWS account / I'm in a corporate environment"* → **AWS S3**.

---

## 7. Recommended changes to Bucketer

In rough priority order. Cross-references PV-NN findings above and the consolidated v1.14.0 review.

### Block any release until fixed (in addition to the v1.14.0 CRIT-1 rename bug)

- **R1. Add 90-day-retention warning to Wasabi delete flows (PV-01).** App.jsx delete confirm + HiddenVersions purge. Provider-gated. ~10 lines.

### High — schedule for the next minor release

- **R2. Gate HiddenVersions on provider capability (PV-02).** Hide or empty-state on R2; works as-is on others.
- **R3. Extend AWS region-extraction regex or rewrite SetupGuide AWS step (PV-03).** Either fix the regex or tell users to enter the service endpoint.
- **R4. Add mixed-content warning to MinIO setup guide (PV-05).**
- **R5. Detect S3 Express / S3 Outposts as variant / generic and show advisory banner (PV-04).**
- **R6. SetupGuide B2 — add `listAllBucketNames` instruction (PV-11).**
- **R7. SetupGuide R2 — add Account ID location, billing-card prerequisite, bucket-vs-account token scope (PV-06 + R2-02/03/04 in lane file).**

### Medium — bundle with v2.0 enabling work

- **R8. Wasabi alias→canonical region map; update region comment list (PV-12).**
- **R9. Wasabi path-style switch or dotted-bucket SSL warning (PV-08).**
- **R10. AWS dotted-bucket SSL warning (PV-15).**
- **R11. Lifecycle-rule guidance for abandoned multipart uploads (PV-16).**
- **R12. Update B2 comments — path-style not "required" (PV-09); MaxKeys=200 rationale (PV-10).**
- **R13. Refactor rename to surface "copy succeeded, delete failed" explicitly with retry (PV-07).** Cross-references CRIT-1 from v1.14.0 review — fixing the import is mandatory; making the error path informative is what makes rename safe long-term.
- **R14. v2.0 graceful fallback when `ListBuckets` is denied — affects AWS, R2, DO Spaces (PV-17, matrix [o][q][r]).**

### Low — defense-in-depth, polish, future-proofing

- **R15. Smoke-test DO Spaces JSON CORS once to remove the soft spot (PV-13).**
- **R16. Spaces presigned-URL CDN-caching warning in share UI (PV-14).**
- **R17. Update any "5 TB" references to "48.8 TiB" (PV-18).**
- **R18. Shell-quote bucket/endpoint in clipboard commands (PV-19 / v1.14.0 SEC-3).**
- **R19. Add a "Which provider should I choose?" doc in `docs/` based on section 6.**
- **R20. Add a "MinIO admin can preset CORS via `MINIO_API_CORS_ALLOW_ORIGIN`" note to the MinIO guide.**
- **R21. Add region examples to the DO Spaces setup hint (currently just `<region e.g. nyc3>`).**

---

## 8. Other S3-compatible providers worth knowing about (not yet verified)

This section catalogues providers Bucketer does not currently claim support for. Each entry is a **starting URL for future verification work**, not a confirmation that the provider works with Bucketer's current provider detection, CORS template, or `forcePathStyle` decisions. Adding any of these to `provider.js` + `SetupGuide.jsx` would require running the full Section 1–7 verification against the provider — that work is deferred.

URLs in this section were captured 2026-06-04 and link to each provider's public S3-API / Object-Storage doc landing page. Four of them (Akamai/Linode, Hetzner, OCI, iDrive e2) were verified live during this pass via web search; the remaining URLs are well-known canonical doc paths that should be re-confirmed before they are used in user-facing Bucketer docs or code.

### 8.1 Hosted commercial providers worth evaluating

Highest-relevance tier — these address segments Bucketer's current six providers don't cover well (cheaper-than-Wasabi storage, EU residency outside Hetzner, decentralised storage, etc.):

- **Scaleway Object Storage** — French/EU; popular for EU data residency. Docs: [https://www.scaleway.com/en/docs/object-storage/](https://www.scaleway.com/en/docs/object-storage/)
- **Hetzner Object Storage** — German; recent product (verified live: regions FSN1 / HEL1 / NBG1; S3-compatible with versioning, object lock, CORS, lifecycle policies). Docs: [https://docs.hetzner.com/storage/object-storage/](https://docs.hetzner.com/storage/object-storage/)
- **iDrive e2** — Aggressively-priced; 14 regions across US/CA/EU/Asia; SigV4 (with SigV2 still available). Docs: [https://www.idrive.com/s3-storage-e2/developer-guide](https://www.idrive.com/s3-storage-e2/developer-guide); endpoints: [https://www.idrive.com/s3-storage-e2/e2-endpoint-urls](https://www.idrive.com/s3-storage-e2/e2-endpoint-urls)
- **Storj** — Decentralised storage with an S3-compatible gateway. Notable differentiator: client-side encryption by default; no per-region cost; redundancy via erasure-coding across independent nodes. Docs: [https://docs.storj.io/](https://docs.storj.io/) and [S3-compat gateway docs](https://docs.storj.io/dcs/api/s3/s3-compatibility)
- **Linode Object Storage (now Akamai Connected Cloud)** — Rebranded; 20+ regions globally. Docs: [https://techdocs.akamai.com/cloud-computing/docs/object-storage](https://techdocs.akamai.com/cloud-computing/docs/object-storage)
- **Vultr Object Storage** — Ceph-RGW-backed S3-compatible; popular with the developer / homelab audience. Docs: [https://www.vultr.com/docs/vultr-object-storage/](https://www.vultr.com/docs/vultr-object-storage/)
- **Contabo Object Storage** — Low-cost European; S3-compatible. Docs: [https://contabo.com/en/object-storage/](https://contabo.com/en/object-storage/)

Hyperscaler / enterprise S3-compatibility layers:

- **Oracle Cloud Infrastructure (OCI) Object Storage** — S3-compatibility API with SigV4-only (SigV2 not supported); supports both path-style and virtual-hosted (recently added). Docs: [https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm); operation-by-operation support matrix: [https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi_topic-Amazon_S3_Compatibility_API_Support.htm](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi_topic-Amazon_S3_Compatibility_API_Support.htm)
- **IBM Cloud Object Storage** — Enterprise; S3 API. Docs: [https://cloud.ibm.com/docs/cloud-object-storage](https://cloud.ibm.com/docs/cloud-object-storage)
- **Alibaba Cloud Object Storage Service (OSS)** — S3-compatible interface. Docs: [https://www.alibabacloud.com/help/en/oss](https://www.alibabacloud.com/help/en/oss)
- **Tencent Cloud Object Storage (COS)** — S3-compatible interface. Docs: [https://www.tencentcloud.com/document/product/436](https://www.tencentcloud.com/document/product/436)
- **Yandex Object Storage** — Russian; S3-compatible. Docs: [https://yandex.cloud/en/docs/storage/](https://yandex.cloud/en/docs/storage/)

Specialty / regional:

- **OVHcloud Object Storage** — French; Swift-native with S3-compatible endpoint. Docs: [https://help.ovhcloud.com/csm/en-public-cloud-storage-s3](https://help.ovhcloud.com/csm/en-public-cloud-storage-s3)
- **Exoscale Simple Object Storage (SOS)** — Swiss; S3-compatible. Docs: [https://community.exoscale.com/documentation/storage/](https://community.exoscale.com/documentation/storage/)
- **UpCloud Object Storage** — Finnish; S3-compatible. Docs: [https://upcloud.com/docs/products/storage/object-storage/](https://upcloud.com/docs/products/storage/object-storage/)
- **Leaseweb Object Storage** — Dutch. Docs: [https://www.leaseweb.com/en/products-services/cloud/object-storage](https://www.leaseweb.com/en/products-services/cloud/object-storage)
- **Synology C2 Object Storage** — Synology's hosted offering. Docs: [https://c2.synology.com/en-global/object-storage](https://c2.synology.com/en-global/object-storage)
- **Filebase** — IPFS / Arweave / Sia / Skynet backends behind a single S3-compatible API. Docs: [https://docs.filebase.com/](https://docs.filebase.com/)

### 8.2 Self-hostable S3-compatible servers (other than MinIO)

These are the bigger gap in Bucketer's coverage — each represents a distinct user community that MinIO does not fully address:

- **Ceph RGW (RADOS Gateway)** — The canonical open-source distributed object store with an S3-compatible gateway. Many commercial "S3" services (Vultr, OVH, others) are Ceph RGW under the hood. The natural fit for anyone already running Proxmox + Ceph in a homelab. Docs: [https://docs.ceph.com/en/latest/radosgw/](https://docs.ceph.com/en/latest/radosgw/); S3 API support: [https://docs.ceph.com/en/latest/radosgw/s3/](https://docs.ceph.com/en/latest/radosgw/s3/)
- **Garage** — Designed specifically for self-hosters and small federations (built by the Deuxfleurs collective). Lightweight, Rust, S3-compatible, low memory footprint. Growing fast in the self-hosted-services community. Docs: [https://garagehq.deuxfleurs.fr/documentation/](https://garagehq.deuxfleurs.fr/documentation/); S3 compatibility: [https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
- **SeaweedFS** — Distributed, S3-compatible, simpler operationally than Ceph. Popular in homelabs and small clusters. Docs: [https://github.com/seaweedfs/seaweedfs/wiki](https://github.com/seaweedfs/seaweedfs/wiki); S3 API: [https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)
- **Zenko CloudServer** (formerly Scality S3 Server) — Open-source S3 implementation from Scality. Repo + docs: [https://github.com/scality/cloudserver](https://github.com/scality/cloudserver)
- **OpenStack Swift via `s3api` middleware** — The enterprise / private-cloud path. Docs: [https://docs.openstack.org/swift/latest/s3_compat.html](https://docs.openstack.org/swift/latest/s3_compat.html)
- **`rclone serve s3`** — Rclone can expose almost any backend (local disk, Dropbox, OneDrive, SFTP, Google Drive, etc.) as an S3-compatible API. Niche but a real escape hatch for legacy / unusual backends. Docs: [https://rclone.org/commands/rclone_serve_s3/](https://rclone.org/commands/rclone_serve_s3/)

### 8.3 Test / development S3 emulators (out of scope for user-facing support)

Included for completeness; these are not targets a user would deploy production data to, but they may be useful for Bucketer's own integration testing in CI:

- **LocalStack** — Multi-AWS-service emulator (S3 is one of many). Docs: [https://docs.localstack.cloud/](https://docs.localstack.cloud/)
- **Adobe S3Mock** — In-memory S3 emulator. Repo: [https://github.com/adobe/S3Mock](https://github.com/adobe/S3Mock)
- **moto** (`moto_server`) — Mock AWS services for testing; S3 included. Docs: [https://docs.getmoto.org/](https://docs.getmoto.org/)
- **s3rver** — Lightweight S3 mock for Node-based test setups. Repo: [https://github.com/jamhall/s3rver](https://github.com/jamhall/s3rver)

### What "verification" would look like for any of these

Adding a new provider to Bucketer's first-class support is the same workload as one provider lane in this review. Concretely:

1. Verify endpoint hostname pattern(s) for `provider.js` PATTERNS array.
2. Verify region-extraction strategy (embedded in hostname? fixed string? `auto`?).
3. Verify `forcePathStyle` requirement.
4. Confirm SigV4 is the auth model (SigV2 is now rare but some providers still accept it — Bucketer's SDK posture is SigV4 only).
5. Verify CORS configuration mechanism (S3-API `PutBucketCors` vs dashboard vs server-config; whether the BUG-012 `amz-sdk-*` headers need explicit allowlisting).
6. Confirm support for the 13 behaviours in Section 1's matrix.
7. Identify cost / quota / retention quirks that affect Bucketer's UX (the way Wasabi's 90-day minimum and R2's missing versioning did in this pass).
8. Capture a canonical getting-started flow (account → bucket → access key → CORS → connect).

The per-provider lane files at `docs/review-v1.14.0/06-providers/*.md` are the closest reference shape for what such a verification document should look like.

---

## Appendix A — Minimum identity/policy snippets per provider

### A.1 AWS S3 — IAM policy

Replaces any older minimum-policy snippets in README. Use `s3:ListBucketVersions` (not `s3:ListObjectVersions` — common gotcha) and include `s3:ListMultipartUploadParts` for resume.

**Reference:** [Actions, resources, and condition keys for Amazon S3](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) is the authoritative mapping from S3 API operations to IAM action names. Notable subtleties confirmed there: `s3:ListBucketVersions` maps to `ListObjectVersions` (the IAM name and the API name differ); `s3:ListMultipartUploadParts` maps to `ListParts` and is required for Bucketer's resume path; `s3:ListAllMyBuckets` accepts only `Resource: "*"`. All fetched 2026-06-04.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BucketLevelOps",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketVersioning",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME"
    },
    {
      "Sid": "ObjectLevelOps",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:CopyObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    },
    {
      "Sid": "ListAllBucketsForV2",
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    }
  ]
}
```

`s3:PutBucketCORS` / `s3:GetBucketCORS` only needed if applying CORS from within Bucketer; can be removed once CORS is set. `s3:ListAllMyBuckets` is v2.0-only; v1.x users can omit.

### A.2 Wasabi — IAM policy

Wasabi uses AWS-compatible IAM. Same shape as AWS minus `s3:GetBucketCORS` / `s3:PutBucketCORS` (Wasabi auto-permits CORS; PutBucketCors is not supported anyway).

**Reference:** [Wasabi IAM Policies](https://docs.wasabi.com/docs/iam-policies) and [Creating a user account and access key](https://docs.wasabi.com/docs/creating-a-user-account-and-access-key) (both fetched 2026-06-04) confirm Wasabi accepts standard AWS IAM JSON. The pre-built `WasabiFullAccess` policy is documented in the same set.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketVersioning"], "Resource": "arn:aws:s3:::YOUR-BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:HeadObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:CopyObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" }
  ]
}
```

### A.3 Backblaze B2 — Application Key capabilities

**Reference:** [B2 application key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities) lists every capability and the operations it gates. [B2 S3-compatible app keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys) maps capabilities to S3 operations and specifically calls out `listAllBucketNames` as the requirement for AWS SDK v3 client initialisation against bucket-restricted keys. Both fetched 2026-06-04.

Minimal set for everyday Bucketer use:

- `listFiles` (browse)
- `readFiles` (download, head, copy source)
- `writeFiles` (upload, multipart, soft-delete current version)
- `deleteFiles` (permanent delete by version-id, abort multipart)
- `listBuckets` (Bucketer's connect probe)
- `listAllBucketNames` (**required for AWS SDK v3 startup with bucket-restricted keys**)

For one-time CORS configuration via Bucketer's SetupGuide command, add:

- `readBuckets` (GetBucketCors)
- `writeBuckets` (PutBucketCors, DeleteBucketCors)

These last two can be removed after initial setup if you regenerate the key.

### A.4 Cloudflare R2 — API token scopes

**Reference:** [R2 authentication / API tokens](https://developers.cloudflare.com/r2/api/tokens/) documents the four permission tiers (Admin Read & Write, Admin Read only, Object Read & Write, Object Read only) and the bucket-vs-account scope distinction. Fetched 2026-06-04.

- **Bucket-scoped, single-bucket use:** "Workers R2 Storage Bucket Item Write" on the target bucket.
- **Account-scoped, multi-bucket (v2.0):** "Workers R2 Storage Read" account-level *plus* the bucket-scoped write token, or a single token with "Admin Read & Write" if you accept the broader blast radius.

### A.5 DigitalOcean Spaces — Access key scope

**Reference:** [Managing access to Spaces](https://docs.digitalocean.com/products/spaces/how-to/manage-access/) (fetched 2026-06-04) documents the two scope tiers and the per-bucket Read / Read+Write / Read+Write+Delete sub-options for the limited tier.

- **Per-bucket limited:** Read or Read/Write/Delete on the target Space — sufficient for v1.x.
- **Account-wide:** "All (Buckets and Objects)" — required for ListBuckets / v2.0 multi-bucket.

DO does not currently expose finer-grained operation-level scoping than this.

### A.6 MinIO — Service account policy

**Reference:** [MinIO IAM — Built-in policies](https://min.io/docs/minio/linux/administration/identity-access-management/policy-based-access-control.html) and [`mc admin policy create`](https://min.io/docs/minio/linux/reference/minio-mc-admin/mc-admin-policy.html) (fetched 2026-06-04) confirm MinIO accepts AWS-compatible IAM JSON. The MinIO action namespace mirrors AWS S3 (e.g. `s3:GetObject`, `s3:PutObject`) with a small set of additional admin actions outside Bucketer's scope.

Service-account-scoped minimum policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketCors",
        "s3:PutBucketCors"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject", "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    }
  ]
}
```

Attach via `mc admin policy create` and `mc admin policy attach`. Root credentials work but are over-scoped; prefer a service account.

---

## Appendix B — Methodology notes

- Six parallel agents (4 × Sonnet 4.6, 2 × Haiku 4.5), each given an identical shared 15-behaviour checklist plus the Bucketer-side assumptions for their assigned provider. WebFetch + WebSearch tools enabled; Bash and Read for local source inspection.
- Each agent was required to cite every claim with the source URL and the date fetched (2026-06-04).
- Where vendor docs did not explicitly confirm a behaviour, the agent marked it `?` rather than `✓`. Two specific behaviours are widely-used-in-practice but undocumented: B2's `ResponseContentType` query parameter on presigned URLs and R2's same; both are noted in their respective lane files.
- No code was modified during the review. No requests were sent to any provider's API.
- All assertions are subject to vendor doc drift. Re-running this review periodically (or pinning the doc URLs into a CI check) is the standard mitigation; the staged-fetch-with-date format above is designed to make a future re-verification mechanical.
- The full per-provider files in `06-providers/` contain additional drift findings that were de-duplicated when not cross-cutting (e.g., specific code-comment edits) — consult those files when implementing the recommendations.
