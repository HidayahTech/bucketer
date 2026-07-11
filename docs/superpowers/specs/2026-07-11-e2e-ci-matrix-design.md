# Complete e2e testing in GitLab CI (cross-engine + mobile matrix) — Design

**Date:** 2026-07-11
**Type:** Test / CI infrastructure (no app-behavior change → ships as a chore, no version bump)
**Status:** Approved (brainstorming) — pending implementation plan

## Motivation

Bucketer already has a browser e2e suite (Playwright driving the built app against an in-repo
stateful mock S3) and a single CI `e2e` job on `mcr.microsoft.com/playwright:v1.60.0-jammy`
that is `allow_failure: true` and effectively runs **Chromium only** (`npm run test:e2e`).

We want **complete** e2e coverage in CI: the full **cross-engine + mobile matrix**
(chromium / firefox / webkit × desktop / Android / iOS). The official Playwright image ships
all three engines with their system deps, so WebKit — which cannot run on a stock host (see
GitLab #47) — runs cleanly in CI.

## Reference pattern (from `hidayahsis/.gitlab-ci.yml`)

The proven pattern to adapt (a Laravel/Pest app, but the CI shape maps directly):
- **`parallel: matrix`** to fan one job across a dimension (they templated `PHP_VERSION`; ours
  is `E2E_ENGINE` × `E2E_DEVICE`).
- **`cache`** keyed on the lockfile (`vendor/` → `node_modules/`).
- **`artifacts.reports.junit`** uploaded `when: always` → the MR test-summary widget.
- **`allow_failure` advisory-first**, flipped to blocking once the job has a green track record.
- **`needs` DAG**, `interruptible: true` + auto-cancel of superseded pipelines.

## Decisions (resolved during brainstorming, 2026-07-11)

1. **Matrix breadth: full cross-product** — `E2E_ENGINE: [chromium, firefox, webkit]` ×
   `E2E_DEVICE: ["", "Pixel 5", "iPhone 13"]` = **9 parallel jobs** (desktop + Android + iOS
   per engine).
2. **Diagnostics: JUnit + screenshot-on-failure** — a JUnit report drives the MR summary; a
   failed test captures a page screenshot + the console/pageerror log as artifacts.
3. **Firefox + mobile:** Playwright's `isMobile` is Chromium/WebKit-only — a Firefox context
   with `isMobile: true` errors. The harness strips `isMobile` for Firefox, so firefox-mobile
   runs as a touch-enabled mobile-*viewport* Firefox rather than failing to start.
4. **Pre-push unchanged** — stays Chromium-fast and reliable. The full matrix lives in CI;
   local full-matrix is deferred to the containerized approach (#47).
5. **Ships as a chore** — test/CI-only, nothing in `dist` or app behavior changes, so no
   version bump / CHANGELOG entry.

## Scope

- `test/e2e/harness.mjs` — enhance `newE2EContext`; add `newE2EPage`, `e2eTest`, failure capture.
- `test/e2e/browser/*.test.mjs` (13 files) — route through `launchBrowser`/`newE2EContext`/
  `newE2EPage`/`e2eTest` (only `smoke` + `pdf-preview` are partially converted).
- `test/e2e/run.mjs` — emit a JUnit report when a CI flag is set (keeps the spec reporter too).
- `.gitlab-ci.yml` — replace the single `e2e` job with `e2e-node` + a matrixed `e2e-browser`.
- `package.json` — an npm script for the JUnit-emitting CI run if cleaner than an env flag.

**Out of scope:** the containerized local runner (#47); flipping `allow_failure` to blocking
(a follow-up once the matrix is green); Playwright traces (JUnit + screenshots only, per §2).

## Architecture

### Harness (`test/e2e/harness.mjs`)

Already present: `launchBrowser()` (reads `E2E_ENGINE`), `newE2EContext(browser)` (applies
`E2E_DEVICE`), `e2eEngineName()`, `e2eDeviceName()`.

Add / change:

```js
// newE2EContext: strip isMobile for Firefox (Playwright supports it only in chromium/webkit).
export function newE2EContext(browser, extra = {}) {
  const dev = e2eDeviceName();
  let profile = dev ? devices[dev] : null;
  if (dev && !profile) throw new Error(`Unknown E2E_DEVICE "${dev}"`);
  if (profile && e2eEngineName() === 'firefox' && profile.isMobile) {
    const { isMobile, ...rest } = profile;   // firefox: mobile viewport/touch, no isMobile
    profile = rest;
  }
  return browser.newContext({ ...(profile || {}), ...extra });
}

// newE2EPage: create the page, register it as the "active page" for failure capture, and
// attach console/pageerror loggers whose output is dumped alongside a screenshot on failure.
export async function newE2EPage(context) { /* creates page, registers active, attaches logs */ }

// e2eTest: node:test has no per-test failure hook, so wrap test() — on a thrown assertion,
// screenshot the active page + write the captured console log to the artifacts dir, then
// re-throw so the failure still propagates.
export function e2eTest(name, fn) {
  test(name, async (t) => {
    try { await fn(t); }
    catch (err) { await captureFailure(name); throw err; }
  });
}
```

- Failure artifacts go to `test/e2e/artifacts/` (git-ignored), named by test + `E2E_ENGINE` +
  `E2E_DEVICE` so parallel-matrix jobs do not collide within a job. CI collects the directory.
- `newE2EPage` records the active page so `e2eTest` can screenshot it without threading `page`
  through every call.

### Spec conversion (13 `browser/*.test.mjs`)

Each spec's `before` uses `launchBrowser()` + `newE2EContext(browser)` + `newE2EPage(context)`
(replacing `chromium.launch()` / `browser.newContext()` / `context.newPage()`), and each
`test(...)` becomes `e2eTest(...)`. No test logic changes — only the setup + the test wrapper.
`issue-3-mobile.test.mjs` (already uses `devices['Pixel 5']` directly) moves to the same
`E2E_DEVICE`-driven path.

### Runner (`test/e2e/run.mjs`)

Already accepts a layer arg (`node` | `browser` | `all`) and builds to `perf/`. Add: when
`E2E_JUNIT=1` (set by CI), append `--test-reporter spec --test-reporter-destination stdout
--test-reporter junit --test-reporter-destination junit-e2e.xml` to the `node --test` invocation
so each job emits a JUnit file. `E2E_ENGINE`/`E2E_DEVICE` are read by the harness — the runner
just passes the environment through.

### CI (`.gitlab-ci.yml`)

Replace the single `e2e` job with:

```yaml
e2e-node:
  stage: test
  image: mcr.microsoft.com/playwright:v1.60.0-jammy
  allow_failure: true
  rules:
    - if: '$RELOCK_MIRROR == "true"'
      when: never
    - when: on_success
  cache:
    key: { files: [package-lock.json] }
    paths: [node_modules/]
  variables: { E2E_JUNIT: "1" }
  script:
    - npm ci
    - npm run test:e2e node
  artifacts:
    when: always
    reports: { junit: junit-e2e.xml }
    expire_in: 1 week

e2e-browser:
  stage: test
  image: mcr.microsoft.com/playwright:v1.60.0-jammy
  allow_failure: true
  interruptible: true
  rules:
    - if: '$RELOCK_MIRROR == "true"'
      when: never
    - when: on_success
  parallel:
    matrix:
      - E2E_ENGINE: [chromium, firefox, webkit]
        E2E_DEVICE: ["", "Pixel 5", "iPhone 13"]
  cache:
    key: { files: [package-lock.json] }
    paths: [node_modules/]
  variables: { E2E_JUNIT: "1" }
  script:
    - npm ci
    - npm run test:e2e browser
  artifacts:
    when: always
    reports: { junit: junit-e2e.xml }
    paths: [test/e2e/artifacts/]
    expire_in: 1 week
```

- 9 `e2e-browser` jobs (the matrix) + 1 `e2e-node`. `E2E_DEVICE: ""` = desktop.
- Mock S3 + app server boot in-process (via the harness), so **no `services:`** are needed.
- `allow_failure: true` stays until the matrix is green across a few pipelines, then flips to
  blocking (a one-line follow-up).

## Data flow

GitLab `parallel: matrix` → N jobs, each with `E2E_ENGINE`/`E2E_DEVICE` in the environment →
`npm run test:e2e browser` → `run.mjs` builds `perf/` and runs the browser specs → each spec's
`before` calls `launchBrowser()` (selects the engine) + `newE2EContext()` (device profile,
firefox-isMobile-stripped) + `newE2EPage()` → `e2eTest` runs each test, capturing a
screenshot + console log to `test/e2e/artifacts/` on failure → `run.mjs` emits `junit-e2e.xml`
→ GitLab aggregates JUnit across jobs (MR summary) and stores the artifacts.

## Error / edge handling

- **Firefox + mobile device** → `isMobile` stripped by `newE2EContext` (runs, does not error).
- **WebKit** → runs in CI (image ships deps); locally it is skipped/absent (out of scope; #47).
- **Flakiness** → `allow_failure: true` keeps the matrix advisory in CI while it is hardened;
  it never blocks an MR until promoted. Pre-push is unaffected (Chromium only).
- **JUnit filename collisions** → each matrix job is its own container/runner, so a fixed
  `junit-e2e.xml` per job is safe; GitLab aggregates them.
- **Artifact naming** → failure captures include engine + device in the filename so a single
  job's artifacts do not overwrite across tests.
- **Unknown `E2E_DEVICE`** → `newE2EContext` throws a clear error (guards a typo in the matrix).

## Testing

This is test infrastructure; its own execution is the verification:
- Locally: `E2E_ENGINE=chromium npm run test:e2e browser` and `E2E_ENGINE=firefox …` both pass
  the full converted suite; `E2E_DEVICE="Pixel 5"` (chromium) runs a mobile profile. WebKit is
  skipped locally (host deps).
- A deliberately-failing scratch test confirms `e2eTest` writes a screenshot + console log to
  `test/e2e/artifacts/` and still fails the run (then removed).
- CI: the first pipeline shows 9 `e2e-browser` jobs + `e2e-node`, a populated MR test-summary
  from the JUnit reports, and failure artifacts when a job fails.

## Versioning

Chore — no `package.json` bump, no `CHANGELOG` entry, no `dist` change (test/CI files only).
Commits land on a branch and merge to `main`; the pre-push hook still runs build + unit +
Chromium e2e. Follow-up (separate): flip `allow_failure` to blocking once the matrix is green.
