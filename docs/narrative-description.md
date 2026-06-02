<!-- Narrative description of Bucketer — plain language, no structural tricks.
     Good for About pages, project descriptions, documentation intros, etc.
     Written 2026-06-02. -->

Every S3 GUI tool asks you to make a trade. Desktop clients require installation and don't travel with you. SaaS browser tools skip the install but route your credentials through servers you don't control. Self-hosted web UIs solve the credential trust problem by asking you to run and maintain a backend. Something always gives.

Bucketer doesn't make you choose.

It runs entirely in the browser — no installation, no backend, no server to maintain. The whole application ships as a single self-contained HTML file you can serve from anywhere: nginx, Cloudflare Pages, a corporate intranet, the bucket you're actually browsing, or directly as `file://`. Your secret key never leaves your browser except as a SigV4 signature on requests sent over TLS directly to your storage endpoint. Close the tab; the credentials are gone.

It's not minimal because of the constraints. Bucketer handles multipart uploads for files of any size, with cross-session resume via IndexedDB — the provider is asked what actually landed, a content hash confirms you have the right file, and the upload continues without a server to hold state between retries. It works first-class against Backblaze B2, Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, MinIO, and any S3-compatible API, with per-provider behavior encoded where it matters: routing, CORS requirements, multipart lifetimes, even billing (B2's listing costs are per-call; the default page size is 200 so you notice before you overspend). It manages versioned buckets, surfaces delete markers, and lets you undelete files. It shares state as deep-linkable URLs with parameters in the hash fragment so they never appear in server access logs.

The entire app is one auditable file. No runtime CDN calls. No external scripts. What's in the repository is what runs in your browser.
