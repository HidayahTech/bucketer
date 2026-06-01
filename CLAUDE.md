# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Workflow

Always ask for confirmation before committing or pushing.

**Tests must pass before every push.** Run `npm test` before pushing. The pre-push git hook enforces this automatically — a push that fails tests is aborted. The only override is `git push --no-verify`, which must only be used by the human operator in genuine emergencies. Never use `--no-verify` to work around a failing test; fix the test or the code instead.

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
