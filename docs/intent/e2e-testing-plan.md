# E2E Testing Plan — Playwright

## Status
**Implemented (v1.26.0+).** Connected-state e2e runs against an in-repo **stateful mock S3
server** — no real credentials, no Docker, no Python. This supersedes the earlier assumption
below that connected flows "require real credentials": a throwaway bucket is no longer needed
for hermetic e2e (it remains an optional fidelity spot-check via `E2E_REAL_ENDPOINT`, not built).

## How it works now
- `test/e2e/mock-s3/server.mjs` — dependency-free stateful S3 server (real MD5 ETags, multipart
  state, copy, versioning, the exact `cors-config.js` CORS contract, fault injection). Strict where
  real S3 is strict (1000-key delete cap, part-size + ETag validation, illegal self-copy).
- `test/e2e/harness.mjs` — boots the mock, builds an S3 client via the app's own `createS3Client`,
  serves the built `dist/index.html`, and connects the UI.
- `test/e2e/node/*` — runs the real lib orchestrators (`runMoveOperation`, `runDeleteOperation`,
  `copyObjectMultipart`, …) over HTTP and asserts actual bucket state.
- `test/e2e/browser/*` — `node --test` + the `playwright` library drives the built app through
  full flows, asserting DOM **and** mock bucket state.
- Run: `npm run test:e2e` (build + node + browser), `:node` / `:browser` for a single layer.
  CI: a non-blocking `e2e` job (Playwright image). Not part of the pre-push gate.

### Fidelity note
The mock and moto cover the same tier (real `@aws-sdk`-over-HTTP wiring); neither models non-AWS
provider quirks (B2 5 GiB copy cap, R2 no-versioning, Wasabi retention, AWS checksums) — those stay
as `provider.js`/`provider-checksum.js` unit tests, the per-provider review docs, and manual UAT.

## Available Infrastructure

Playwright v1.60 is installed globally. All three browser engines are cached and ready:
- Chromium 148 (`~/.cache/ms-playwright/chromium-1223`)
- Firefox (`~/.cache/ms-playwright/firefox-1327`)
- WebKit (`~/.cache/ms-playwright/webkit-1668`)

No project setup is needed to run ad-hoc scripts against `localhost:3000`.

## What Can Be Tested Without Credentials

All disconnected-screen behavior is fully testable without a real S3 endpoint:

- Form field validation (spaces, length, URL format)
- Paste whitespace trimming
- "Save as profile…" button enabling/disabling as fields are filled
- Profile save, load, delete
- Profile name pre-population from form data
- Form fields retained after profile save (BUG-020 regression)
- Region auto-detection hints (Wasabi, B2, AWS, R2, DO Spaces)
- Wasabi bare endpoint `s3.wasabisys.com` → us-east-1 (BUG-019 regression)
- FileBanner shown when running from `file://`
- FileBanner localhost link present and styled correctly
- Storage & Privacy modal: opens, sections expand, key names visible
- About modal, Changelog modal
- Light/dark theme visual regressions
- Keyboard navigation and tab order

## What Requires Real Credentials

- Connected state: file browser, pagination, prefix navigation
- Upload, download, delete operations
- Capability detection (list/upload/delete permissions)
- Update banner (requires a real server responding to `Range` requests)
- Resume flow (requires real multipart state in IndexedDB)

For connected-state testing, a throwaway test bucket on any provider (B2, R2, Wasabi) with a scoped key would be sufficient.

## Implementation Options

### Option A — Ad-hoc smoke test (quick)
Write and run a one-off Playwright script against `localhost:3000`. Take screenshots at key points, exercise the disconnected flows, report findings. No new files added to the project permanently.

### Option B — Persistent E2E suite (investment)
Add Playwright as a dev dependency. Write `test/e2e/` covering:
- `disconnected.spec.js` — form, profiles, modals, banner
- `connected.spec.js` — requires credentials (skip in CI unless env vars set)

Integrate into the test pipeline or as a separate `npm run test:e2e` command.

### Option C — Both
Run the smoke test first to check current state, then promote the useful cases into a persistent suite.

## Recommended Path

Start with Option A to verify the fixes from the current session (BUG-017 through BUG-020) are working end-to-end. Then evaluate whether Option B is worth the ongoing maintenance cost.
