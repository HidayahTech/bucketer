# Bucketer

A browser-based tool for uploading, downloading, and managing objects in an S3-compatible bucket. No backend — runs entirely in the browser. Primary target is Backblaze B2; also supports Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, MinIO, and generic S3-compatible endpoints.

---

## Security model

Bucketer has no backend. The only network requests it makes are to your S3 endpoint and a same-origin poll to detect when a new build is available — there is no Bucketer-controlled server, no analytics, and no telemetry.

**Trusts:** the browser, the host serving the HTML file, and every library bundled into it. A compromised host or a malicious dependency could read credentials from `sessionStorage`. The `connect-src` CSP in the deployment examples limits where the page can make requests, which constrains what a malicious dependency could exfiltrate — deploy with a tightly scoped `connect-src` for the strongest protection.

**Does not trust:** the network. Your secret key never leaves the browser except as an HMAC signature (SigV4) on requests sent directly to your S3 endpoint over TLS.

**Credentials:** the secret key is held in `sessionStorage` only — never written to disk, cleared on tab close. The key ID, endpoint, and bucket name persist in `localStorage` for convenience; these are not sensitive on their own. Use bucket-scoped, least-privilege keys to limit blast radius if credentials are ever exposed.

---

## Build pipeline

### Prerequisites

- Node.js 18+ (ESM required)
- `npm install`

### Scripts

```bash
npm run build   # production build  → dist/index.html
npm run dev     # development build → dist/index.html (source maps, unminified)
npm run serve   # dev build + local HTTP server at http://localhost:3000
```

### How it works

`build.mjs` drives the pipeline:

1. **esbuild** bundles `src/main.jsx` (entry point) and all imports into a single IIFE, tree-shaking unused SDK code. The Preact automatic JSX runtime is used — no `import React` needed in component files.
2. `src/styles/main.css` is read as a string.
3. `src/index.html` (the shell) has its `<!-- BUNDLE_PLACEHOLDER -->` comment replaced with an inline `<style>` block (the CSS) and an inline `<script>` block (the JS bundle).
4. The result is written to `dist/index.html`.

The output is a **single self-contained HTML file** with no external dependencies. This design allows it to be opened directly as a `file://` URL and deployed to any static host without a build step on the server.

`dist/index.html` and `dist/favicon.ico` are committed to the repo — the built file is tracked so the canonical hosted copy can be audited against the source without requiring a local build.

### Source layout

```
src/
  main.jsx              # Preact entry point
  index.html            # HTML shell (contains <!-- BUNDLE_PLACEHOLDER -->)
  styles/main.css       # All styles (inlined at build time)
  components/           # Preact components
  lib/                  # Shared utilities (S3 client, storage, formatting)
build.mjs               # Build script (esbuild + inline)
serve.mjs               # Dev server (builds then serves on localhost:3000)
dist/index.html         # Build output (committed for auditability)
```

---

## Deployment

### Any static host

Copy `dist/index.html` to your server or static hosting provider. No server-side logic is required — the file is entirely self-contained.

```bash
npm run build
scp dist/index.html user@yourserver:/var/www/bucketer/index.html
```

Compatible with: nginx, Apache, Caddy, S3 static hosting, Cloudflare Pages, GitHub Pages, Netlify, and any host that can serve a single HTML file.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name bucketer.yourdomain.com;

    root /var/www/bucketer;
    index index.html;

    location / {
        try_files $uri /index.html;

        # Because all JS and CSS are inlined, 'unsafe-inline' is required.
        # Tighten connect-src to only the providers you use, or use https: for any endpoint.
        add_header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com https://*.amazonaws.com https://*.digitaloceanspaces.com https:;" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
    }
}
```

### Caddy example

```caddy
bucketer.yourdomain.com {
    root * /var/www/bucketer
    file_server
    header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src https:;"
    header X-Content-Type-Options "nosniff"
    header X-Frame-Options "DENY"
    header Referrer-Policy "no-referrer"
}
```

### Local file (no server)

Open `dist/index.html` directly in Firefox. Chrome works but has a shared null-origin `localStorage` namespace (all local HTML files share the same storage). The app shows a dismissable banner with per-browser caveats when running from `file://`.

---

## CORS configuration

The app cannot function without CORS configured on the bucket. The in-app Setup Guide generates the correct command for your provider. The canonical configuration is:

```json
{
  "CORSRules": [{
    "AllowedOrigins": ["https://bucketer.yourdomain.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD", "POST", "DELETE"],
    "AllowedHeaders": ["Authorization", "Content-Type", "Content-MD5", "x-amz-*", "amz-sdk-invocation-id", "amz-sdk-request", "ETag"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }]
}
```

`DELETE` is required for the delete feature. `amz-sdk-invocation-id` and `amz-sdk-request` must be listed explicitly on Backblaze B2 — the `x-amz-*` wildcard does not cover them.

### Applying the rules

#### Backblaze B2

B2 won't apply S3-compatible CORS rules if native rules are set. Clear native rules first:

```bash
b2 bucket update <your-bucket> --cors-rules '[]'
```

Then apply:

```bash
aws s3api put-bucket-cors \
  --profile bucketer \
  --endpoint-url https://s3.<region>.backblazeb2.com \
  --bucket <your-bucket> \
  --cors-configuration file://cors.json
```

Additional B2 notes:
- `MaxAgeSeconds` must be ≤ 86400.
- Use a dedicated application key, not the master key.

#### Cloudflare R2

```bash
aws s3api put-bucket-cors \
  --profile bucketer \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  --bucket <your-bucket> \
  --cors-configuration file://cors.json
```

#### Wasabi

No configuration needed — Wasabi returns permissive CORS headers automatically.

#### AWS S3

```bash
aws s3api put-bucket-cors \
  --profile bucketer \
  --bucket <your-bucket> \
  --cors-configuration file://cors.json
```

---

## Usage

1. Open the app and enter your bucket credentials.
2. **Endpoint URL** — the S3-compatible endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`).
3. **Bucket Name** — the bucket to browse.
4. **Key ID / Secret Key** — your access credentials. The secret key is stored in `sessionStorage` only and cleared when you close the tab.
5. Click **Connect**. The app runs a `ListObjectsV2` probe to verify access and detect permissions.

### Provider override

If auto-detection fails (MinIO, custom domains, reverse proxies), select your provider from the override dropdown. This controls `forcePathStyle` and region handling.

### Resumable uploads

Multipart uploads (≥ 5 MB) save a resume record in IndexedDB. If interrupted:

1. Re-add the same file via the upload area.
2. The app detects the existing record and offers **Resume** or **Restart**.
3. Resume opens the file picker — the browser requires this because file handles don't persist across sessions.
4. The app calls `ListParts` to get the authoritative list of uploaded parts, then continues from where it left off.

### Hidden versions and deleted files

When versioning is enabled on a bucket, deleting a file creates a delete marker rather than removing the content. The **Hidden versions & deleted files** panel (below the file listing) surfaces these using `ListObjectVersions`. Removing a delete marker undeletes the file. Old versions can also be purged individually or in bulk.

---

## Credential security

- Secret key input is `type="password"` — masked and excluded from browser autofill history.
- Secret key is stored only in `sessionStorage` — cleared on tab close.
- Key ID, endpoint, and bucket are stored in `localStorage` (not sensitive).
- All credentials are cleared on Disconnect.
- Use bucket-scoped keys with minimum required permissions. Read-only keys if you only need to browse and download.

---

## Known limitations

- No rename, copy, or bucket management.
- No automatic retry with backoff (manual retry available).
- No multiple saved credential profiles.
- MinIO requires manual provider override (endpoint pattern is user-defined).
- Large uploads (> 50 GB) work but native tools (`rclone`, `b2`, AWS CLI) are more reliable at that scale.
- Browser tab close during a multipart upload leaves orphaned parts on B2 (R2 auto-cleans after 7 days; AWS S3 supports lifecycle rules for incomplete multipart uploads).
