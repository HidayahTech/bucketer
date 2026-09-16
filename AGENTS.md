# bucketer — agent guide

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs. It ships static output (Forge serves the committed bundle), so it does not include the fleet `ci-templates` image job.

## Workflow

Commit/push confirmation, tests-before-push and `--no-verify`: the global rules. Repo specifics:

- **The pre-push hook** (`.githooks/pre-push`, self-installed by npm `prepare`) runs the advisory gates (dead-code, lint, format — printed, never blocking), then builds and runs the blocking local suite — `npm test` (unit/structural), `npm run test:ui` (component), and the **node** e2e layer (`npm run test:e2e:node`) — aborting the push if any blocking step fails. The **browser** e2e matrix is deferred to CI (as of v1.62.3): the GitLab runner runs the full 3×3 (chromium/firefox/webkit × desktop/mobile), since the host can only launch chromium anyway. So a browser-only regression (e.g. the BUG-035 multipart-completion class) is caught by CI, not pre-push — don't merge a red pipeline.
- **Version tags are created and pushed automatically** (named divergence from the global ask-before-pushing rule: the tag push rides on the version-bump push you already confirmed). After every version bump commit, the pre-push hook creates an annotated tag for the current `package.json` version if one does not already exist, then immediately pushes it to the remote. No manual `git tag` or `git push --tags` is needed. The hook detects recursive tag-only pushes (its own inner push) via stdin and skips the build/test cycle for those.
- **Versioning is the package model** (baseline §3): `package.json` is the canonical source, `CHANGELOG.md` top entry must match (build invariant below). **Bump with `npm version <x.y.z> --no-git-tag-version`,** not by hand-editing `package.json`: `package-lock.json` records the root version in two places and only npm keeps them current; a hand-edit drifted silently for 13 releases (frozen at 1.37.5 while shipping 1.43.0). `--no-git-tag-version` is correct because the hook owns tagging. A guard test enforces it (`test/source-invariants.test.js` → "package-lock.json tracks package.json"); it is a test rather than a build invariant because the lock's version never reaches build output.
- **A version-bump commit must also include the rebuilt `dist/index.html` and `src/lib/changelog.js`.** Both are generated but tracked — Forge deploys the committed bundle, and CI's stale-dist guard fails any push whose committed `dist/index.html` differs from a fresh build of the same source. Run `npm run build` after bumping and commit the regenerated files in the bump commit. (The v1.44.2 bump omitted them; pipeline #220 caught it.)
- `@anthropic-ai/claude-code` is not a project dependency and must never appear in `package.json`, `package-lock.json`, or any commit; it is installed separately in the gitignored `.tools/` — see `docs/claude-code-setup.md`. <!-- agents-lint: ignore -->

## Build Invariants

Per the global rule, structural guarantees are assertions in `build.mjs`; a failing invariant exits non-zero. When adding one, implement it there and list it here.

- **Update-check metadata within range boundary**: The `build-id` and `app-version` meta tags in `dist/index.html` must both end before byte `UPDATE_CHECK_RANGE_BYTES` (currently 512). `UpdateBanner` uses a `Range: bytes=0-(UPDATE_CHECK_RANGE_BYTES-1)` request as a fallback path to extract the version without fetching the full page. To fix: move the tags earlier in `<head>`, or increase the constant in both `build.mjs` and `UpdateBanner.jsx` (they must be kept in sync).
- **CHANGELOG.md top entry matches package.json version**: `CHANGELOG.md` is the single source of truth for version history. Before bundling, `build.mjs` parses it and fails if the top entry's version does not match `package.json`. `src/lib/changelog.js` is **generated** by this step — never edit it directly.

## Bug tracking

BUG-LOG entries and PRFT reports follow the global rules. Two further rules, from the 2026-07-31 postmortem (`docs/postmortem-2026-07-31/`):

- **Sideways verification.** A fix names the behaviors it could plausibly break — always
  including the behavior the changed code exists to provide — and cites a spec run for
  each. (The v1.43.0 iframe fix proved navigation stopped and never proved downloads
  survived; they hadn't.) The output is a list of spec runs, not an essay.
- **Harness fidelity.** When a feature depends on an environment property (a CSP
  directive, transport scheme, storage class, a picker API), state in the commit message
  whether the harness represents it. If not, write "no e2e coverage: harness cannot
  represent X" — never let a green matrix imply coverage it does not have.

## Tests

Layout, layers and conventions: `test/README.md`. **The directory is the
authoritative file list** — before creating a "new" test file, check whether
one already exists for that module (`ls test/ test/components/`) and extend
it; a stale catalog once nearly caused an agent to overwrite an existing test
(2026-08-13). Component tests need `npm run test:ui`, not `npm test`.

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

## Verification Gate

Blast radius: T-tool
pre-push hook: `.githooks/pre-push` (self-installs via npm `prepare`; cites BUG-035)
build invariant: `build.mjs` (CHANGELOG⇄package.json lockstep, update-check byte boundary)

Per `hidayahtech-knowledge/hidayahtech/repo-baseline.md` §2. The hook is
client-side (bypassable by design); the build invariants and BUG-LOG are the
backstop.

## HidayahTech knowledge repo & services

Read `~/dev/hidayahtech-knowledge/AGENTS.md` (its Appendix) before any
cross-repo read, write, service use, or persona spawn. It is the single copy;
nothing from it is restated here.
