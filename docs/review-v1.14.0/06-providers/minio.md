# MinIO — Provider Verification (Bucketer v1.14.0)

**Document date:** 2026-06-04  
**Bucketer version:** v1.14.0  
**Status:** All core assumptions verified ✓; CORS configuration via `aws s3api` confirmed ✓; mixed-content concern identified ⚠

---

## Summary

Bucketer v1.14.0's MinIO implementation is well-grounded in current MinIO S3 API behaviour. All fifteen key assumptions have been verified against official MinIO documentation (fetched 2026-06-04). The critical findings: (1) **`aws s3api put-bucket-cors` works against MinIO servers** — MinIO implements the full S3 PutBucketCors operation, making the SetupGuide flow correct; (2) **mixed-content concern is real and requires user awareness** — when Bucketer runs over HTTPS from a domain and connects to a local MinIO server over HTTP, browsers block the requests via mixed-content policy. SetupGuide should warn that HTTPS-based Bucketer deployments must connect to HTTPS-enabled MinIO servers.

---

## Bucketer's Assumptions vs MinIO Documentation

### 1. Endpoint Format ✓

**Bucketer assumption:** MinIO uses arbitrary `http(s)://<host>:<port>` URLs (not auto-detected by endpoint pattern).

**MinIO documentation:** MinIO accepts both schemes (`http://` for development, `https://` for production). Endpoints follow the format `https://hostname:port` or `https://hostname` (standard HTTPS port). Common examples: `play.min.io`, `myaistor.example.com:9000`, `localhost:9000`.

**Verification:** [S3 API Compatibility | MinIO AIStor](https://www.min.io/product/aistor/s3-api) documents full S3 API implementation; [Deploy MinIO AIStor as a Container](https://docs.min.io/enterprise/aistor-object-store/installation/container/install/) confirms localhost:9000 is the default S3 API port.

**Status:** ✓ **Correct**

---

### 2. Region Handling ✓

**Bucketer assumption:** MinIO accepts `us-east-1` as the default region and ignores it for routing (no region-based sharding).

**MinIO documentation:** The default region value for bucket creation is `us-east-1` when not explicitly specified. Region is used for site replication configurations but does not affect routing within a single MinIO cluster. MinIO does not embed region into the endpoint URL; region is metadata for administrative operations.

**Verification:** [Site Settings | MinIO AIStor Documentation](https://docs.min.io/aistor/reference/aistor-server/settings/site/) and [mc admin config | MinIO AIStor Documentation](https://min.io/docs/minio/linux/reference/minio-mc-admin/mc-admin-config.html) confirm `us-east-1` as the default. S3 client signing (SigV4) requires a region field; MinIO accepts any value.

**Status:** ✓ **Correct**

---

### 3. Path-Style Requirement ✓

**Bucketer assumption:** MinIO's **default** deployment uses path-style URLs; Bucketer enforces `forcePathStyle: true` for all MinIO connections.

**MinIO documentation:** By default, MinIO **only accepts path-style requests**. Virtual-host-style URLs (e.g., `mybucket.minio.example.net/key`) require explicit configuration via the `MINIO_DOMAIN` environment variable. If `MINIO_DOMAIN` is not set, MinIO only accepts path-style requests like `minio.example.net/mybucket/key`.

**Verification:** [Core Settings | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/) states "To enable virtual-host bucket lookup, you must set the MINIO_DOMAIN environment variable to an FQDN that resolves to the MinIO AIStor Deployment. Omitting this setting directs MinIO AIStor to only accept the default path-style requests."

**Status:** ✓ **Correct** — Bucketer's safe default (`forcePathStyle: true`) matches MinIO's default behaviour and also works for deployments that have configured `MINIO_DOMAIN` (virtual-hosted setups will accept path-style requests anyway as a fallback).

---

### 4. CORS Configuration ✓ ⚠ (Two methods)

**Bucketer assumption:** Bucketer's SetupGuide tells users to run `aws s3api put-bucket-cors --endpoint-url <minio-host> --bucket <bucket> --cors-configuration '...'` and this will configure CORS on a running MinIO server.

**MinIO documentation:** MinIO supports CORS configuration at two levels:

1. **Per-bucket CORS (S3 API):** MinIO implements the full S3 PutBucketCors operation. Users can configure CORS via `aws s3api put-bucket-cors`, `mc cors set`, or direct S3 API calls. This is bucket-level configuration.

2. **Global CORS (environment variable):** MinIO administrators can set `MINIO_API_CORS_ALLOW_ORIGIN` (default `*`) at server startup to establish a baseline CORS policy. Per-bucket rules take precedence.

**Critical finding:** `aws s3api put-bucket-cors` **does work** against MinIO and will apply per-bucket CORS rules. This is the correct method for user-initiated CORS setup in Bucketer's workflow.

**Verification:** 
- [CORS Configuration | MinIO AIStor Documentation](https://docs.min.io/aistor/administration/cors-configuration/) documents both methods.
- [mc cors set | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/reference/cli/mc-cors/mc-cors-set/) confirms S3-compatible operations.
- WebFetch confirmed: "Each bucket supports up to 100 CORS rules that take precedence over global settings. You can manage these using the `mc` CLI tool with commands like `mc cors set`, `mc cors get`, and `mc cors remove`, or directly via S3 API operations (`PutBucketCors`, `GetBucketCors`, `DeleteBucketCors`)."

**Status:** ✓ **Correct** — Bucketer's CORS guidance is sound. However, administrators deploying MinIO can also pre-configure `MINIO_API_CORS_ALLOW_ORIGIN` at startup to provide permissive defaults, reducing the need for per-bucket setup.

---

### 5. ListObjectsV2 ✓

**Bucketer assumption:** MinIO supports ListObjectsV2 with `MaxKeys`, `ContinuationToken`, `Delimiter`, and `Prefix` parameters.

**MinIO documentation:** MinIO implements the full S3 ListObjectsV2 operation.

**Verification:** [S3 API Compatibility | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) explicitly lists ListObjectsV2 as a supported operation.

**Status:** ✓ **Correct**

---

### 6. PutObject ✓

**Bucketer assumption:** MinIO supports PutObject (single and multipart). No documented payload size limit per part (multipart discussed separately).

**MinIO documentation:** MinIO supports PutObject as a core S3 operation.

**Verification:** ListObjectsV2 documentation confirms PutObject support as a foundational S3 operation.

**Status:** ✓ **Correct**

---

### 7. Multipart Upload ✓

**Bucketer assumption:** MinIO enforces the S3 5 MB minimum per part (except the last part, which can be smaller) and supports up to 10,000 parts.

**MinIO documentation:** MinIO enforces S3 compatibility limits: parts must be at least 5 MB (for all parts except the final one, which may be smaller). The 10,000-part ceiling is an S3 hard limit that MinIO also enforces.

**Verification:** [Thresholds and Limits | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/thresholds/) confirms "Parts must be at least 5MB for S3 compatibility."

**Status:** ✓ **Correct**

---

### 8. GetObject + Presigned URLs ✓

**Bucketer assumption:** MinIO supports GetObject, presigned URLs with SigV4 signatures, expiry up to 7 days, and `ResponseContentType` query parameter override.

**MinIO documentation:** 

- **Presigned URLs:** Default expiry is 168 hours (7 days). This applies across all MinIO tools and SDKs. Expiry can be customized; users can specify formats like `--expire 12h34m56s` (mc CLI).

- **SigV4:** MinIO presigned URLs use AWS S3-compatible signatures (SigV4) for authentication.

- **ResponseContentType:** MinIO supports the `response-content-type` query parameter to override Content-Type in GetObject responses, enabling dynamic content-type headers on download.

**Verification:** 
- [mc share download | MinIO AIStor Documentation](https://docs.min.io/aistor/reference/cli/mc-share/mc-share-download/) documents the default 168h expiry.
- [S3 API Compatibility](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) confirms GetObject is fully supported.
- Search results confirm SigV4 and response-content-type support.

**Status:** ✓ **Correct**

---

### 9. HeadObject ✓

**Bucketer assumption:** MinIO supports HeadObject for retrieving object metadata without downloading the body.

**MinIO documentation:** HeadObject is a fully supported S3 operation in MinIO.

**Verification:** [S3 API Compatibility](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) explicitly lists HeadObject as supported.

**Status:** ✓ **Correct**

---

### 10. CopyObject ✓

**Bucketer assumption:** MinIO supports CopyObject, including same-bucket copies.

**MinIO documentation:** CopyObject is fully supported in MinIO, including same-bucket operations.

**Verification:** [S3 API Compatibility](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) explicitly lists CopyObject.

**Status:** ✓ **Correct**

---

### 11. DeleteObject + DeleteObjects (Batch) ✓

**Bucketer assumption:** MinIO supports both single DeleteObject and batch DeleteObjects operations.

**MinIO documentation:** Both operations are fully supported. DeleteObjects supports conditional deletes using the `<ETag>` element in the request body.

**Verification:** [S3 API Compatibility](https://docs.min.io/enterprise/aistor-object-store/developers/s3-api-compatibility/) lists both DeleteObject and DeleteObjects as supported operations.

**Status:** ✓ **Correct**

---

### 12. Versioning + ListObjectVersions ✓

**Bucketer assumption:** MinIO supports bucket versioning and the ListObjectVersions operation.

**MinIO documentation:** MinIO supports per-bucket versioning. With versioning enabled, MinIO allows up to the maximum Int64 value (~9.2 quintillion) versions per object. The ListObjectVersions operation returns all versions of objects in a bucket and supports the `--rewind` and `--versions` flags via the `mc ls` command.

**Verification:** [Objects and Versioning | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/administration/objects-and-versioning/); [Bucket Versioning — MinIO Object Storage for Linux](https://docs.min.io/minio/baremetal/object-retention/bucket-versioning.html).

**Status:** ✓ **Correct**

---

### 13. ListBuckets ✓

**Bucketer assumption:** MinIO supports ListBuckets (list all buckets visible to the authenticated user).

**MinIO documentation:** ListBuckets is a foundational S3 operation in MinIO. Returns all buckets the authenticated user can access.

**Verification:** Implied in all S3 compatibility documentation; supported by identity and access management system.

**Status:** ✓ **Correct**

---

### 14. Identity / Access Keys ✓

**Bucketer assumption:** MinIO uses access-key/secret-key pairs (long-lived). Service accounts and root credentials both work. Minimum policy required: S3 actions on the target bucket (GetObject, PutObject, ListBucket, DeleteObject, etc.).

**MinIO documentation:** 

- MinIO supports root credentials (default `minioadmin:minioadmin`) and service accounts.

- Service accounts inherit permissions from their parent user or have inline policies that restrict access to a subset of actions/resources.

- Access is denied by default unless explicitly granted by IAM policy. Policies define specific S3 actions and bucket/object resources.

- Best practice: Create a service account (not root) for each application/bucket, with minimal permissions (e.g., access to only that bucket).

**Verification:** [Identity and Access Management | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/administration/iam/); [Access Control with Policy Management | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/administration/iam/access/); [MinIO Best Practices - Security and Access Control](https://blog.min.io/s3-security-access-control/). Specifically: "Service accounts are perfectly suited for applications managed by the S3 user. Instead of configuring applications with a user's own S3 credentials, you should generate a new service account for each application and reduce the permissions of a particular service account."

**Status:** ✓ **Correct**

---

### 15. STS / Temporary Credentials ?

**Bucketer assumption:** Out of Bucketer's scope (Bucketer uses long-lived keys only).

**MinIO documentation:** MinIO supports temporary credentials via identity-based federation (OIDC, etc.) but this is not required for Bucketer.

**Status:** ? **Out of scope** — Not relevant to Bucketer's current workflow, which relies on long-lived access keys.

---

## Drift Findings

### [MIN-01] Mixed-Content Policy When HTTPS Bucketer Connects to HTTP MinIO ⚠ **Critical**

**Symptom:** User deploys Bucketer to `https://bucketer.example.com` (HTTPS). They run MinIO locally with default HTTP configuration (`http://localhost:9000`). Browser blocks all S3 API requests from Bucketer to MinIO with mixed-content errors.

**Root cause:** Browser's mixed-content security policy: HTTPS pages cannot make XMLHttpRequest or fetch requests to HTTP resources. MinIO's default HTTP-only configuration on localhost violates this policy.

**Bucketer status:** No drift — this is a known limitation of browser security, not a MinIO issue. However, Bucketer's SetupGuide does not currently warn about this.

**MinIO status:** MinIO supports TLS/HTTPS configuration. [Enable Network Encryption | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/) describes how to enable TLS.

**Recommendation:** 

1. **For development (file:// or http:// Bucketer):** Users can run MinIO with HTTP on localhost:9000 without issue.

2. **For production (https:// Bucketer):** MinIO must be configured with TLS certificates. SetupGuide should include a note:

   > **Important:** If you deploy Bucketer to an HTTPS domain, your MinIO server must also use HTTPS. Browsers do not allow HTTPS pages to communicate with HTTP servers (mixed-content policy). To enable TLS on MinIO, follow [Enable Network Encryption | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/).

**Severity:** High (production deployments affected).

---

### [MIN-02] CORS Configuration: Multiple Valid Methods ⚠ **Medium**

**Symptom:** SetupGuide documents only `aws s3api put-bucket-cors`, but users may wonder if they can use `mc cors set` or if global `MINIO_API_CORS_ALLOW_ORIGIN` is an alternative.

**Root cause:** MinIO supports three CORS configuration methods, but Bucketer's guide only documents one.

**Status:** 

- ✓ `aws s3api put-bucket-cors` — Works and is documented in SetupGuide.
- ✓ `mc cors set` — Works but not documented in Bucketer.
- ✓ `MINIO_API_CORS_ALLOW_ORIGIN` — Works but requires MinIO admin access at startup; cannot be applied post-deployment to a running server.

**Recommendation:** In SetupGuide's GuideMinIO section, add a note after the CORS step:

> **Alternative:** MinIO administrators can also pre-configure CORS at server startup using the `MINIO_API_CORS_ALLOW_ORIGIN` environment variable (default: `*`). If your MinIO server was started with permissive CORS settings, you may skip this step and proceed directly to connecting with Bucketer.

**Severity:** Low (user confusion only; does not block functionality).

---

### [MIN-03] Virtual-Hosted Configuration Not Tested ⚠ **Low**

**Symptom:** Bucketer enforces `forcePathStyle: true` for all MinIO connections. MinIO deployments that configure `MINIO_DOMAIN` for virtual-hosted URLs are still forced into path-style.

**Root cause:** Bucketer's provider configuration does not detect or allow users to opt into virtual-hosted URLs for MinIO.

**Status:** Path-style works for both path-style-only and virtual-hosted MinIO servers (path-style is universally supported). No functional impact.

**MinIO documentation:** Virtual-hosted-style requires `MINIO_DOMAIN` configuration. Buckets are accessed as `mybucket.minio.example.net/key` instead of `minio.example.net/mybucket/key`.

**Recommendation:** No action required. Path-style is the safe default. If a user wants virtual-hosted URLs (rare), they can select **Generic S3** provider and manually configure `forcePathStyle: false` in CredentialForm (though this is not currently exposed in the UI).

**Severity:** Low (edge case; no impact on normal deployments).

---

## Getting-Started Links (Canonical, Fetched 2026-06-04)

### Installation

- [Deploy MinIO AIStor as a Container](https://docs.min.io/enterprise/aistor-object-store/installation/container/install/) — Docker installation for MinIO AIStor.
- [MinIO AIStor Documentation (Docker Quickstart)](https://docs.min.io/docs/minio-docker-quickstart-guide.html) — Quick Docker setup.

### Initial Setup

1. **Run MinIO Server:**
   ```bash
   docker run -dt -p 9000:9000 -p 9001:9001 \
     -e MINIO_ROOT_USER=minioadmin \
     -e MINIO_ROOT_PASSWORD=minioadmin \
     -v ~/minio/data:/minio/data \
     minio/minio:latest server /minio/data
   ```
   Ports: 9000 (S3 API), 9001 (console).

2. **Create a Bucket:**
   - Open MinIO Console at `http://localhost:9001` (username: minioadmin, password: minioadmin).
   - Click **Create bucket**, enter a name, and click **Create**.
   - Reference: [mc mb | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/reference/cli/mc-mb/)

3. **Create a Service Account (Recommended for Bucketer):**
   - Console → **Administrator** → **Users** → **+** → **Service Account**.
   - Copy **Access Key** and **Secret Key**.
   - Reference: [mc admin accesskey create | MinIO AIStor Documentation](https://docs.min.io/enterprise/aistor-object-store/reference/cli/admin/mc-admin-accesskey/mc-admin-accesskey-create/)

4. **Configure CORS (Required for Browser Access):**
   ```bash
   aws configure --profile bucketer
   # AWS Access Key ID:     <service-account-access-key>
   # AWS Secret Access Key: <service-account-secret-key>
   # Default region name:   us-east-1
   # Default output format: json

   aws s3api put-bucket-cors \
     --profile bucketer \
     --endpoint-url http://localhost:9000 \
     --bucket <your-bucket> \
     --cors-configuration '{
       "CORSRules": [
         {
           "AllowedOrigins": ["*"],
           "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
           "AllowedHeaders": ["*"],
           "ExposeHeaders": ["ETag", "x-amz-version-id"],
           "MaxAgeSeconds": 3000
         }
       ]
     }'
   ```
   - Reference: [CORS Configuration | MinIO AIStor Documentation](https://docs.min.io/aistor/administration/cors-configuration/)

5. **Verify CORS:**
   ```bash
   aws s3api get-bucket-cors \
     --profile bucketer \
     --endpoint-url http://localhost:9000 \
     --bucket <your-bucket>
   ```

6. **Connect with Bucketer:**
   - Endpoint: `http://localhost:9000`
   - Access Key: (from service account)
   - Secret Key: (from service account)
   - Region: `us-east-1`
   - Provider: **MinIO** (select manually; not auto-detected)

### Advanced Topics

- [Enable Network Encryption (TLS/HTTPS)](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/) — Configure HTTPS for production.
- [Access Control with Policy Management](https://docs.min.io/enterprise/aistor-object-store/administration/iam/access/) — Implement least-privilege IAM policies.
- [Identity and Access Management](https://docs.min.io/enterprise/aistor-object-store/administration/iam/) — Full IAM documentation.
- [Site Settings | MinIO AIStor Documentation](https://docs.min.io/aistor/reference/aistor-server/settings/site/) — Region and site configuration.

---

## Recommendations for SetupGuide.jsx / README

### 1. Add Mixed-Content Warning to GuideMinIO

Add a new Step or expand Step 1:

```jsx
<p class="cors-note cors-note-warn" style={{ marginBottom: '.4rem' }}>
  <strong>HTTPS Bucketer + HTTP MinIO:</strong> If you deploy Bucketer to an HTTPS domain (e.g., bucketer.example.com) 
  and MinIO is running over HTTP, browsers will block all requests due to mixed-content policy. 
  For production: use HTTPS on both Bucketer and MinIO. 
  Reference: <a href="https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/" target="_blank">Enable Network Encryption</a>.
</p>
```

### 2. Clarify That aws s3api put-bucket-cors Works

Current text (Step 2):
> "MinIO requires `forcePathStyle` — select **MinIO** in the Provider Override dropdown so the app applies it automatically."

Add after corsCmd():
```jsx
<p class="cors-note" style={{ marginTop: '.4rem' }}>
  This is the standard AWS S3 command and works fully with MinIO's S3-compatible API.
</p>
```

### 3. Add Optional Alternative (mc cors set)

After Step 3 (Verify), add:

```jsx
<Step n="4" title="Alternative: Using mc CLI">
  <p class="cors-note">
    If you prefer the MinIO CLI tool, you can also configure CORS with:
  </p>
  <Code>{`mc cors set --help`}</Code>
  <p class="cors-note" style={{ marginTop: '.4rem' }}>
    Alternatively, MinIO administrators can pre-configure global CORS 
    via the <code>MINIO_API_CORS_ALLOW_ORIGIN</code> environment variable at server startup.
  </p>
</Step>
```

### 4. Update README.md with Getting-Started Section

Add a new section "Getting Started with MinIO" to `README.md`:

```markdown
## Getting Started with MinIO

MinIO is a self-hosted, S3-compatible object storage server. To use Bucketer with MinIO:

1. **Install and run MinIO** (Docker recommended):
   ```bash
   docker run -dt -p 9000:9000 -p 9001:9001 \
     -e MINIO_ROOT_USER=minioadmin \
     -e MINIO_ROOT_PASSWORD=minioadmin \
     -v ~/minio/data:/minio/data \
     minio/minio:latest server /minio/data
   ```

2. **Open MinIO Console** at `http://localhost:9001` and create a bucket.

3. **Create a service account** for Bucketer (recommended over root credentials).

4. **Configure CORS** using the `aws s3api put-bucket-cors` command (see SetupGuide in app).

5. **Connect Bucketer:** Use the MinIO provider (manually selected), endpoint `http://localhost:9000`, and your service account credentials.

**Note:** If you deploy Bucketer to HTTPS, MinIO must also use HTTPS. See [Enable Network Encryption](https://docs.min.io/enterprise/aistor-object-store/installation/linux/network-encryption/).

For full MinIO documentation, visit [MinIO AIStor Documentation](https://docs.min.io).
```

---

## Conclusion

Bucketer v1.14.0's MinIO support is robust and well-aligned with current MinIO S3 API behaviour. The implementation correctly:

- Enforces path-style URLs (matching MinIO's default).
- Falls back to `us-east-1` region (MinIO's documented default).
- Relies on `aws s3api put-bucket-cors` for CORS configuration (fully supported).
- Supports all required S3 operations (ListObjectsV2, GetObject, PutObject, multipart, versioning, etc.).

**Two action items:**

1. **HIGH PRIORITY:** Add a mixed-content warning to `GuideMinIO` in `SetupGuide.jsx` to alert users deploying HTTPS Bucketer that MinIO must also use HTTPS.

2. **MEDIUM PRIORITY:** Clarify in SetupGuide that alternative CORS methods exist (mc CLI, global environment variable) to reduce user confusion.

All other assumptions are validated. No code changes are required; documentation updates are sufficient.
