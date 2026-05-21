# S3 Browser

A browser-based tool for uploading and downloading objects in an S3-compatible bucket. No backend — runs entirely in the browser. Primary target is Backblaze B2; also supports Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, and generic S3-compatible endpoints.

See `s3-browser-spec-v0.15.md` for the full specification.

---

## Build

```bash
npm install
npm run build      # → dist/index.html (minified, self-contained)
npm run dev        # → dist/index.html (source maps, unminified)
```

The output is a single self-contained `dist/index.html` with all JS and CSS inlined. This works when opened as a `file://` URL in Firefox or Chrome (with caveats — see the in-app banner) and when served from any web server.

---

## Deployment

### Self-hosted (recommended)

Serve `dist/index.html` from a web server on a dedicated domain, e.g. `https://s3browser.yourdomain.com`.

Configure your bucket's CORS rules to allow that origin (see below).

#### nginx example

```nginx
location / {
    root /var/www/s3browser;
    index index.html;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com;" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
}
```

**`connect-src` note:** If you need to support arbitrary S3 endpoints (MinIO, custom domains), replace the specific origins with `https:`.

### Local file

Open `dist/index.html` directly in Firefox. Chrome works but has a shared null-origin `localStorage` namespace (all local HTML files share the same storage). The app shows a banner with per-browser caveats when running from `file://`.

---

## CORS Configuration

The app cannot function without CORS configured on the bucket. This is a provider-side prerequisite.

### Backblaze B2

```bash
aws s3api put-bucket-cors \
  --endpoint-url https://s3.<region>.backblazeb2.com \
  --bucket <your-bucket> \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedOrigins": ["https://s3browser.yourdomain.com"],
      "AllowedMethods": ["GET","PUT","HEAD","POST"],
      "AllowedHeaders": ["Authorization","Content-Type","Content-MD5","x-amz-*","ETag"],
      "ExposeHeaders": ["ETag","Content-Length","Content-Type"],
      "MaxAgeSeconds": 3600
    }]
  }'
```

**B2 notes:**
- `MaxAgeSeconds` must be ≤ 86400 (B2 enforces this).
- Do not use the master application key — create a dedicated application key.
- If you get "bucket contains B2 Native CORS rules", remove the native rules with the B2 CLI first.

### Cloudflare R2

```bash
aws s3api put-bucket-cors \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  --bucket <your-bucket> \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedOrigins": ["https://s3browser.yourdomain.com"],
      "AllowedMethods": ["GET","PUT","HEAD","POST"],
      "AllowedHeaders": ["Authorization","Content-Type","Content-MD5","x-amz-*","ETag"],
      "ExposeHeaders": ["ETag","Content-Length","Content-Type"],
      "MaxAgeSeconds": 3600
    }]
  }'
```

### Wasabi

No CORS configuration needed. Wasabi returns permissive CORS headers automatically.

### AWS S3

Use the AWS console or CLI with your bucket's origin. Standard S3 CORS configuration applies.

---

## Usage

1. Open the app and enter your bucket credentials.
2. **Endpoint URL** — the S3-compatible endpoint for your provider (e.g. `https://s3.us-west-004.backblazeb2.com`).
3. **Bucket Name** — the bucket to browse.
4. **Key ID / Secret Key** — your access credentials. The secret key is stored in `sessionStorage` only and cleared when you close the tab.
4. Click **Connect**. The app will run a `ListObjectsV2` probe to verify access.

### Provider override

If auto-detection fails (MinIO, custom domains, reverse proxies), select your provider from the override dropdown. This controls `forcePathStyle` and region handling.

### Resumable uploads

Multipart uploads (≥ 5 MB) automatically save a resume record in IndexedDB. If the upload is interrupted:
1. Re-add the same file via the upload area.
2. The app detects the existing resume record and offers **Resume** or **Restart**.
3. Resume re-selects the file picker — the browser requires this because file handles don't persist across sessions.
4. The app calls `ListParts` against the provider to get the authoritative list of uploaded parts, then continues from where it left off.

---

## Credential Security

- Secret key uses `type="password"` input — masked and excluded from browser history.
- Secret key is stored only in `sessionStorage` — cleared on tab close.
- Key ID, endpoint, and bucket are stored in `localStorage` (not sensitive).
- All credentials are cleared on Disconnect.
- Use bucket-scoped keys with minimum required permissions. Read-only access if you only need to browse and download.

---

## Known limitations (v0.1)

- No delete, rename, copy, or bucket management.
- No automatic retry with backoff (manual retry available).
- No multiple saved credential profiles.
- MinIO requires manual provider override (endpoint pattern is user-defined).
- Large file uploads (>50 GB) work but native tools (`rclone`, B2 CLI, AWS CLI) are more reliable for very large files.
- Browser tab close during multipart upload leaves orphaned parts on B2 (not R2 — R2 auto-cleans after 7 days).
