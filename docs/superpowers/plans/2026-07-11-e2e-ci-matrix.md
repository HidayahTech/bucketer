# Complete e2e in GitLab CI (cross-engine + mobile matrix) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the full Playwright e2e suite across chromium/firefox/webkit × desktop/Android/iOS in GitLab CI, following the hidayahsis `parallel:matrix` + cache + JUnit-artifacts + `allow_failure` pattern.

**Architecture:** Parameterize every browser spec through the existing engine/device harness (`launchBrowser`/`newE2EContext`), add a `newE2EPage`/`e2eTest` wrapper that captures a screenshot + console log on failure, emit JUnit from `run.mjs`, and drive the matrix from `.gitlab-ci.yml` (`parallel:matrix` sets `E2E_ENGINE`/`E2E_DEVICE`). The mock S3 + app server boot in-process, so no CI service containers.

**Tech Stack:** Node's built-in test runner (`node --test`, Node ≥20 with the `junit` reporter — verified on the local Node 22 and the `mcr.microsoft.com/playwright:v1.60.0-jammy` image), the `playwright` library (chromium/firefox/webkit + `devices`), GitLab CI.

## Global Constraints

- **No new dependencies.** Use the built-in `node --test --test-reporter junit`.
- **Ships as a chore** — test/CI files only, no `dist`/app-behavior change → **no `package.json` bump, no CHANGELOG entry.**
- **Firefox + mobile:** Playwright's `isMobile` is Chromium/WebKit-only; strip `isMobile` for firefox so firefox-mobile runs (mobile viewport/touch, no `isMobile`) instead of erroring.
- **Matrix:** `E2E_ENGINE: [chromium, firefox, webkit]` × `E2E_DEVICE: ["", "Pixel 5", "iPhone 13"]` = 9 `e2e-browser` jobs; `""` = desktop.
- **Diagnostics:** JUnit report (MR summary) + screenshot + console log on failure, artifacts `when: always`.
- **`allow_failure: true`** on the e2e jobs (advisory-first); flipping to blocking is a separate follow-up.
- **Pre-push unchanged** — the default `npm run test:e2e` (Chromium) still runs in the hook; the matrix is CI-only.
- **Match existing style** (2-space indent; existing `.gitlab-ci.yml` structure: stages `test`/`reproducibility`/`release`).

**Current harness helpers (already present, `test/e2e/harness.mjs`):** `e2eEngineName()`, `e2eDeviceName()`, `launchBrowser(opts?)`, `newE2EContext(browser, extra?)`. Already converted specs: `smoke.test.mjs`, `pdf-preview.test.mjs`.

---

### Task 1: Harness — engine quirks, failure capture, and the `e2eTest` wrapper

**Files:**
- Create: `test/e2e/engine-quirks.mjs` (pure)
- Modify: `test/e2e/harness.mjs` (update `newE2EContext`; add `newE2EPage`, `captureFailure`, `e2eTest`, artifacts dir; import `node:test` + `node:fs`)
- Modify: `.gitignore` (ignore the artifacts dir)
- Test: `test/e2e-harness-helpers.test.js`

**Interfaces:**
- Produces: `applyEngineQuirks(engineName, profile, extra?) → object` (strips `isMobile` for firefox); `newE2EContext(browser, extra?)` (now firefox-aware); `newE2EPage(context) → Promise<Page>` (registers the active page + buffers console/pageerror); `e2eTest(name, fn)` (registers a `node:test` test that, on throw, calls `captureFailure` then re-throws); `captureFailure(basename, page, logs, dir) → Promise<void>` (writes `<dir>/<basename>.log` always + best-effort `<dir>/<basename>.png`).

- [ ] **Step 1: Write the failing tests**

Create `test/e2e-harness-helpers.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEngineQuirks } from './e2e/engine-quirks.mjs';
import { captureFailure } from './e2e/harness.mjs';

describe('applyEngineQuirks', () => {
  const mobile = { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, userAgent: 'ua' };
  test('firefox: strips isMobile (unsupported), keeps viewport/touch/ua', () => {
    const o = applyEngineQuirks('firefox', mobile);
    assert.equal('isMobile' in o, false);
    assert.equal(o.hasTouch, true);
    assert.deepEqual(o.viewport, { width: 393, height: 851 });
  });
  test('chromium/webkit: keep isMobile', () => {
    assert.equal(applyEngineQuirks('chromium', mobile).isMobile, true);
    assert.equal(applyEngineQuirks('webkit', mobile).isMobile, true);
  });
  test('null profile → just the extra overrides', () => {
    assert.deepEqual(applyEngineQuirks('firefox', null, { locale: 'en' }), { locale: 'en' });
  });
  test('extra overrides win', () => {
    assert.equal(applyEngineQuirks('chromium', mobile, { isMobile: false }).isMobile, false);
  });
});

describe('captureFailure', () => {
  test('writes a .log always and a .png when the page screenshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cap-'));
    try {
      const shots = [];
      const page = { async screenshot({ path }) { shots.push(path); writeFileSyncStub(path); } };
      await captureFailure('mytest-chromium', page, ['[console] hi', '[pageerror] boom'], dir);
      assert.ok(existsSync(join(dir, 'mytest-chromium.log')), 'log written');
      assert.match(readFileSync(join(dir, 'mytest-chromium.log'), 'utf8'), /boom/);
      assert.ok(existsSync(join(dir, 'mytest-chromium.png')), 'screenshot written');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a screenshot failure (closed page) does not throw — log still written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cap-'));
    try {
      const page = { async screenshot() { throw new Error('page closed'); } };
      await captureFailure('closed-firefox', page, ['x'], dir);
      assert.ok(existsSync(join(dir, 'closed-firefox.log')), 'log still written');
      assert.equal(existsSync(join(dir, 'closed-firefox.png')), false, 'no screenshot');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { writeFileSync as writeFileSyncStub } from 'node:fs';
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/e2e-harness-helpers.test.js`
Expected: FAIL — `engine-quirks.mjs` and `captureFailure` do not exist yet (import errors).

- [ ] **Step 3: Create the pure module**

Create `test/e2e/engine-quirks.mjs`:

```js
// Copyright (C) 2026 HidayahTech, LLC
// Pure per-engine context-option adjustments (no playwright import so it unit-tests fast).
// Playwright supports `isMobile` only in Chromium/WebKit — a Firefox context with isMobile
// throws — so it is dropped for firefox (the mobile viewport/touch/UA still apply).
export function applyEngineQuirks(engineName, profile, extra = {}) {
  const p = profile ? { ...profile } : {};
  if (engineName === 'firefox' && 'isMobile' in p) delete p.isMobile;
  return { ...p, ...extra };
}
```

- [ ] **Step 4: Extend the harness**

In `test/e2e/harness.mjs`, add these imports near the top (after the existing imports):

```js
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyEngineQuirks } from './engine-quirks.mjs';
```

Replace the existing `newE2EContext` with the firefox-aware version:

```js
export function newE2EContext(browser, extra = {}) {
  const dev = e2eDeviceName();
  const profile = dev ? devices[dev] : null;
  if (dev && !profile) throw new Error(`Unknown E2E_DEVICE "${dev}"`);
  return browser.newContext(applyEngineQuirks(e2eEngineName(), profile, extra));
}

// Re-export so specs that pin their own device (e.g. issue-3-mobile) get the firefox fix too.
export { applyEngineQuirks };
```

Append the failure-capture + wrapper machinery at the end of the file:

```js
// ── Failure capture + e2eTest wrapper ───────────────────────────────────────
// node:test has no per-test "on failure" hook (unlike @playwright/test), so specs run each
// test through e2eTest(): on a thrown assertion it writes the active page's screenshot +
// buffered console log to test/e2e/artifacts/ (git-ignored; CI collects it), then re-throws.
export const ARTIFACTS_DIR = join(ROOT, 'test', 'e2e', 'artifacts');

let _activePage = null;
let _activeLogs = [];

// Create the page, register it as active for failure capture, and buffer console/page errors.
export async function newE2EPage(context) {
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  _activePage = page;
  _activeLogs = logs;
  return page;
}

function slug(name) {
  const dev = e2eDeviceName();
  const suffix = `${e2eEngineName()}${dev ? '-' + dev : ''}`;
  return `${name}-${suffix}`.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
}

// Write the console log (always) + a best-effort screenshot (the page may be closed already
// if a spec closes its context in a finally before the throw propagates here).
export async function captureFailure(basename, page, logs, dir = ARTIFACTS_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename}.log`), (logs || []).join('\n') + '\n');
  try { if (page) await page.screenshot({ path: join(dir, `${basename}.png`), fullPage: true }); }
  catch { /* page closed / screenshot unavailable — the log is enough */ }
}

export function e2eTest(name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      await captureFailure(slug(name), _activePage, _activeLogs);
      throw err;
    }
  });
}
```

- [ ] **Step 5: Ignore the artifacts dir**

In `.gitignore`, add:

```
# e2e failure artifacts (screenshots + console logs)
test/e2e/artifacts/
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/e2e-harness-helpers.test.js`
Expected: PASS (6 tests). Then `npm test` — expected PASS (the new file is picked up by `test/*.test.js`; no regressions).

- [ ] **Step 7: Commit**

```bash
git add test/e2e/engine-quirks.mjs test/e2e/harness.mjs test/e2e-harness-helpers.test.js .gitignore
git commit -m "test(e2e): engine quirks + e2eTest failure-capture harness"
```

---

### Task 2: JUnit output from the e2e runner

**Files:**
- Modify: `test/e2e/run.mjs` (add JUnit reporter flags when `E2E_JUNIT=1`)

**Interfaces:**
- Consumes: nothing new.
- Produces: when `E2E_JUNIT=1`, the run writes `junit-e2e.xml` (and still prints the spec reporter to stdout).

- [ ] **Step 1: Implement**

In `test/e2e/run.mjs`, find the final run line:

```js
  run(['--test', '--test-concurrency=1', ...files]);
```

Replace it with a JUnit-aware invocation:

```js
  // In CI (E2E_JUNIT=1) emit a JUnit report for the MR test-summary widget, while keeping the
  // human-readable spec output on stdout. node:test supports multiple reporters (Node >=20).
  const reporters = process.env.E2E_JUNIT === '1'
    ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
       '--test-reporter=junit', '--test-reporter-destination=junit-e2e.xml']
    : [];
  run(['--test', '--test-concurrency=1', ...reporters, ...files]);
```

- [ ] **Step 2: Verify**

Run: `E2E_JUNIT=1 node test/e2e/run.mjs node`
Expected: the node-integration layer runs; a `junit-e2e.xml` appears in the repo root with `<testsuites>`/`<testcase>` entries. Confirm: `head -3 junit-e2e.xml` shows the XML. Then remove it: `rm -f junit-e2e.xml`.

Run: `node test/e2e/run.mjs node` (without the flag)
Expected: runs normally, **no** `junit-e2e.xml` written.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/run.mjs
git commit -m "test(e2e): emit a JUnit report from run.mjs when E2E_JUNIT=1"
```

---

### Task 3: Convert the remaining browser specs to the harness + `e2eTest`

**Files:**
- Modify: `test/e2e/browser/*.test.mjs` — every file EXCEPT `smoke.test.mjs` and `pdf-preview.test.mjs`:
  `batch`, `cors`, `dnd`, `issue-2-drop-destination`, `issue-3-mobile`, `issue-4-refresh`, `journeys`, `multipart`, `profiles`, `properties`, `versioning`, `folder-rename` (12 files)

**Interfaces:**
- Consumes: `launchBrowser`, `newE2EContext`, `newE2EPage`, `e2eTest`, `applyEngineQuirks` (Task 1).

**The uniform transformation** (apply to each of the 12 files):

1. Import line — remove `chromium` (and `devices`, if present) from the `playwright` import; delete the import entirely if nothing else is used from it. Add the helpers to the harness import. E.g.:
   - `import { chromium } from 'playwright';` → **delete this line.**
   - `import { startMock, startAppServer, connectApp, BUCKET } from '../harness.mjs';` →
     `import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';`
   - `import { test, describe, before, after } from 'node:test';` → `import { describe, before, after } from 'node:test';` (drop `test`).
2. Launch — `browser = await chromium.launch({ headless: true });` → `browser = await launchBrowser();`
3. Context — `await browser.newContext(...)` → `await newE2EContext(browser)` (desktop specs) — keep any per-context `extra` arg by passing it through: `newE2EContext(browser, { ...extra })`.
4. Page — `await context.newPage();` → `await newE2EPage(context);`
5. Tests — every `test('...', async () => { ... })` → `e2eTest('...', async () => { ... })`. (Leave `describe(...)` as-is.)

**Special case — `issue-3-mobile.test.mjs`** (it pins Pixel 5 inside the test; keep that, but make it engine-parameterized and firefox-safe):

- Imports: `import { chromium, devices } from 'playwright';` → `import { devices } from 'playwright';` (keep `devices`; drop `chromium`). Add `launchBrowser, newE2EContext, newE2EPage, e2eTest, applyEngineQuirks, e2eEngineName` to the harness import. Drop `test` from the node:test import.
- `before`: `browser = await chromium.launch({ headless: true });` → `browser = await launchBrowser();`
- In the test body, the pinned Pixel-5 context + page become:
  ```js
  const context = await browser.newContext(applyEngineQuirks(e2eEngineName(), devices['Pixel 5']));
  const page = await newE2EPage(context);
  ```
  (Remove the old `page.on('pageerror', …)` line — `newE2EPage` attaches the logger now.)
- `test('...')` → `e2eTest('...')`.

- [ ] **Step 1: Apply the transformation to all 12 files**

Edit each file per the rules above. Do not change any test logic, selectors, timeouts, or assertions — only the setup wiring, the `test`→`e2eTest` rename, and the imports.

- [ ] **Step 2: Build the app for e2e**

Run: `node build.mjs --mode=perf`
Expected: `Built perf/index.html`.

- [ ] **Step 3: Run the full browser suite under Chromium (must be green — the pre-push gate)**

Run: `node test/e2e/run.mjs browser`
Expected: all browser specs pass (this is what the pre-push hook runs; it must stay green). If a spec fails only because of the conversion (e.g. a missed `newPage`), fix that spec and re-run.

- [ ] **Step 4: Sanity-check another engine + a device profile run**

Run: `E2E_ENGINE=firefox node test/e2e/run.mjs browser`
Expected: runs under Firefox (some timing flakes are acceptable — CI is `allow_failure`; the goal is that specs *execute* under Firefox, not that they are flake-free yet).

Run: `E2E_ENGINE=chromium E2E_DEVICE="Pixel 5" node test/e2e/run.mjs browser`
Expected: runs under a mobile Chromium profile without a context-creation error.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/browser/
git commit -m "test(e2e): route all browser specs through the engine/device harness + e2eTest"
```

---

### Task 4: GitLab CI matrix (`e2e-node` + matrixed `e2e-browser`)

**Files:**
- Modify: `.gitlab-ci.yml` (replace the single `e2e` job)

**Interfaces:** none (CI config).

- [ ] **Step 1: Replace the `e2e` job**

In `.gitlab-ci.yml`, delete the existing `e2e:` job (the one with `image: mcr.microsoft.com/playwright:v1.60.0-jammy`, `allow_failure: true`, `script: npm ci` / `npm run test:e2e`) and insert in its place:

```yaml
# End-to-end tests against the in-repo stateful mock S3. Split into the engine-agnostic
# node-integration layer and a cross-engine + mobile browser matrix. The Playwright image
# ships chromium+firefox+webkit with their deps, so all three run in CI (WebKit cannot run on
# a stock host — see GitLab #47). allow_failure keeps the matrix advisory while it stabilizes;
# flip to required once it has a green track record. JUnit -> MR test summary; screenshots +
# console logs are uploaded on failure.
.e2e-base:
  stage: test
  image: mcr.microsoft.com/playwright:v1.60.0-jammy
  allow_failure: true
  interruptible: true
  rules:
    - if: '$RELOCK_MIRROR == "true"'
      when: never
    - when: on_success
  cache:
    key:
      files: [package-lock.json]
    paths: [node_modules/]
  variables:
    E2E_JUNIT: "1"
  before_script:
    - npm ci
  artifacts:
    when: always
    reports:
      junit: junit-e2e.xml
    expire_in: 1 week

e2e-node:
  extends: .e2e-base
  script:
    - npm run test:e2e node

e2e-browser:
  extends: .e2e-base
  parallel:
    matrix:
      - E2E_ENGINE: [chromium, firefox, webkit]
        E2E_DEVICE: ["", "Pixel 5", "iPhone 13"]
  script:
    - npm run test:e2e browser
  artifacts:
    when: always
    reports:
      junit: junit-e2e.xml
    paths:
      - test/e2e/artifacts/
    expire_in: 1 week
```

- [ ] **Step 2: Validate the YAML**

Run: `node -e "const y=require('fs').readFileSync('.gitlab-ci.yml','utf8'); require('child_process')" 2>/dev/null; python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml')); print('YAML OK')"`
Expected: `YAML OK` (parses cleanly). If `python3`/`yaml` is unavailable, instead run `glab ci lint` if `glab` is authenticated, or visually confirm indentation matches the existing jobs.

- [ ] **Step 3: Confirm the matrix shape**

Read `.gitlab-ci.yml` and verify: `e2e-browser` has `parallel.matrix` producing 9 combinations (3 engines × 3 device values, `""` = desktop), both jobs `extends: .e2e-base`, `allow_failure: true`, and `.e2e-base` is a hidden job (leading dot, not scheduled on its own).

- [ ] **Step 4: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "ci: cross-engine + mobile e2e matrix (e2e-node + matrixed e2e-browser)"
```

---

### Task 5: Local verification + developer docs

**Files:**
- Modify: `README.md` (a short "cross-engine e2e" note near the existing test docs)

**Interfaces:** none.

- [ ] **Step 0: Complete failure-capture coverage (smoke + pdf-preview + issue-3-mobile cleanup)**

`smoke.test.mjs` and `pdf-preview.test.mjs` already use `launchBrowser()`/`newE2EContext()` but predate the failure-capture wrapper, so they lack screenshot-on-failure. Convert both:
- Add `newE2EPage, e2eTest` to their harness import.
- `await context.newPage();` → `await newE2EPage(context);`
- Each `test('...', ...)` → `e2eTest('...', ...)`; drop `test` from their `node:test` import.
- Remove any now-redundant inline `page.on('console'/'pageerror', ...)` (newE2EPage attaches these).

Also remove the now-unused `newE2EContext` import from `issue-3-mobile.test.mjs` (it pins its own Pixel-5 context and does not call `newE2EContext`).

Run `node build.mjs --mode=perf && node test/e2e/run.mjs browser` — must stay green under Chromium (all specs, including the two just converted).

- [ ] **Step 1: Verify a deliberate failure produces artifacts**

Create a throwaway `test/e2e/browser/_scratch-fail.test.mjs`:

```js
import { describe, before, after } from 'node:test';
import { startMock, startAppServer, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';
let ctx, app, browser, page;
before(async () => { ctx = await startMock(); app = await startAppServer(); browser = await launchBrowser(); page = await newE2EPage(await newE2EContext(browser)); });
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });
describe('scratch', () => { e2eTest('intentional failure', async () => { await page.goto(app.url); throw new Error('boom'); }); });
```

Run: `node build.mjs --mode=perf && node --test test/e2e/browser/_scratch-fail.test.mjs`
Expected: the test FAILS, and `test/e2e/artifacts/` now contains `intentional_failure-chromium.log` and `intentional_failure-chromium.png`. Confirm: `ls test/e2e/artifacts/`.

Then delete the scratch test and artifacts: `rm -f test/e2e/browser/_scratch-fail.test.mjs && rm -rf test/e2e/artifacts/`.

- [ ] **Step 2: Full green under the pre-push engine (Chromium)**

Run: `npm run test:e2e`
Expected: node + browser layers pass under Chromium (this is the pre-push gate — it must be green before the branch merges).

- [ ] **Step 3: Add the developer note**

In `README.md`, near the existing test-suite documentation, add:

```markdown
### Cross-engine e2e

The browser e2e suite runs across engines and mobile profiles, selected by env vars:

```bash
npm run test:e2e                              # chromium desktop (also the pre-push gate)
E2E_ENGINE=firefox npm run test:e2e browser   # firefox
E2E_ENGINE=webkit  npm run test:e2e browser   # webkit (needs system deps; see below)
E2E_ENGINE=chromium E2E_DEVICE="Pixel 5" npm run test:e2e browser   # mobile profile
```

`E2E_ENGINE` ∈ `chromium|firefox|webkit`; `E2E_DEVICE` is a Playwright device name (empty =
desktop). GitLab CI runs the full 3×3 matrix on the official Playwright image. WebKit needs
system libraries that a stock host lacks — run the full matrix locally in a container instead
(GitLab #47). On-failure screenshots + console logs land in `test/e2e/artifacts/`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: cross-engine e2e usage (E2E_ENGINE/E2E_DEVICE) in README"
```

---

## Self-Review

**Spec coverage:**
- §Harness (newE2EContext isMobile-strip, newE2EPage, e2eTest, captureFailure, artifacts dir) → **Task 1**.
- §Runner JUnit → **Task 2**.
- §Spec conversion (13 files; issue-3-mobile special case) → **Task 3** (12 files; smoke + pdf-preview already done).
- §CI (e2e-node + matrixed e2e-browser, cache, junit+screenshot artifacts, allow_failure, no services) → **Task 4**.
- §Testing (applyEngineQuirks + captureFailure units; scratch-failure artifact check; chromium green; firefox/device runs) → Tasks 1 + 3 + 5.
- §Versioning (chore, no bump) → Global Constraints; no release task.
- §Firefox+mobile isMobile strip → Task 1 (`applyEngineQuirks`) + Task 3 (issue-3-mobile uses it).

**Placeholder scan:** none — every code step has concrete content; the only `…` are inside "leave logic unchanged" transformation rules where the existing spec body is preserved verbatim.

**Type/name consistency:** `applyEngineQuirks(engineName, profile, extra)`, `newE2EContext`, `newE2EPage`, `e2eTest`, `captureFailure(basename, page, logs, dir)`, `ARTIFACTS_DIR`, `E2E_JUNIT`, `E2E_ENGINE`/`E2E_DEVICE`, the `.e2e-base`/`e2e-node`/`e2e-browser` jobs — consistent across tasks.

**Note for the implementer:** branch is `e2e-ci-matrix` (spec already committed there). This is a chore — no version bump. The pre-push hook runs build + unit + **Chromium** e2e, so Task 3's Chromium suite must be green before merge; Firefox/WebKit flakiness is CI-advisory (`allow_failure`) and out of scope here.
```
