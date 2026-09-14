# Wasabi — Provider Verification (Bucketer v1.14.0)

**Review date:** 2026-06-04
**Bucketer version:** v1.14.0
**Sources fetched live during review** (URLs and key facts cited per section)

---

## Summary

Two findings dominate this review.

**CORS default (WAS-01, severity: LOW — assumption confirmed correct).** Bucketer's claim that `needsCorsConfig(WASABI) = false` is accurate. Wasabi returns permissive CORS headers automatically for every request that includes an `Origin` header, without requiring any bucket-level CORS configuration. The default response includes `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, DELETE, MOVE, OPTIONS`, `Access-Control-Allow-Headers: *`, and `Access-Control-Expose-Headers: *`. All Bucketer operations — including multipart upload (POST, PUT), delete (DELETE), and list (GET) — are covered. No action required in SetupGuide.jsx.

**90-day minimum retention (WAS-02, severity: HIGH — UX gap confirmed).** Wasabi's Pay-as-You-Go pricing model enforces a 90-day minimum storage duration on every object. Objects deleted before 90 days incur a "Timed Deleted Storage" charge for the remaining days, billed at the same rate as active storage ($6.99/TB/mo as of this review, with rates changing on or after 2026-07-01). This is silent and automatic — users get no notification at delete time. Bucketer's delete UX (unified batch delete in v1.14.0) has no Wasabi-specific warning. For a developer uploading test data and immediately deleting it, the financial impact is real and non-obvious. SetupGuide should warn Wasabi users. See WAS-02.

**Region list drift (WAS-03, severity: LOW).** The Wasabi region list has grown since Bucketer's assumed set. Two new regions exist — `us-west-2` and `ca-central-1` in the Americas, and `eu-west-3` and `eu-south-1` in EMEA — plus legacy alias hostnames. `extractRegion` correctly handles all of these via regex since it captures any `[^.]+` segment, but Bucketer's UI may not enumerate them in any region dropdown or documentation.

**Path-style recommendation (WAS-04, severity: LOW — minor mismatch).** Wasabi docs recommend path-style requests for "greatest flexibility in bucket naming." Bucketer sets `requiresPathStyle(WASABI) = false` (virtual-hosted style). Wasabi explicitly supports both styles, and virtual-hosted style works in practice, but Wasabi's own preference is the opposite of Bucketer's choice.

**Presigned URL 7-day ceiling (WAS-05, severity: LOW).** Wasabi presigned URLs authenticated with IAM user credentials are valid for a maximum of 7 days. This matches AWS SigV4 behaviour and is not currently a problem for Bucketer, but worth noting if a "share link expiry" feature is added.

---

## Bucketer's Assumptions vs Wasabi Docs (per-behaviour)

### 1. Endpoint hostnames

**Bucketer assumption:** Pattern `/\.wasabisys\.com$/i`; `s3.wasabisys.com` → legacy us-east-1; `s3.<region>.wasabisys.com` → regional.

**Wasabi docs:** Confirmed, with the current full region list being larger than Bucketer's internal documentation assumed.

**Current full region list** (source: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions, fetched 2026-06-04):

| Region | Primary hostname | Legacy alias |
|---|---|---|
| US East 1 | `s3.us-east-1.wasabisys.com` | `s3.wasabisys.com` |
| US East 2 | `s3.us-east-2.wasabisys.com` | — |
| US Central 1 | `s3.us-central-1.wasabisys.com` | — |
| US West 1 | `s3.us-west-1.wasabisys.com` | — |
| US West 2 | `s3.us-west-2.wasabisys.com` | — |
| Canada Central 1 | `s3.ca-central-1.wasabisys.com` | — |
| EU Central 1 | `s3.eu-central-1.wasabisys.com` | `s3.nl-1.wasabisys.com` |
| EU Central 2 | `s3.eu-central-2.wasabisys.com` | `s3.de-1.wasabisys.com` |
| EU West 1 | `s3.eu-west-1.wasabisys.com` | `s3.uk-1.wasabisys.com` |
| EU West 2 | `s3.eu-west-2.wasabisys.com` | `s3.fr-1.wasabisys.com` |
| EU West 3 | `s3.eu-west-3.wasabisys.com` | `s3.uk-2.wasabisys.com` |
| EU South 1 | `s3.eu-south-1.wasabisys.com` | `s3.it-1.wasabisys.com` |
| AP Northeast 1 | `s3.ap-northeast-1.wasabisys.com` | — |
| AP Northeast 2 | `s3.ap-northeast-2.wasabisys.com` | — |
| AP Southeast 1 | `s3.ap-southeast-1.wasabisys.com` | — |
| AP Southeast 2 | `s3.ap-southeast-2.wasabisys.com` | — |

Bucketer's regex `^s3\.([^.]+)\.wasabisys\.com$` correctly captures the region slug for all 15 non-legacy endpoints. The bare `s3.wasabisys.com` fix (BUG-019) correctly returns `'us-east-1'`. Legacy aliases like `s3.nl-1.wasabisys.com` are detected as Wasabi by the pattern but `extractRegion` returns `nl-1` as the region slug — which is not a SigV4 region name. This is an edge case; users should use primary hostnames.

**Verdict: ✓** (with minor WAS-03 note on legacy aliases and new regions `us-west-2`, `ca-central-1`, `eu-west-3`, `eu-south-1`)

### 2. Region resolution / SigV4 signing

**Bucketer assumption:** `extractRegion` returns the embedded region slug; fallback is `'us-east-1'`.

**Wasabi docs:** Wasabi supports SigV4 signing with the region embedded in the endpoint. `s3.wasabisys.com` is documented as the US East 1 (Virginia) endpoint. Wasabi's consistency model is synchronous ("always consistent"), so there is no cross-region replication complexity. Users must sign requests with the correct region for the endpoint they are using.

**Verdict: ✓** The BUG-019 fix correctly handles the bare legacy endpoint.

### 3. Virtual-hosted style vs path-style

**Bucketer assumption:** `requiresPathStyle(WASABI) = false` — virtual-hosted style.

**Wasabi docs:** Both path-style and virtual-hosted style are supported. Wasabi's own documentation recommends path-style for "greatest flexibility in bucket names" (avoids DNS limitations on bucket names containing dots or uppercase letters).

**Verdict: ⚠ (WAS-04)** Virtual-hosted style works, but Wasabi itself recommends path-style. Bucketer users with non-DNS-compliant bucket names (dots, capital letters) may encounter SSL certificate mismatches with virtual-hosted style. Setting `requiresPathStyle(WASABI) = true` would match Wasabi's own guidance and prevent a class of hard-to-diagnose SSL errors. Low urgency but worth fixing.

### 4. CORS — `needsCorsConfig(WASABI) = false`

**Bucketer assumption:** Wasabi works without any manual CORS configuration.

**Wasabi docs** (source: https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api, fetched 2026-06-04):

Wasabi "will return the cross-origin resource sharing (CORS) headers when the header 'Origin' is given in an HTTP request" automatically. Default response headers:

```
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, HEAD, POST, PUT, DELETE, MOVE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: *
Access-Control-Max-Age: 86400
```

Wasabi also notes it "does not support the AWS functions that allow a PUT and GET on a bucket with the 'cors' parameter in the URL" — i.e., `PutBucketCors` and `GetBucketCors` are not available. Users cannot configure bucket-level CORS, so the permissive defaults are always in effect.

All Bucketer operations are covered:
- `ListObjectsV2`, `GetObject`, `HeadObject` — GET/HEAD
- `PutObject`, `UploadPart`, `CreateMultipartUpload`, `CompleteMultipartUpload` — PUT/POST
- `DeleteObject`, `DeleteObjects` — DELETE
- Presigned URL requests — same origin rules apply

**Verdict: ✓** The `needsCorsConfig(WASABI) = false` claim and the "No CORS configuration needed" SetupGuide step are correct and accurate.

**Important caveat:** If a Wasabi user applies a custom bucket CORS policy via the Wasabi Console's Permissions tab (which does offer a CORS configuration UI even though the S3 API CORS endpoints are unsupported), the permissive defaults would be overwritten. Bucketer cannot detect this. This is a user-error edge case, not a Bucketer bug.

### 5. ListObjectsV2

**Bucketer assumption:** `defaultMaxKeys(WASABI) = 1000`.

**Wasabi docs:** Wasabi is "100% bit-compatible with AWS S3." ListObjectsV2 with Delimiter, Prefix, MaxKeys, and ContinuationToken is supported. The S3 API maximum for MaxKeys is 1000, which Wasabi inherits. The docs confirm batch delete operations work at 1000 objects per batch, implying a consistent 1000-object ceiling across list and delete operations.

**Verdict: ✓**

### 6. PutObject — payload size limits

**Wasabi docs:** Wasabi is S3-compatible. PutObject maximum is 5 GB (single-operation upload). Objects larger than 5 GB require multipart upload. Bucketer correctly switches to multipart for large files.

**Verdict: ✓**

### 7. Multipart upload

Source: https://docs.wasabi.com/docs/how-does-wasabi-handle-multipart-uploads, fetched 2026-06-04.

| Limit | Value | Bucketer assumption |
|---|---|---|
| Minimum part size | 5 MB | 5 MB — matches |
| Maximum part size | 5 GB | — |
| Maximum parts | Not stated in doc (AWS S3 limit: 10,000) | 10,000 — compatible |
| Operations | CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts | All supported |

The 10,000-part maximum is not explicitly documented by Wasabi but is inherited from their S3-compatibility claim. Bucketer's `calcPartSize` enforces this ceiling.

**Verdict: ✓**

### 8. GetObject + presigned URLs

Source: https://docs.wasabi.com/docs/how-do-i-generate-pre-signed-urls-for-temporary-access-with-wasabi, fetched 2026-06-04.

- Presigned URLs supported for GetObject and PutObject.
- Maximum expiry for IAM-user-signed URLs: **7 days**.
- `ResponseContentType` query-string override: not explicitly documented, but Wasabi's S3 compatibility claim implies it should work.

**Verdict: ✓** with WAS-05 note on 7-day ceiling.

### 9. HeadObject

Not separately documented but covered under Wasabi's S3 API compatibility claim. The CORS default response includes HEAD in `Access-Control-Allow-Methods`. No known issues.

**Verdict: ✓**

### 10. CopyObject

Covered by Wasabi's S3 compatibility claim. Standard `CopySource: 'bucket/key'` header format applies. No documented restrictions.

**Verdict: ✓**

### 11. DeleteObject + DeleteObjects

- Batch delete (DeleteObjects) at 1000 objects per call is confirmed by Wasabi documentation on mass-delete operations.
- Partial-error shape follows AWS S3: errors array in response body, each with `Key`, `Code`, and `Message` fields.
- Bucketer's v1.14.0 batch delete (3 concurrent batches of 1000) is compatible.

**Verdict: ✓**

### 12. Versioning

Wasabi supports bucket versioning and `ListObjectVersions`. The documentation includes guidance for deleting current and non-current object versions using version IDs, confirming the feature is present. Bucketer does not currently expose a versioning UI but HeadObject and GetObject with version IDs should work.

**Verdict: ✓**

### 13. ListBuckets

Covered under Wasabi's S3 API compatibility. The default `WasabiFullAccess` IAM policy includes all S3 actions. A user connecting Bucketer with root credentials or a policy that includes `s3:ListAllMyBuckets` will see all buckets.

**Verdict: ✓**

### 14. Minimum-retention business model

Source: https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work, last updated 2026-01-09, fetched 2026-06-04.

Wasabi's Pay-as-You-Go customers are subject to a **90-day minimum storage duration** per object. If an object is deleted before 90 days, a "Timed Deleted Storage" charge is applied for the remaining days at the same per-GB-day rate.

**Example:** Upload 10 GB on Day 1, delete on Day 15. Bill: 15 days × 10 GB active storage + 75 days × 10 GB deleted storage. Net cost: 90 days of 10 GB storage, not 15.

For Reserved Capacity Storage (RCS) customers, the minimum is 30 days.

**Impact on Bucketer users:**
- A developer testing Bucketer by uploading and immediately deleting files will be billed for 90 days of storage per object.
- Bucketer's unified delete UX (v1.14.0) performs the delete with a single confirmation dialog that has no Wasabi-specific caveat.
- A user deleting many small files (e.g. clearing out a test bucket with 500 objects × 1 MB each = 500 MB) after 5 days pays for 85 more days × 500 MB ≈ $0.29. At scale this is non-trivial.
- At 1 TB × day-1 deletion: ~$20.97 unexpected charge.

**Verdict: ⚠ (WAS-02)** Bucketer's delete UX does not communicate this. Recommended: add a Wasabi-specific warning to the delete confirmation dialog and to SetupGuide.

### 15. Free egress / API request fees

Source: https://wasabi.com/pricing/faq, fetched 2026-06-04.

- **Egress:** Free if monthly egress does not exceed total active storage volume.
- **Ceiling:** Monthly downloads capped at 100 TB regardless of storage.
- **Enforcement:** Wasabi reserves the right to limit or suspend service if egress regularly exceeds storage volume.
- **API requests:** No per-request charges (unlike B2 Class C operations). This is why `defaultMaxKeys(WASABI) = 1000` is appropriate.
- **Pricing change:** A rate adjustment is scheduled for on or after 2026-07-01 for existing Pay-Go customers. Egress and API request policies are not affected by this change.

**Verdict: ✓** Bucketer's `defaultMaxKeys(WASABI) = 1000` is correctly justified; Wasabi has no per-call API cost.

### 16. IAM-equivalent permissions

Wasabi uses AWS-compatible IAM policies. The minimum policy for Bucketer (all features enabled) needs the following S3 actions on a specific bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketVersioning"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
        "s3:CopyObject"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

Note: `s3:DeleteObject` covers both DeleteObject and DeleteObjects (the batch operation uses the same IAM action). Wasabi's built-in `WasabiFullAccess` policy is simpler but over-privileged for most use cases.

**Verdict: ✓** No Bucketer-specific IAM gaps identified.

---

## Drift Findings (Severity-Ordered)

### WAS-01 — CORS default assumption is correct (informational, no action needed)

**Severity:** LOW (confirmed correct, not a bug)
**File:** `src/lib/provider.js` line 105, `src/components/SetupGuide.jsx` lines 210–215
**Finding:** `needsCorsConfig(WASABI) = false` and the SetupGuide's "No CORS configuration needed" step are accurate. Wasabi returns `Access-Control-Allow-Origin: *` and permissive method/header defaults automatically. No false negative — Bucketer correctly skips the CORS setup step for Wasabi.
**Action:** None.

### WAS-02 — No 90-day retention warning in delete UX

**Severity:** HIGH (user financial surprise)
**File:** `src/components/App.jsx` (delete confirmation), `src/components/SetupGuide.jsx`
**Finding:** Wasabi Pay-Go users are billed for 90 days of storage per object regardless of when it is deleted. Bucketer's delete confirmation dialog (v1.14.0's unified delete) has no provider-specific warning. A user who uses Wasabi as a scratch bucket, uploading and deleting test data, will be billed for 90 days per object silently.
**Recommended fix:** In the delete confirmation dialog, when `provider === PROVIDERS.WASABI`, show a one-line note: "Wasabi charges for 90 days of storage per object regardless of when it is deleted. Objects deleted today may still incur storage charges through [date + 90 days]." Also add a callout to SetupGuide's Wasabi section.

### WAS-03 — Region list in comments is incomplete; legacy alias endpoints extract wrong region

**Severity:** LOW
**File:** `src/lib/provider.js` (comments only; code is correct)
**Finding:** Two regions not in the code comments: `us-west-2` and `ca-central-1` (Americas), `eu-west-3` and `eu-south-1` (EMEA). The regex handles them correctly at runtime. Legacy alias endpoints like `s3.nl-1.wasabisys.com`, `s3.de-1.wasabisys.com`, `s3.uk-1.wasabisys.com`, `s3.fr-1.wasabisys.com`, `s3.uk-2.wasabisys.com`, `s3.it-1.wasabisys.com` are detected as Wasabi but return alias slugs (`nl-1`, `de-1`, etc.) rather than canonical SigV4 region names. These alias endpoints are legacy and Wasabi recommends the canonical regional URLs.
**Recommended fix:** Update the comment in `provider.js` to list all 16 current regions. Consider adding alias-to-canonical region mapping for legacy alias slugs, or document the limitation.

### WAS-04 — Bucketer uses virtual-hosted style; Wasabi recommends path-style

**Severity:** LOW
**File:** `src/lib/provider.js` line 93
**Finding:** `requiresPathStyle(WASABI)` returns `false`. Wasabi supports both styles but recommends path-style for "greatest flexibility in bucket names, avoiding domain name issues." Bucket names with dots (e.g. `my.bucket.name`) will produce SSL certificate errors with virtual-hosted style because `my.bucket.name.s3.wasabisys.com` won't match the wildcard cert. Path-style avoids this entirely.
**Recommended fix:** Change to `requiresPathStyle(WASABI) = true`, or add a caveat in SetupGuide that bucket names with dots require path-style.

### WAS-05 — Presigned URL 7-day ceiling (informational)

**Severity:** LOW (no current feature affected)
**File:** N/A (no presigned-URL expiry UI in v1.14.0)
**Finding:** Wasabi IAM-user presigned URLs expire at 7 days maximum, matching AWS SigV4 limits. If Bucketer adds a "share link" feature with user-configurable expiry, it must cap at 7 days for Wasabi (and all SigV4 providers).
**Action:** None now; note for share-link feature design.

---

## Getting-Started Links (Canonical, Fetched with Date)

1. **Create a Wasabi account (free trial)**
   - URL: https://docs.wasabi.com/docs/signing-up-for-wasabi
   - Fetched: 2026-06-04 (redirected to main site; confirmed via search result)
   - Trial details: 30 days, up to 1 TB storage, **no credit card required**. After trial, account transitions to Pay-Go with a 1 TB minimum monthly charge.

2. **Full region and endpoint list**
   - URL: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions
   - Fetched: 2026-06-04
   - Use `s3.<region>.wasabisys.com` for all new accounts. The bare `s3.wasabisys.com` still works as an alias for `us-east-1`.

3. **Create a bucket**
   - URL: https://docs.wasabi.com/docs/creating-a-bucket (404 on direct fetch; redirected)
   - Accessible via Wasabi Console → Create Bucket.
   - Naming rules follow AWS S3 conventions (3–63 characters, lowercase letters, numbers, hyphens). Dots are allowed but cause SSL issues with virtual-hosted style.
   - Private by default. Bucketer requires a private bucket with IAM credentials; public ACL is not needed.

4. **Create a Wasabi access key (sub-user)**
   - URL: https://docs.wasabi.com/docs/creating-a-user-account-and-access-key
   - Recommended: create a sub-user (IAM user) rather than using root credentials. Attach a least-privilege policy scoped to the target bucket. Root credentials have full account access.

5. **CORS — no step needed**
   - URL: https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api
   - Fetched: 2026-06-04
   - Wasabi returns `Access-Control-Allow-Origin: *` automatically. No PutBucketCors call needed. Bucketer works out of the box.

6. **Connect with Bucketer**
   - Endpoint format: `https://s3.<region>.wasabisys.com` (e.g. `https://s3.us-east-1.wasabisys.com`)
   - Legacy bare endpoint `https://s3.wasabisys.com` also works and Bucketer auto-detects it as us-east-1.
   - Recommended: use regional endpoint explicitly for clarity.

---

## Cost / Quota Gotchas

### 90-day minimum retention (Pay-Go) — HIGH impact on Bucketer UX

- **Policy:** Every object deleted before 90 days of storage incurs a "Timed Deleted Storage" charge for the remainder of the 90-day window.
- **Rate:** $6.99/TB/month (approximately $0.00023/GB/day). Rate subject to change on or after 2026-07-01.
- **Example:** Upload 1 GB, delete after 1 day → billed for 89 more days × 1 GB ≈ $0.02. At 1 TB scale: ~$20.97.
- **Bucketer impact:** Developer workflows (upload test data → iterate → delete) are penalised. Bucketer's delete confirmation has no warning. The SetupGuide's Wasabi section has no callout.
- **Source:** https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work (updated 2026-01-09)

### 1 TB minimum monthly charge

- Wasabi charges for a minimum of 1 TB of active storage per month, even if actual usage is below 1 TB.
- At $6.99/TB/mo, the minimum monthly bill is $6.99 regardless of how little is stored.
- A user storing only a handful of test files still pays $6.99/month.
- **Bucketer impact:** Low — this is a billing expectation issue, not a UX failure. SetupGuide note recommended.

### Egress acceptable-use policy

- Free egress if monthly downloads ≤ monthly active storage volume.
- Hard cap: 100 TB/month egress regardless of storage size.
- Exceeding the ratio "on a regular basis" risks service limitation or suspension.
- **Bucketer impact:** Low for typical use (primary access, personal or small-team storage). High for anyone using Bucketer as a CDN origin or download host.
- **Source:** https://wasabi.com/pricing/faq (fetched 2026-06-04)

### Pricing change scheduled 2026-07-01

- Wasabi announced a rate adjustment for existing Pay-Go customers, effective on or after 2026-07-01.
- Egress and API request policies are unchanged.
- Specific new rates not published in the FAQ document fetched.
- **Bucketer impact:** None structurally. Numbers in any documentation citing $6.99/TB/mo may be stale after July 2026.
- **Source:** https://docs.wasabi.com/docs/may-2026-wasabi-pricing-faqs (fetched 2026-06-04)

### Reserved Capacity Storage (RCS) — reduced minimum retention

- RCS customers have a 30-day minimum (vs 90 days for Pay-Go).
- RCS requires an upfront capacity commitment.
- Users with high-volume delete workflows should evaluate RCS.

---

## Recommendations for SetupGuide.jsx / README

### 1. Add 90-day retention warning to Wasabi delete flow (HIGH)

In `App.jsx`, the delete confirmation dialog should check `provider === PROVIDERS.WASABI` and display:

> **Wasabi billing note:** Wasabi charges for a minimum of 90 days of storage per object. Deleting now may still result in storage charges for up to 90 days from upload date.

This is the most impactful change — it prevents financial surprise without blocking any UX flow.

### 2. Add 90-day and 1 TB minimum callout to SetupGuide Wasabi section

In `SetupGuide.jsx` `GuideWasabi`, add a short "Cost considerations" step or note:

> Wasabi has a 90-day minimum storage duration per object and a 1 TB/month minimum charge. If you delete objects before 90 days, you are still billed for the remainder. Ideal for workloads where data persists for months; not ideal for ephemeral scratch storage.

### 3. Consider changing `requiresPathStyle(WASABI)` to `true` (LOW)

Wasabi explicitly recommends path-style. Changing this prevents a category of SSL error for users with dots in bucket names. Impact: only affects new connections; existing users would need to reconnect.

### 4. Update `extractRegion` to map legacy alias slugs to canonical regions (LOW)

For `s3.nl-1.wasabisys.com` → `eu-central-1`, etc. Prevents subtle SigV4 signing errors for users on legacy alias endpoints.

### 5. Update code comments with full 16-region list (LOW/cosmetic)

Add `us-west-2`, `ca-central-1`, `eu-west-3`, `eu-south-1` to the Wasabi endpoint comment in `provider.js`.

### 6. Verify presigned URL expiry cap for planned share-link feature (LOW, defer)

When implementing share links with configurable expiry, cap Wasabi at 7 days and document the limit.
