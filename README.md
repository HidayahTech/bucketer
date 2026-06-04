# Bucketer

[![pipeline status](https://gitlab.com/hidayahtech/bucketer/badges/main/pipeline.svg)](https://gitlab.com/hidayahtech/bucketer/-/commits/main) [![Latest Release](https://gitlab.com/hidayahtech/bucketer/-/badges/release.svg)](https://gitlab.com/hidayahtech/bucketer/-/releases) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

**→ [Try it live](https://bucketer.hidayahtech.net/)** &nbsp;·&nbsp; Canonical repository: [gitlab.com/hidayahtech/bucketer](https://gitlab.com/hidayahtech/bucketer)

### ⚡ No install. No server. No backend. No third-party trust.

Open a URL. Enter your credentials. You're managing your bucket. Close the tab when you're done — nothing lingers, nothing persists on a server you didn't ask for. There's no installation, no Docker container, no daemon to keep running. Just a URL.

---

### 🔒 The only thing you have to trust is your browser.

There's no Bucketer backend. The webpage IS the app. The host serving it only knows you loaded it, and nothing else. It cannot observe which provider you're connecting to, which bucket you're in, or what credentials you used. Your secret key lives only in `sessionStorage` and is cleared when you close the tab. Every S3 request goes directly from your browser to your storage endpoint, signed in-browser with SigV4, over TLS.

You already trust your browser. That's all Bucketer requires.

---

### 📄 One file. Runs anywhere a browser runs.

The entire application — logic, styles, AWS SDK — ships as a single self-contained HTML file. Copy it to nginx. Drop it into the bucket you're managing. Deploy it to Cloudflare Pages, GitHub Pages, or a corporate intranet with no internet access. Open it directly as `file://` in Firefox. No build step on the server. No CDN calls at runtime. No external scripts fetched from anywhere.

The file in the repository is the file that runs in your browser. You can audit it. You can build it yourself. What you deploy is exactly what you get.

---

### 🔄 Multipart upload resume — without a backend.

Drop a 20 GB file. Your network drops. Your browser crashes. You close the tab by accident.

Re-open the app. Re-add the file.

Bucketer calls `ListParts` to ask your storage provider what was actually received, verifies the file by content hash, and continues uploading from the last confirmed part. No server. No daemon. No resume database to run. IndexedDB holds the session state across restarts, and the provider is the authoritative source on what landed.

---

### 🌐 Built for every S3-compatible API. Not just AWS.

The AWS Console only works for AWS. Most third-party tools treat non-AWS providers as an afterthought. When MinIO stripped the management console from its community edition in 2025, users running self-hosted S3-compatible storage — MinIO, Garage, Ceph, SeaweedFS — were left without a web UI.

Bucketer treats every S3-compatible API as first-class: Backblaze B2, Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, MinIO, and any generic endpoint. It auto-detects your provider from the endpoint URL and encodes per-provider differences where they actually matter — path-style vs. virtual-hosted routing, multipart session lifetimes, CORS setup, region handling. It even adjusts listing defaults based on billing: B2 charges per `ListObjects` call, so Bucketer pages at 200 results instead of 1000. No surprise bills.

It's open source under AGPLv3. No console removal. No bait and switch.

---

**This is Bucketer** — an in-browser S3-compatible bucket manager. Not five tools. One.

---

Every S3 GUI tool asks you to make a trade. Desktop clients require installation and don't travel with you. SaaS browser tools skip the install but route your credentials through servers you don't control. Self-hosted web UIs solve the credential trust problem by asking you to run and maintain a backend. Something always gives.

Bucketer doesn't make you choose.

It runs entirely in the browser — no installation, no backend, no server to maintain. The whole application ships as a single self-contained HTML file you can serve from anywhere: nginx, Cloudflare Pages, a corporate intranet, the bucket you're actually browsing, or directly as `file://`. Your secret key never leaves your browser except as a SigV4 signature on requests sent over TLS directly to your storage endpoint. Close the tab; the credentials are gone.

It's not minimal because of the constraints. Bucketer handles multipart uploads for files of any size, with cross-session resume via IndexedDB — the provider is asked what actually landed, a content hash confirms you have the right file, and the upload continues without a server to hold state between retries. It works first-class against Backblaze B2, Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, MinIO, and any S3-compatible API, with per-provider behavior encoded where it matters: routing, CORS requirements, multipart lifetimes, even billing (B2's listing costs are per-call; the default page size is 200 so you notice before you overspend). It manages versioned buckets, surfaces delete markers, and lets you undelete files. It shares state as deep-linkable URLs with parameters in the hash fragment so they never appear in server access logs.

The entire app is one auditable file. No runtime CDN calls. No external scripts. What's in the repository is what runs in your browser.

---

## A note from the author

*Crafted with ❤️ and [Claude Code](https://claude.ai/code) by Basil Mohamed Gohar @ [HidayahTech](https://hidayahtech.com).*

I designed and implemented this over the course of a few weeks to solve a real problem I had and to be my first real deep dive into GenAI-assisted software development. At the time of this writing, I've been a software developer for over 20 years, but this is the first time I've used GenAI from start to finish in a complete application with real usability beyond my specific needs. I am grateful to say it's already found use by some people, so I decided to release it under the AGPL-3.0 license for others to benefit from it as well. I sincerely hope you find it useful or, at the very least, interesting. If you did, I'd welcome your honest, constructive feedback and I'll do my best to take it into consideration.

---

🇵🇸 **Free Palestine! End the Genocide and Occupation!** 🇵🇸

As more and more brands are implicated in genocide and other massive ethics violations, I felt that any effort, even if little more than a "drop in the bucket" (haaaaa...), was worth it, if for nothing else but my own soul's well-being. Further among my goals in writing this is that, in an era where more and more agency is being taken away from individuals, privacy is bought and sold like a commodity, and technology companies grow ever more hostile, I wanted to provide a tool that, while not by itself completely eliminating a reliance on big tech providers, gives the user back some agency.

---

## Security model

Bucketer has no backend. The only network requests it makes are to your S3 endpoint and a same-origin poll to detect when a new build is available — there is no Bucketer-controlled server, no analytics, and no telemetry. The update poll requests the app's own URL (`window.location`), never a third-party host; it stops as soon as a new build is detected.

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

`dist/index.html` is committed to the repo — the built file is tracked so the canonical hosted copy can be audited against the source without requiring a local build.

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

        # Because all JS and CSS are inlined, 'unsafe-inline' is required for script-src and style-src.
        # A future hash-based approach (script-src 'sha256-<hash>') would remove the need for 'unsafe-inline'.
        # img-src/media-src/frame-src need https: because presigned preview URLs are https: (not data: URIs).
        # Tighten connect-src to only the providers you use, or use https: for any endpoint.
        add_header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; media-src https:; frame-src https:; connect-src https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com https://*.amazonaws.com https://*.digitaloceanspaces.com https:;" always;
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
    # Because all JS and CSS are inlined, 'unsafe-inline' is required for script-src and style-src.
    # img-src/media-src/frame-src need https: because presigned preview URLs are https: (not data: URIs).
    # Tighten connect-src to only the providers you use, or use https: for any endpoint.
    header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; media-src https:; frame-src https:; connect-src https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com https://*.amazonaws.com https://*.digitaloceanspaces.com https:;"
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

---

## License

Copyright (C) 2026 HidayahTech, LLC

Licensed under the [GNU Affero General Public License v3.0](LICENSE).
