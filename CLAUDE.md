# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Workflow

Always ask for confirmation before committing or pushing.

Never include `@anthropic-ai/claude-code` in commits or pushes. It is a local development tool only and must never be deployed. If `package.json` or `package-lock.json` show changes to that package, exclude those files from the commit.

## Build Invariants

These are structural guarantees about the build output that `build.mjs` enforces automatically on every build. If any invariant fails, the build exits with a non-zero code and must be corrected before the output is used.

**Current invariants:**

- **Update-check metadata within range boundary**: The `build-id` and `app-version` meta tags in `dist/index.html` must both end before byte `UPDATE_CHECK_RANGE_BYTES` (currently 512). `UpdateBanner` uses a `Range: bytes=0-(UPDATE_CHECK_RANGE_BYTES-1)` request as a fallback path to extract the version without fetching the full page. If a structural change pushes these tags past the boundary, the build fails with a clear message. To fix: move the tags earlier in `<head>`, or increase the constant in both `build.mjs` and `UpdateBanner.jsx` (they must be kept in sync).

When adding new invariants, implement them as assertions in `build.mjs` after the file is written, and document them here.

## Bug Tracking and Test Cases

Whenever a real bug is encountered and fixed, it must be logged in `BUG-LOG.md` before closing out the work. Each entry should capture:

- **Symptom** — what the user or developer observed
- **Root cause** — the precise technical reason it happened
- **Fix** — what changed
- **Why it wasn't caught earlier** — what made it hard to see in advance
- **Test case** — the specific assertion or scenario that would mechanically prevent a recurrence

Real bugs are the highest-value source of test cases. A test derived from a bug that actually happened is worth more than a speculative edge case, because it documents a failure mode the project has already encountered. When writing tests, consult `BUG-LOG.md` first and ensure every entry has corresponding test coverage.

## Setup

```bash
npm install
npm run build   # → dist/index.html
npm run serve   # dev build + localhost:3000
```
