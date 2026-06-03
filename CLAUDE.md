# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Workflow

Always ask for confirmation before committing or pushing.

**Tests must pass before every push.** The pre-push git hook enforces this automatically — it runs `npm run build` then `npm test`, and aborts the push if either fails. The only override is `git push --no-verify`, which must only be used by the human operator in genuine emergencies. Never use `--no-verify` to work around a failing test; fix the test or the code instead.

**Version tags are created and pushed automatically.** After every version bump commit, the pre-push hook creates an annotated tag for the current `package.json` version if one does not already exist, then immediately pushes it to the remote. No manual `git tag` or `git push --tags` is needed. Every version bump that reaches the remote will have a corresponding tag. The hook detects recursive tag-only pushes (its own inner push) via stdin and skips the build/test cycle for those to avoid redundant work.

`@anthropic-ai/claude-code` is not a project dependency and must never appear in `package.json`, `package-lock.json`, or any commit. It is installed separately in `.tools/` (gitignored). See **Claude Code Setup** below.

## Build Invariants

These are structural guarantees about the build output that `build.mjs` enforces automatically on every build. If any invariant fails, the build exits with a non-zero code and must be corrected before the output is used.

**Current invariants:**

- **Update-check metadata within range boundary**: The `build-id` and `app-version` meta tags in `dist/index.html` must both end before byte `UPDATE_CHECK_RANGE_BYTES` (currently 512). `UpdateBanner` uses a `Range: bytes=0-(UPDATE_CHECK_RANGE_BYTES-1)` request as a fallback path to extract the version without fetching the full page. If a structural change pushes these tags past the boundary, the build fails with a clear message. To fix: move the tags earlier in `<head>`, or increase the constant in both `build.mjs` and `UpdateBanner.jsx` (they must be kept in sync).

- **CHANGELOG.md top entry matches package.json version**: `CHANGELOG.md` is the single source of truth for version history. Before bundling, `build.mjs` parses it and fails if the top entry's version does not match the `version` field in `package.json`. To fix: add a `## [x.y.z] — date — Title` entry to the top of `CHANGELOG.md` that matches the new version. `src/lib/changelog.js` is **generated** by this step — never edit it directly.

When adding new invariants, implement them as assertions in `build.mjs` and document them here.

## Bug Tracking and Test Cases

Whenever a real bug is encountered and fixed, it must be logged in `BUG-LOG.md` before closing out the work. Each entry should capture:

- **Symptom** — what the user or developer observed
- **Root cause** — the precise technical reason it happened
- **Fix** — what changed
- **Why it wasn't caught earlier** — what made it hard to see in advance
- **Test case** — the specific assertion or scenario that would mechanically prevent a recurrence

Real bugs are the highest-value source of test cases. A test derived from a bug that actually happened is worth more than a speculative edge case, because it documents a failure mode the project has already encountered. When writing tests, consult `BUG-LOG.md` first and ensure every entry has corresponding test coverage.

## Test Suite

Tests live in `test/` and run with `node --test` (no framework). The suite has two layers:

**Unit tests — pure Node, no build step needed:**
- `format.test.js` — `formatBytes`, `formatSpeed`, `formatEta`, `leafName`, `parseS3Error`, `isPermissionError`
- `media.test.js` — `mediaKind`, `mimeKind`, `mimeType`
- `provider.test.js` — `detectProvider`, `extractRegion`, `requiresPathStyle`, `defaultMaxKeys`, `needsCorsConfig`
- `upload-queue.test.js` — `UploadQueue` concurrency, clear, error handling
- `calc-part-size.test.js` — `calcPartSize` (S3 5 MB floor, 10,000-part ceiling)
- `collect-parts.test.js` — `collectParts` pagination (BUG-007); uses mock S3 client
- `url-params.test.js` — `buildShareUrl`, `readUrlParams`, `hasUrlParams`, `pushPrefixHistory`; uses `global.window` mock
- `indexeddb-pure.test.js` — `buildFileIdentity`, `fileIdentityMatches`, `uploadExpiryWarningMs`, tab-conflict functions; uses `global.localStorage` mock
- `indexeddb-storage.test.js` — `saveResumeRecord`/`loadResumeRecord`/`deleteResumeRecord`, `computeFileHash`, `buildFileIdentityWithHash`, upload log; uses `fake-indexeddb`
- `storage.test.js` — all credential and settings functions; uses `global.localStorage`/`global.sessionStorage` mocks
- `file-entries.test.js` — `collectFileEntries` traversal and >100-file pagination; uses a pure-JS FileSystemEntry mock
- `s3-client.test.js` — `createS3Client` region resolution and `forcePathStyle`
- `cors-config.test.js` — `corsJson` structure, AllowedMethods (BUG-012), required SDK headers
- `credential-form-validation.test.js` — `credentialErrors` for bucket, keyId, secretKey, regionOverride (BUG-016)

**Source-level structural assertions — no build step needed:**
- `source-invariants.test.js` — SetupGuide buttons have explicit type (BUG-006), App.jsx hook imports (BUG-014), selectedProfileId declared before credentials (BUG-017)

**Build output assertions — require `npm run build` first:**
- `build.test.js` — placeholder replacement (BUG-001), Preact JSX transform (BUG-002), version consistency, CORS DELETE (BUG-012), single-bundle structure

**Adding new tests:** Write `test/<name>.test.js`. The test command (`node --test test/*.test.js`) picks it up automatically. For browser globals, set `global.<name>` before the module import. For IndexedDB, use `fake-indexeddb`.

## Setup

```bash
npm install     # also configures the pre-push git hook automatically
npm run build   # → dist/index.html
npm run serve   # dev build + localhost:3000
npm test        # run test suite
```

## Claude Code Setup

Claude Code is kept out of the main project dependencies to avoid polluting `package.json` and `package-lock.json`. It lives in a gitignored `.tools/` directory that each developer sets up locally after cloning.

**First-time setup after cloning:**

```bash
mkdir .tools
cd .tools
npm init -y
npm install @anthropic-ai/claude-code
cd ..
```

**Invoke Claude Code from the project root:**

```bash
.tools/node_modules/.bin/claude
```

**Why `.tools/` and not a global install:**

A global install makes `claude` available everywhere on the system. Keeping it in `.tools/` means it is only accessible when you are working in this project, which limits its reach to the intended directory. For stronger enforcement, wrap the invocation with Bubblewrap — see the Bubblewrap section in any session notes or ask Claude to walk you through it.
