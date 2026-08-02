# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Workflow

Always ask for confirmation before committing or pushing.

**Tests must pass before every push.** The pre-push git hook enforces this automatically — it runs `npm run build` then `npm test`, and aborts the push if either fails. The only override is `git push --no-verify`, which must only be used by the human operator in genuine emergencies. Never use `--no-verify` to work around a failing test; fix the test or the code instead.

**Version tags are created and pushed automatically.** After every version bump commit, the pre-push hook creates an annotated tag for the current `package.json` version if one does not already exist, then immediately pushes it to the remote. No manual `git tag` or `git push --tags` is needed. Every version bump that reaches the remote will have a corresponding tag. The hook detects recursive tag-only pushes (its own inner push) via stdin and skips the build/test cycle for those to avoid redundant work.

**Bump the version with `npm version <x.y.z> --no-git-tag-version`,** not by hand-editing `package.json`. `package-lock.json` records the root version in two places and only npm keeps them current; a hand-edit leaves both behind, and nothing complains — `npm ci` validates the lock against `package.json`'s *dependency ranges*, never its version. That drift ran silently for 13 releases (frozen at 1.37.5 while shipping 1.43.0). `--no-git-tag-version` is correct here because the pre-push hook owns tagging (below).

A guard test enforces it: `test/source-invariants.test.js` → "package-lock.json tracks package.json" fails if either lock version field diverges, and its message names the command to fix it. It is a test rather than a build invariant deliberately — the lock's version never reaches build output, so it does not belong in the list under **Build Invariants**; the nearest precedent is the `.gitlab-ci.yml` ↔ locked-playwright lockstep test. Both run in the pre-push hook regardless.

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

Two further rules, from the 2026-07-31 postmortem:

- **Sideways verification.** A fix names the behaviors it could plausibly break — always
  including the behavior the changed code exists to provide — and cites a spec run for
  each. (The v1.43.0 iframe fix proved navigation stopped and never proved downloads
  survived; they hadn't.) The output is a list of spec runs, not an essay.
- **Harness fidelity.** When a feature depends on an environment property (a CSP
  directive, transport scheme, storage class, a picker API), state in the commit message
  whether the harness represents it. If not, write "no e2e coverage: harness cannot
  represent X" — never let a green matrix imply coverage it does not have.

## Test Suite

Tests live in `test/` and run with `node --test` (no framework). The suite has two layers:

**Unit tests — pure Node, no build step needed:**
- `format.test.js` — `formatBytes`, `formatSpeed`, `formatEta`, `leafName`, `parseS3Error`, `isPermissionError`, `isBlockedByExtension` (BUG-025)
- `media.test.js` — `mediaKind`, `mimeKind`, `mimeType`
- `provider.test.js` — `detectProvider`, `extractRegion`, `requiresPathStyle`, `defaultMaxKeys`, `needsCorsConfig`, `buildEndpoint`
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
- `source-invariants.test.js` — SetupGuide buttons have explicit type (BUG-006), App.jsx hook imports (BUG-014), selectedProfileId declared before credentials (BUG-017), UploadLog MAX_DISPLAY cap (BUG-021)

**Build output assertions — require `npm run build` first:**
- `build.test.js` — placeholder replacement (BUG-001), Preact JSX transform (BUG-002), version consistency, CORS DELETE (BUG-012), single-bundle structure

**Component rendering tests — require `npm run test:ui`, NOT `npm test`:**

Component tests live in `test/components/` and are `.jsx` files. They use jsdom (a browser DOM emulator) and `preact/test-utils` to render components and assert on their output.

- `test/components/about-modal.test.jsx` — AboutModal content and all three close mechanisms
- `test/components/app.test.jsx` — App disconnected state rendering
- `test/components/browser-internals.test.jsx` — Breadcrumb, SortTh sub-components
- `test/components/capability-panel.test.jsx` — CapabilityPanel permitted/denied/unknown/mixed states
- `test/components/changelog-modal.test.jsx` — ChangelogModal content and close mechanisms
- `test/components/credential-form.test.jsx` — CredentialForm fields, validation, provider auto-detection, submission
- `test/components/delete-queue.test.jsx` — DeleteQueue confirm dialog titles, versioning caveats, interactions
- `test/components/error-block.test.jsx` — ErrorBlock renders, CORS heuristic, S3 error metadata
- `test/components/file-banner.test.jsx` — FileBanner protocol detection
- `test/components/hidden-versions.test.jsx` — HiddenVersions R2 gate and initial state
- `test/components/modal.test.jsx` — Modal overlay/dialog classes, onClose, stopPropagation
- `test/components/multipart-failure-consequence.test.jsx` — provider-specific multipart error messages (R2, B2, generic)
- `test/components/profile-picker.test.jsx` — ProfilePicker empty state, list, selection, delete, save form
- `test/components/settings-panel.test.jsx` — SettingsPanel fields, validation, update check toggle
- `test/components/setup-guide.test.jsx` — all 7 provider guides render correctly; Wasabi has no CORS command
- `test/components/storage-modal.test.jsx` — StorageModal structure, close mechanisms, isConnected prop, wipe section
- `test/components/upload-log.test.jsx` — UploadLog empty state
- `test/components/upload-queue-ui.test.jsx` — UploadItem and BatchSummary in all states

**How the component test layer works:**

- `test/helpers/jsx-loader.mjs` — custom Node ESM loader that transforms `.jsx` files using esbuild (same settings as the production build: `jsx: 'automatic'`, `jsxImportSource: 'preact'`). No additional dependencies beyond esbuild.
- `test/helpers/with-dom.js` — sets up jsdom globals (`window`, `document`, `navigator`, etc.) before any component imports. **Must be the first import in every component test file.** ES module imports evaluate in order — placing it first guarantees `global.document` is set before Preact accesses it at render time.
- `test/helpers/render.js` — shared `mount(vnode)` helper (returns `text`, `html`, `query`, `queryAll`, `container`, `cleanup`) and `fire(element, eventName)` / `setInput(element, value)` utilities. Import this instead of writing inline mount logic.

**Adding new component tests:** Write `test/components/<name>.test.jsx`. Start with `import '../helpers/with-dom.js'` as the very first line. Import `{ mount, fire }` from `'../helpers/render.js'`. Run with `npm run test:ui`.

**Adding new unit tests:** Write `test/<name>.test.js`. The test command (`node --test test/*.test.js`) picks it up automatically. For browser globals, set `global.<name>` before the module import. For IndexedDB, use `fake-indexeddb`.

## Setup

```bash
npm install     # also configures the pre-push git hook automatically
npm run build   # → dist/index.html
npm run serve   # dev build + localhost:3000
npm test        # unit + structural + build tests (no browser required)
npm run test:ui # component rendering tests (jsdom — no real browser required)
npm run test:e2e:matrix    # e2e across E2E_ENGINES × E2E_DEVICES ("desktop" = no profile)
npm run test:e2e:container # full 3×3 e2e matrix incl. WebKit, in the Playwright image (Podman/Docker)
```

Run **every** engine through `test:e2e:container`, not just WebKit. WebKit cannot launch on a
stock Fedora host at all, but that is not the only reason: mixing a host browser with a
containerised one makes the lanes non-comparable, and the project has already been bitten by
it. `docs/review-download-parity/README.md` states the rule — "All three engines run in one
container so no engine is special-cased" — and that report's errata lists "mixed native and
containerised execution" as a superseded method whose findings were withdrawn.

So: scope with `E2E_ENGINES` only for an explicitly-labelled control run, never to make a
coverage claim, and record the image tag and browser versions alongside any cross-engine
result. "Passes in three engines" means nothing without saying which builds, in what.

The container image tag derives from the locked playwright version in `package-lock.json`; a
unit test (`test/e2e-matrix-helpers.test.js`) fails if `.gitlab-ci.yml` pins a different
image, so bump the dependency and the CI image together.

### E2E Evidence Rules

Each rule demands an artifact, not prose. They exist because the 2026-07-31 postmortem
found a shipped e2e spec that passed while the feature under test was completely inert
(`docs/postmortem-2026-07-31/`).

- **Baseline first.** Any session that will claim e2e results runs the full container
  matrix once on the untouched tree before changing anything, and records the result. A
  later red lane without a baseline cannot be attributed; a green one proves nothing.
  Docs-only sessions are exempt.
- **One observable per feature.** Before implementing, write down the single
  user-observable that proves the feature works (e.g. "a browser `download` event fires
  per file") and the spec that measures it. Counters, attached DOM nodes, and green suites
  are proxies, not observables. An e2e assertion of absence ("nothing navigated") is valid
  only next to an assertion of presence — a download event (`collectDownloads` in
  `test/e2e/harness.mjs`) or a request in the mock's log (`mock.requestLog`).
- **Matched-pair evidence for fixes.** A bug-fix's spec must be run against the pre-fix
  code (restored from VCS) and shown to FAIL, then against the fix and shown to PASS —
  same lanes, same image. Both runs go in the BUG-LOG entry.

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

## Verification Gate

Blast radius: T-tool
pre-push hook: `.githooks/pre-push` (self-installs via npm `prepare`; cites BUG-035)
build invariant: `build.mjs` (CHANGELOG⇄package.json lockstep, update-check byte boundary)

Per `hidayahtech-knowledge/hidayahtech/repo-baseline.md` §2. The hook is
client-side (bypassable by design); the build invariants and BUG-LOG are the
backstop.
