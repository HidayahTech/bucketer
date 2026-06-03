# E2E Testing Plan — Playwright

## Status
Deferred. Infrastructure is ready; implementation not yet started.

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
