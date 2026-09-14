# AWS S3 — Provider Verification (Bucketer v1.14.0)

## Summary

Bucketer's AWS S3 support is fundamentally correct for the standard single-region bucket use case: virtual-hosted style, SigV4, `us-east-1` fallback, MaxKeys=1000, and `needsCorsConfig=true` all match current AWS docs. The one confirmed correctness finding is that Bucketer's CORS `AllowedHeaders` template includes `amz-sdk-invocation-id` and `amz-sdk-request` as explicit entries — this is necessary and correct because the AWS docs confirm the `x-amz-*` wildcard covers only headers with an `x-amz-` prefix, not the un-prefixed `amz-sdk-*` headers. The biggest surface-level gap is that Bucketer's `extractRegion()` regex matches only the standard `s3.<region>.amazonaws.com` path-style endpoint format; if a user supplies a virtual-hosted endpoint (`mybucket.s3.us-east-1.amazonaws.com`) as the stored endpoint, region extraction falls back to `us-east-1` — harmless for us-east-1 buckets but silently wrong elsewhere. Two S3 product variants are invisible to Bucketer's provider detection: S3 Express One Zone (hostname contains `s3express-`) and S3 on Outposts (hostname contains `s3-outposts.`), both of which end in `amazonaws.com` and will be detected as generic AWS, potentially causing silent failures. No setup-doc URLs were found to be broken; all fetched pages returned current content.

---

## Bucketer's assumptions vs AWS docs

### 1. Endpoint hostnames — ⚠

- **Bucketer**: `/*.amazonaws.com$/i` on the hostname
- **AWS docs** (https://docs.aws.amazon.com/general/latest/gr/s3.html, fetched 2026-06-04): Standard regional endpoints follow `s3.<region>.amazonaws.com`; virtual-hosted style is `<bucket>.s3.<region>.amazonaws.com`. Legacy dash-style (`s3-<region>.amazonaws.com`) is documented. Dualstack endpoints are `s3.dualstack.<region>.amazonaws.com`. FIPS endpoints follow `s3-fips.<region>.amazonaws.com` or `s3-fips.dualstack.<region>.amazonaws.com`. S3 Express One Zone Zonal endpoints follow `<bucket>.s3express-<az-id>.<region>.amazonaws.com`. S3 on Outposts hostname is `<AccessPointName>-<AccountId>.<outpostId>.s3-outposts.<region>.amazonaws.com`.
- **Status**: The `*.amazonaws.com$` pattern correctly matches all of the above (they all end in `.amazonaws.com`). Detection fires correctly. However `extractRegion()` for AWS only matches `^s3\.([^.]+)\.amazonaws\.com$` — it extracts region from the path-style service endpoint but not from virtual-hosted (`<bucket>.s3.<region>.amazonaws.com`) or dualstack (`s3.dualstack.<region>.amazonaws.com`) or Express One Zone endpoints. Furthermore, both S3 Express One Zone and S3 on Outposts will be detected as `PROVIDERS.AWS`, which applies the wrong behavioral assumptions (e.g., `requiresPathStyle=false` is fine, but `defaultMaxKeys=1000` and standard CORS flow don't apply to Express One Zone's session-based auth model or Outposts' access-point-only addressing). These are niche variants, but a user who pastes an Express One Zone endpoint will get a provider label of "AWS S3" with no warning.

### 2. Region resolution — ✓

- **Bucketer**: Falls back to `'us-east-1'` when extraction returns null.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html, fetched 2026-06-04): "Requests made with the legacy global endpoint go to the US East (N. Virginia) Region by default." The legacy global endpoint (`bucket.s3.amazonaws.com`) resolves to `us-east-1`. SigV4 signing requires a region; `us-east-1` is the correct default when no region is present.
- **Status**: Correct. For path-style endpoints (`s3.<region>.amazonaws.com`), region is extracted. For endpoints without region info, `us-east-1` is the documented default.

### 3. Virtual-hosted vs path-style — ✓ ⚠

- **Bucketer**: `forcePathStyle: false` for AWS.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html, fetched 2026-06-04): "Update (September 23, 2020) — To make sure that customers have the time that they need to transition to virtual-hosted–style URLs, we have decided to delay the deprecation of path-style URLs." Path-style still works but is in a deprecation queue with no final date confirmed.
- **Status**: Virtual-hosted is correct and preferred. Caveat: "When you're using virtual-hosted–style general purpose buckets with SSL, the SSL wildcard certificate matches only buckets that do not contain dots (`.`)." Buckets named like `my.bucket.name` will cause SSL certificate errors with virtual-hosted style. Bucketer has no warning for dotted bucket names.

### 4. SigV4 — ✓

- **Bucketer**: AWS SDK v3 default (SigV4).
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html, fetched 2026-06-04): "S3 Express One Zone uses AWS Signature Version 4 (SigV4)." The endpoint table shows us-east-1 supports SigV2 & SigV4 for legacy compatibility; all others are SigV4 only. SDK v3 defaults to SigV4.
- **Status**: Correct. SigV4a (multi-region) is irrelevant for single-bucket usage. No action needed.

### 5. CORS — ✓ ⚠

- **Bucketer template**:
  ```json
  {
    "AllowedMethods": ["GET","PUT","HEAD","POST","DELETE"],
    "AllowedHeaders": ["Authorization","Content-Type","Content-MD5","x-amz-*",
                       "amz-sdk-invocation-id","amz-sdk-request","ETag"],
    "ExposeHeaders": ["ETag","Content-Length","Content-Type"],
    "MaxAgeSeconds": 3600
  }
  ```
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html, fetched 2026-06-04):
  - `AllowedMethods` valid values: `GET`, `PUT`, `POST`, `DELETE`, `HEAD` — all five present in Bucketer's template, correct.
  - `AllowedHeaders` wildcard: "Each AllowedHeaders string in your configuration can contain at most one `*` wildcard character. For example, `<AllowedHeader>x-amz-*</AllowedHeader>` will enable all Amazon-specific headers." The wildcard only covers headers that literally begin with `x-amz-`. Headers `amz-sdk-invocation-id` and `amz-sdk-request` do not have the `x-amz-` prefix, so they are NOT covered by the wildcard. Bucketer's explicit enumeration of these two headers in `AllowedHeaders` is correct and necessary.
  - `ExposeHeaders`: No wildcard support documented; must be an explicit list. Bucketer's three entries (`ETag`, `Content-Length`, `Content-Type`) are all valid standard response headers.
  - `MaxAgeSeconds`: AWS docs show example values of 3000 and 3600 but do not publish a documented maximum. There is no documented upper bound. Bucketer's 3600 is safe.
- **Status**: The `AllowedHeaders` template is correct as-is, including the explicit `amz-sdk-*` headers (BUG-012 fix is valid). One caveat: `ETag` in `AllowedHeaders` is non-standard — ETags are a response header, not a request header — but AWS accepts it without error and it does no harm. Low priority cosmetic issue.

### 6. ListObjectsV2 — ✓

- **Bucketer**: `defaultMaxKeys(AWS) = 1000`.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/ListingKeysUsingAPIs.html, fetched 2026-06-04): "Each list keys response returns a page of up to 1,000 keys." The maximum for MaxKeys is 1000. Bucketer's default matches the API ceiling.
- **Status**: Correct. Delimiter='/' and CommonPrefixes semantics are standard; Bucketer uses them correctly for folder-simulation browsing.

### 7. PutObject — ✓

- **Bucketer**: Uses single-shot PutObject for files below the multipart threshold.
- **AWS docs** (https://docs.aws.amazon.com/general/latest/gr/s3.html quotas table, fetched 2026-06-04): Max object size 48.8 TiB via multipart; single-shot PutObject is limited to 5 GB (from CopyObject docs: "You create a copy of your object up to 5 GB in size in a single atomic action").
- **Status**: Bucketer switches to multipart well before the 5 GB single-shot limit. Content-Type is passed by the SDK from the browser's `File.type`. Correct.

### 8. Multipart upload — ✓

- **Bucketer**: Uses multipart for large files. Resume via ListParts.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html, fetched 2026-06-04):
  - Max object size: **48.8 TiB** (Bucketer docs/source may reference 5 TB — this is outdated; AWS raised it to 48.8 TiB)
  - Max parts: **10,000**
  - Part size: **5 MiB minimum** (except last part), **5 GiB maximum**
  - ListParts max per response: **1,000**
  - "We recommend that you configure a lifecycle rule to delete incomplete multipart uploads after a specified number of days by using the `AbortIncompleteMultipartUpload` action."
- **Status**: Core limits are correct in Bucketer's implementation (`calc-part-size.js` enforces 5 MB floor, 10,000-part ceiling). The max object size figure of 5 TB seen in older docs is now stale — AWS updated it to 48.8 TiB. This doesn't affect Bucketer's behavior but any user-facing text should reference the current limit. AWS still recommends a lifecycle rule for abandoned parts; SetupGuide has no mention of this.

### 9. GetObject + presigned URLs — ✓

- **Bucketer**: Uses presigned `GetObject` with optional `ResponseContentType`.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html, fetched 2026-06-04): "When you use the AWS CLI, the maximum expiration time for a presigned URL is 7 days from the time of creation" (604800 seconds). `ResponseContentType` is a standard `GetObject` query parameter override and is documented in the S3 API.
- **Status**: Bucketer's use of `ResponseContentType` for preview text-forcing is correct and documented. 7-day max is correct for SigV4 presigned URLs.

### 10. HeadObject — ✓

- **Bucketer**: Uses HeadObject for metadata.
- **AWS docs**: HeadObject requires the same `s3:GetObject` IAM permission as GetObject. Returns all standard metadata headers (Content-Type, Content-Length, ETag, Last-Modified, etc.) without the object body. Identical auth requirements to GetObject.
- **Status**: Correct. No gaps.

### 11. CopyObject — ✓ ⚠

- **Bucketer**: Uses CopyObject; `CopySource` is provided via SDK as `bucket/key`.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html, fetched 2026-06-04): "You create a copy of your object up to 5 GB in size in a single atomic action using this API." The `x-amz-copy-source` header value format is `bucket/key` — the `/` separator does not need encoding but special characters in the key do require URL encoding.
- **Status**: AWS SDK v3 handles CopySource encoding automatically. Correct. One note: CopyObject max is 5 GB; for objects larger than 5 GB, multipart copy (`UploadPartCopy`) is required. Bucketer's copy operation (if it performs one) should be verified to gate on size, but this is an implementation detail of copy logic, not a provider configuration issue.

### 12. DeleteObject + DeleteObjects — ✓

- **Bucketer**: Batches deletes via `DeleteObjectsCommand`, 3 concurrent batches.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html, fetched 2026-06-04): Batch max is **1,000** objects per request. Error response is an `<Error>` array where each entry contains `<Key>`, `<Code>`, `<Message>`, and optionally `<VersionId>`. Successful HTTP response is 200.
- **Status**: Correct. The SDK handles batch splitting. Error response shape matches what Bucketer's delete logic would parse.

### 13. Versioning — ✓

- **Bucketer**: Uses ListObjectVersions with `NextKeyMarker`/`NextVersionIdMarker` pagination.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html, fetched 2026-06-04): Response contains `<Version>` array and `<DeleteMarker>` array. Truncation uses `IsTruncated` + `NextKeyMarker` + `NextVersionIdMarker`. Max 1,000 entries per page. Requires `s3:ListBucketVersions` permission.
- **Status**: Correct. IAM permission name (`s3:ListBucketVersions`, not `s3:ListObjectVersions`) is a common gotcha — ensure Bucketer's IAM policy template uses the right action name.

### 14. ListBuckets — ⚠

- **Bucketer**: Planned for v2.0 multi-bucket support.
- **AWS docs**: `ListBuckets` requires `s3:ListAllMyBuckets` (not `s3:ListBuckets`). This is a common source of confusion. In minimal-permission IAM setups (e.g., a scoped-to-one-bucket user), `s3:ListAllMyBuckets` is frequently omitted or denied. `ListBuckets` also returns all buckets in all regions in the account — there is no server-side region filter.
- **Status**: Not yet implemented, but the gotcha should be documented in v2.0 work: users with narrow IAM policies will see an "Access Denied" on ListBuckets even if they can read/write objects in a specific bucket.

### 15. Practical limits — ✓ ⚠

- **Bucketer**: Uses standard S3 API limits throughout.
- **AWS docs** (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html, fetched 2026-06-04):
  - Bucket names: 3–63 chars, lowercase letters/numbers/hyphens/periods only, must begin and end with letter or number, no adjacent periods, no IP-address format, no `xn--` / `sthree-` / `amzn-s3-demo-` prefixes, no `-s3alias` / `--ol-s3` / `.mrap` / `--x-s3` / `--table-s3` suffixes.
  - New reserved suffix: `--x-s3` (directory buckets), `--table-s3` (S3 Tables).
  - Max objects per bucket: unlimited.
  - Max object size: 48.8 TiB.
- **Status**: Bucketer has no bucket-name validation UI, which is fine (the server rejects invalid names). The 48.8 TiB max object size should replace any "5 TB" references in user-facing docs. The `amzn-s3-demo-` prefix is AWS-reserved; users creating demo-named buckets will get an error.

---

## Drift findings (severity-ordered)

### [AWS-01] `extractRegion()` misses virtual-hosted endpoint format — Medium

- **Bucketer location**: `src/lib/provider.js:72`
- **What Bucketer assumes**: The user supplies a path-style service endpoint (`https://s3.us-west-2.amazonaws.com`) as the "endpoint" field, so regex `^s3\.([^.]+)\.amazonaws\.com$` always matches.
- **What AWS docs say**: The canonical user-facing endpoint for a bucket is virtual-hosted style (`https://mybucket.s3.us-east-1.amazonaws.com`). AWS CLI and console prefer this form. A user who pastes this URL will get region extraction returning null, falling back to `us-east-1` — silently wrong for any non-us-east-1 bucket.
- **Why this matters**: Wrong SigV4 region causes `SignatureDoesNotMatch` errors for all requests.
- **Recommendation**: Extend `extractRegion(AWS)` to also match `^[^.]+\.s3\.([^.]+)\.amazonaws\.com$` (virtual-hosted bucket endpoint) and `^s3\.dualstack\.([^.]+)\.amazonaws\.com$` (dualstack). Or, better: document clearly in SetupGuide that the user must supply the service endpoint, not the virtual-hosted bucket URL.

### [AWS-02] S3 Express One Zone silently detected as generic AWS — Medium

- **Bucketer location**: `src/lib/provider.js:36` (PATTERNS array)
- **What Bucketer assumes**: Any `*.amazonaws.com` host is standard AWS S3.
- **What AWS docs say**: S3 Express One Zone uses `<bucket>.s3express-<az-id>.<region>.amazonaws.com` Zonal endpoints with session-based authentication (`CreateSession`), no versioning, and different concurrency semantics. The standard SDK client handles this, but the user experience in Bucketer (CORS setup guide, SetupGuide instructions) will be wrong.
- **Why this matters**: A user attempting S3 Express One Zone will see the standard AWS CORS setup guide, which does not apply to the session-based auth model of Express One Zone.
- **Recommendation**: Add an `s3express` pattern (`/\.s3express-[^.]+\.[^.]+\.amazonaws\.com$/i`) before the generic AWS pattern, mapping to either a dedicated provider variant or `PROVIDERS.GENERIC` with a note.

### [AWS-03] No lifecycle rule guidance for abandoned multipart uploads — Low

- **Bucketer location**: `src/components/SetupGuide.jsx` GuideAWS function
- **What Bucketer assumes**: No guidance given.
- **What AWS docs say**: "We recommend that you configure a lifecycle rule to delete incomplete multipart uploads after a specified number of days by using the `AbortIncompleteMultipartUpload` action." Incomplete uploads accumulate in storage and incur charges until explicitly deleted or cleaned up by lifecycle policy.
- **Why this matters**: Users with failed/abandoned uploads will silently accumulate storage charges. This is a UX cost gotcha, not a correctness issue.
- **Recommendation**: Add a note in SetupGuide's AWS guide (and optionally the resume-upload UI) pointing to the lifecycle rule recommendation.

### [AWS-04] Dotted bucket name + SSL caveat not surfaced — Low

- **Bucketer location**: No current validation in CredentialForm.
- **What AWS docs say**: "When you're using virtual-hosted–style general purpose buckets with SSL, the SSL wildcard certificate matches only buckets that do not contain dots (`.`)."
- **Why this matters**: A user with a bucket named `my.bucket.example` will get SSL errors that are confusing to diagnose.
- **Recommendation**: In CredentialForm or SetupGuide, warn users that bucket names with dots require path-style addressing (or HTTP-only), which Bucketer does not support for AWS.

### [AWS-05] Max object size reference may be stale — Nit

- **Bucketer location**: Any user-facing docs or comments referencing "5 TB".
- **What AWS docs say**: The quota table at https://docs.aws.amazon.com/general/latest/gr/s3.html (fetched 2026-06-04) lists "Object size: Each Account: 48.828125 Terabytes." The multipart limits page confirms this. The old 5 TB figure is outdated.
- **Recommendation**: Update any "5 TB" references in docs and comments to "48.8 TiB."

---

## Getting-started links (canonical)

1. **Create AWS account** — [Create and activate an AWS account](https://aws.amazon.com/premiumsupport/knowledge-center/create-and-activate-aws-account/) — fetched 2026-06-04. Gotcha: new accounts have IAM best practices enforced by default (root account should not be used for API access; create an IAM user or role instead).

2. **Create S3 bucket** — [Creating a general purpose bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html) — fetched 2026-06-04. Recommended: choose the region closest to your users. Avoid periods in bucket names to prevent SSL issues with virtual-hosted style. New default: Block Public Access is enabled by default; Bucketer does not need public access since it uses signed requests.

3. **Create IAM user + access key** — [Creating an IAM user in your AWS account](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html) — fetched 2026-06-04. Gotcha: as of 2024, AWS recommends using IAM Identity Center (SSO) over long-term IAM user access keys. For Bucketer's browser-direct use case, a dedicated IAM user with an access key is still the practical approach. Do not use root account credentials.

4. **Minimum IAM policy for full Bucketer use** (derived from behaviours 6–14 above):

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
      "Resource": "*",
      "Comment": "Required only for Bucketer v2.0 multi-bucket. Can be omitted for v1."
    }
  ]
}
```

  Notes on this policy:
  - `s3:ListBucketVersions` (not `s3:ListObjectVersions`) is the correct IAM action name for ListObjectVersions API calls.
  - `s3:ListMultipartUploadParts` is needed for multipart resume via ListParts.
  - `s3:PutBucketCORS` / `s3:GetBucketCORS` are needed only if the user wants to apply CORS from within Bucketer (currently done via CLI); they can be omitted if CORS is applied once externally.
  - `s3:ListAllMyBuckets` targets `Resource: "*"` (it does not accept a bucket ARN).

5. **Apply CORS** — [Configuring cross-origin resource sharing (CORS)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html) — fetched 2026-06-04. The AWS CLI command in Bucketer's SetupGuide (`aws s3api put-bucket-cors --profile bucketer --bucket <name> --cors-configuration '<json>'`) is correct syntax. Omitting `--endpoint-url` for AWS is correct (as SetupGuide notes). The JSON must use the `CORSRules` key (capital R, plural) as shown in `corsJson()`.

6. **Connect with Bucketer** — Use endpoint `https://s3.<region>.amazonaws.com` (e.g. `https://s3.us-east-1.amazonaws.com`). Do not paste the virtual-hosted bucket URL. The region field in Bucketer will be auto-extracted from this endpoint format. This is the critical UX gotcha: users accustomed to the AWS console URL format (`mybucket.s3.us-east-1.amazonaws.com`) must convert it to the service endpoint form. See drift finding AWS-01.

---

## Cost / quota gotchas

- **Free tier (as of 2026)**: AWS now gives new accounts up to $200 in credits (6-month validity, valid for 12 months). The old "5 GB free + 20,000 GETs + 2,000 PUTs" per-service free tier structure has been supplemented by a credits model. Check the current AWS Free Tier page for latest terms.

- **Egress pricing**: AWS charges for data transferred out to the internet. "Data transferred out to the internet for the first 100 GB per month, aggregated across all AWS Services and Regions (except China and GovCloud) is free." After 100 GB/month, standard per-GB egress rates apply (approximately $0.09/GB for us-east-1). Bucketer's preview feature (fetching object content to display in browser) incurs egress charges at standard rates. For large media files, previewing via Bucketer is not free.

- **LIST request pricing**: ListObjectsV2 and ListObjectVersions are charged as LIST requests ($0.005 per 1,000 requests in us-east-1). Bucketer's `defaultMaxKeys=1000` means each folder navigation is one LIST call. This is efficient. However, the preview prefetch pattern (if it issues extra ListObjectsV2 or HeadObject calls per navigation) will accumulate LIST/GET charges. The AWS docs note: "When you use the Amazon S3 console to browse your storage, you incur charges for GET, LIST, and other requests that are made to facilitate browsing." The same applies to Bucketer.

- **PUT/COPY request pricing**: Each `PutObject` (upload) and `CopyObject` is charged as a PUT request ($0.005 per 1,000). Multipart upload generates multiple requests: 1 CreateMultipartUpload + N UploadPart + 1 CompleteMultipartUpload. For a 100-part upload, that's 102 PUT-class requests.

- **Abandoned multipart parts**: Incomplete multipart uploads accumulate as stored bytes at standard storage rates until explicitly aborted or cleaned by lifecycle policy. This is easy to overlook and can cause unexpected bills. See finding AWS-03.

- **No per-object storage limit**: The S3 bucket itself has unlimited object count. `defaultMaxKeys=1000` is not "aggressive" in a cost sense — it's efficient (fewer LIST calls per page). The free 100 GB egress allowance is shared across all AWS services in the account, not S3-specific.

---

## Recommendations for SetupGuide.jsx / README

1. **SetupGuide AWS step 1**: Add a sentence clarifying that the endpoint to enter in Bucketer should be the service endpoint form (`https://s3.<region>.amazonaws.com`), not the bucket URL. Example: "Use `https://s3.us-east-1.amazonaws.com` — not `https://mybucket.s3.us-east-1.amazonaws.com`."

2. **SetupGuide AWS step 2** (after CORS): Add a callout recommending a lifecycle rule for abandoned multipart uploads:
   ```
   aws s3api put-bucket-lifecycle-configuration \
     --profile bucketer \
     --bucket YOUR-BUCKET \
     --lifecycle-configuration '{"Rules":[{"ID":"abort-incomplete-mpu","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
   ```

3. **SetupGuide AWS**: Add a note for users with dotted bucket names that SSL + virtual-hosted style is not supported by AWS for dotted names; they should avoid dots in S3 bucket names used with Bucketer.

4. **IAM policy in README / docs**: Replace any existing minimal IAM policy snippet with the one above (section 4), being careful to use `s3:ListBucketVersions` (not `s3:ListObjectVersions`) and to include `s3:ListMultipartUploadParts`.

5. **Max object size references**: Update any "5 TB" text to "48.8 TiB (AWS current limit as of 2025)".

6. **v2.0 multi-bucket planning**: Note that `s3:ListAllMyBuckets` must target `Resource: "*"` and will be denied by narrow-scoped IAM policies. Recommend gracefully falling back to single-bucket mode when ListBuckets returns 403.
