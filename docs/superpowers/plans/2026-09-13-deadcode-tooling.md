# Dead-code / unused-code tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic dead-code / unused-code gate (knip for files/exports/deps/imports, PurgeCSS report-only for CSS) to bucketer, wired into a blocking CI job and a warn-only pre-push step, ratcheted by a reviewed baseline.

**Architecture:** knip walks the esbuild import graph from declared entrypoints and reports unreachable files / unused exports / unused deps / unused imports; a wrapper script (`deadcode-gate.mjs`) diffs knip's findings bidirectionally against a committed `deadcode-baseline.json` (fail on new AND stale entries). CSS is a separate report-only PurgeCSS script, never in the build path. Gate runs as an own CI job (blocking) and a pre-push step (warn-only during bake-in).

**Tech Stack:** Node 20, esbuild, `knip` (exact-pinned), `@fullhuman/purgecss` (exact-pinned), node:test.

**Spec:** `docs/superpowers/specs/2026-09-13-deadcode-tooling-design.md` (read it alongside this plan — decisions A–E and the 5 FP traps travel with it).

## Global Constraints

- **Scope:** unused files / exports / deps / imports / CSS classes ONLY. No lint / formatting / complexity / style.
- **Exact version pins** for `knip` and `@fullhuman/purgecss` (no `^`/`~`) — heuristics shift between minors.
- **Never wire either tool into `build.mjs`** — the byte-reproducibility invariant (CI `reproducibility` job) must not depend on a heuristic. Both tools read source only; `dist/` untouched.
- **False positives are fixed in knip config, never baselined.**
- **Version bump:** must present changes + version level to operator for confirmation before bumping (global rule). A bump commit MUST include rebuilt `dist/index.html` + `src/lib/changelog.js`.
- **No push without operator confirmation** (envelope must-stop). Pre-push hook runs build+unit+component+e2e and auto-tags the current `package.json` version.
- Work in a `.claude-scratch/` worktree branched off **local** `main` (586ac91, includes held v1.59.4). Never switch the shared checkout's branch.

---

## File Structure

- Create `knip.json` — knip config (entrypoints, project, ignores).
- Create `scripts/deadcode-gate.mjs` — ratchet wrapper: run knip JSON → normalize → diff vs baseline → exit 0/1.
- Create `scripts/check-unused-css.mjs` — PurgeCSS report-only + safelist (advisory).
- Create `deadcode-baseline.json` — accepted findings (reason enum + note).
- Modify `package.json` — devDeps (exact) + `deadcode` / `deadcode:css` scripts.
- Modify `test/source-invariants.test.js` — pin-exact assertion + baseline schema guard.
- Create `test/deadcode-gate.test.js` — unit tests for the diff logic.
- Modify `.githooks/pre-push` — warn-only deadcode step before build.
- Modify `.gitlab-ci.yml` — blocking `deadcode` job.
- Create `docs/review-deadcode-tooling/acceptance-evidence.md` — §6 matched-pair evidence.

---

### Task 1: Worktree, install tools, pin-exact guard

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `test/source-invariants.test.js`
- Commit (into branch): the untracked design docs (`docs/superpowers/specs/2026-09-13-deadcode-tooling-design.md`, `docs/superpowers/plans/2026-09-13-deadcode-tooling.md`, `docs/review-deadcode-tooling/*.md`)

**Interfaces:**
- Produces: `knip` + `@fullhuman/purgecss` exact-pinned devDeps; `npm run deadcode` / `npm run deadcode:css` script names (scripts created in later tasks).

- [ ] **Step 1: Create the worktree** (via `superpowers:using-git-worktrees`). Branch `feature/deadcode-tooling` off local `main`. Then copy the untracked design docs from the main checkout into the worktree and commit them as the branch's first commit:
```bash
cp -r /home/basilgohar/dev/bucketer/docs/review-deadcode-tooling <worktree>/docs/
cp /home/basilgohar/dev/bucketer/docs/superpowers/specs/2026-09-13-deadcode-tooling-design.md <worktree>/docs/superpowers/specs/
cp /home/basilgohar/dev/bucketer/docs/superpowers/plans/2026-09-13-deadcode-tooling.md <worktree>/docs/superpowers/plans/
git add docs/ && git commit -m "docs: dead-code tooling panel reports, spec, plan"
```

- [ ] **Step 2: Write the failing pin-exact assertion** in `test/source-invariants.test.js` (match the file's existing `test(...)` idiom):
```js
test('knip and purgecss devDependencies are pinned exact (no range)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const name of ['knip', '@fullhuman/purgecss']) {
    const spec = pkg.devDependencies?.[name];
    assert.ok(spec, `${name} must be a devDependency`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(spec), `${name} must be pinned exact, got "${spec}"`);
  }
});
```

- [ ] **Step 3: Run it, verify it FAILS** (deps absent): `npm test -- --test-name-pattern="pinned exact"` → FAIL.

- [ ] **Step 4: Install exact-pinned** (latest knip 5.x and purgecss 8.x at integration):
```bash
npm install --save-dev --save-exact knip @fullhuman/purgecss
```

- [ ] **Step 5: Add npm scripts** to `package.json`:
```json
"deadcode": "node scripts/deadcode-gate.mjs",
"deadcode:css": "node scripts/check-unused-css.mjs"
```

- [ ] **Step 6: Run the assertion, verify it PASSES**: `npm test -- --test-name-pattern="pinned exact"` → PASS. Confirm `git diff package.json` shows exact versions (no `^`).

- [ ] **Step 7: Commit**: `git add package.json package-lock.json test/source-invariants.test.js && git commit -m "build: add knip + purgecss (exact-pinned) with pin guard"`

---

### Task 2: knip.json config + FP elimination

**Files:**
- Create: `knip.json`

**Interfaces:**
- Produces: a `knip.json` whose `npx knip` run yields ZERO false positives on the known traps; the residual findings (truly-dead + test-only) feed Task 4's baseline.

- [ ] **Step 1: Write `knip.json`** per spec §3 (entries: `src/main.jsx!` + `src/worker/zip-assembler.worker.js!`; `project: ["src/**/*.{js,jsx}"]`; `ignore: ["src/lib/changelog.js"]`; declare/exclude `build.mjs`, `serve.mjs`, `scripts/**`, `perf/**`, `test/**` as needed so they aren't flagged).

- [ ] **Step 2: First run** — `npx knip` and `npx knip --production`, capture both outputs to `.claude-scratch/knip-run-1.txt`.

- [ ] **Step 3: Curate for zero FPs.** Confirm each is ABSENT from findings (adjust `entry`/`ignore`/plugin config until so): `src/worker/zip-assembler.worker.js`, `build.mjs`, `serve.mjs`, `scripts/*.mjs`, `perf/*.mjs`, `src/lib/changelog.js`, `src/lib/vault.js` (file-level). Resolve knip's `node:test` consumer discovery here (add `test/**` to `project` without `!`, or a plugin) — verify a known test-only export (e.g. `enumerateObjects` in `src/lib/dedup-scan.js`) is NOT flagged by plain `knip` but IS flagged by `knip --production`.
  - **Done-criteria:** zero findings on the trap list above; residual findings are only real truly-dead exports/files and test-only exports.

- [ ] **Step 4: Record** the classified residual findings into `.claude-scratch/knip-findings-classified.md` (truly-dead vs test-only vs dormant-vault) — input to Task 4.

- [ ] **Step 5: Commit**: `git add knip.json && git commit -m "build: knip config with entrypoint + generated-file traps handled"`

---

### Task 3: deadcode-gate.mjs ratchet wrapper (TDD)

**Files:**
- Create: `scripts/deadcode-gate.mjs`
- Test: `test/deadcode-gate.test.js`

**Interfaces:**
- Consumes: `deadcode-baseline.json` (array of `{file, identifier, kind, reason, note, added}`); knip JSON output.
- Produces: `diffFindings(current, baseline)` → `{unexpected: [...], stale: [...]}`; exported for testing. CLI exit 0 when both empty, 1 otherwise.

- [ ] **Step 1: Write failing tests** in `test/deadcode-gate.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFindings, findingKey } from '../scripts/deadcode-gate.mjs';

const base = [{ file: 'a.js', identifier: 'foo', kind: 'export', reason: 'test-only', note: 'x', added: '2026-09-13' }];

test('a new finding not in baseline is unexpected', () => {
  const cur = [{ file: 'a.js', identifier: 'foo', kind: 'export' }, { file: 'b.js', identifier: 'bar', kind: 'export' }];
  const { unexpected, stale } = diffFindings(cur, base);
  assert.deepEqual(unexpected.map(findingKey), ['b.js bar export']);
  assert.equal(stale.length, 0);
});

test('a baseline entry with no matching finding is stale', () => {
  const cur = [];
  const { unexpected, stale } = diffFindings(cur, base);
  assert.equal(unexpected.length, 0);
  assert.deepEqual(stale.map(findingKey), ['a.js foo export']);
});

test('exact baseline match is clean', () => {
  const cur = [{ file: 'a.js', identifier: 'foo', kind: 'export' }];
  const { unexpected, stale } = diffFindings(cur, base);
  assert.equal(unexpected.length, 0);
  assert.equal(stale.length, 0);
});
```

- [ ] **Step 2: Run, verify FAIL** (module missing): `npm test -- --test-name-pattern="baseline"` → FAIL.

- [ ] **Step 3: Implement** `scripts/deadcode-gate.mjs`:
```js
#!/usr/bin/env node
// Runs knip, normalizes findings, diffs bidirectionally against deadcode-baseline.json.
// Exit 0 iff no unexpected and no stale findings. Pure diff logic is exported for tests.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const findingKey = f => `${f.file} ${f.identifier} ${f.kind}`;

export function diffFindings(current, baseline) {
  const curKeys = new Set(current.map(findingKey));
  const baseKeys = new Set(baseline.map(findingKey));
  const unexpected = current.filter(f => !baseKeys.has(findingKey(f)));
  const stale = baseline.filter(f => !curKeys.has(findingKey(f)));
  return { unexpected, stale };
}

// normalizeKnip: adapt knip --reporter json output to {file, identifier, kind}.
// CONFIRM the exact JSON shape against the pinned knip version at integration (spec §9).
export function normalizeKnip(json) {
  const out = [];
  for (const [file, issues] of Object.entries(json.files ? {} : json)) { /* replaced below */ }
  return out;
}

function main() {
  const raw = execFileSync('npx', ['knip', '--reporter', 'json'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const current = normalizeKnip(JSON.parse(raw));
  const baseline = JSON.parse(readFileSync('deadcode-baseline.json', 'utf8'));
  const { unexpected, stale } = diffFindings(current, baseline);
  if (unexpected.length) { console.error('New dead-code findings (not baselined):'); unexpected.forEach(f => console.error('  +', findingKey(f).replaceAll(' ', ' '))); }
  if (stale.length) { console.error('Stale baseline entries (code fixed — delete these rows):'); stale.forEach(f => console.error('  -', findingKey(f).replaceAll(' ', ' '))); }
  process.exit(unexpected.length || stale.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```
> NOTE at integration: replace `normalizeKnip` body with the real adapter once the pinned knip JSON shape is confirmed (spec §9 open risk). The `diffFindings`/`findingKey` contract the tests pin does not change.

- [ ] **Step 4: Run, verify PASS**: `npm test -- --test-name-pattern="baseline"` → PASS (3/3).

- [ ] **Step 5: Commit**: `git add scripts/deadcode-gate.mjs test/deadcode-gate.test.js && git commit -m "feat: deadcode ratchet gate (bidirectional diff)"`

---

### Task 4: deadcode-baseline.json + schema guard (TDD)

**Files:**
- Create: `deadcode-baseline.json`
- Modify: `test/source-invariants.test.js`

**Interfaces:**
- Consumes: Task 2's classified residual findings.
- Produces: a committed baseline every entry of which has `file`/`identifier`/`note` non-empty and `reason ∈ {dormant-feature, test-only, todo-remove}`.

- [ ] **Step 1: Write the failing schema guard** in `test/source-invariants.test.js`:
```js
test('deadcode-baseline.json entries are well-formed', () => {
  const REASONS = new Set(['dormant-feature', 'test-only', 'todo-remove']);
  const rows = JSON.parse(readFileSync('deadcode-baseline.json', 'utf8'));
  assert.ok(Array.isArray(rows), 'baseline is an array');
  for (const r of rows) {
    for (const k of ['file', 'identifier', 'note']) assert.ok(r[k] && String(r[k]).trim(), `entry missing ${k}: ${JSON.stringify(r)}`);
    assert.ok(REASONS.has(r.reason), `bad reason "${r.reason}" in ${JSON.stringify(r)}`);
  }
});
```

- [ ] **Step 2: Run, verify FAIL** (file absent): `npm test -- --test-name-pattern="deadcode-baseline"` → FAIL.

- [ ] **Step 3: Author `deadcode-baseline.json`** from Task 2's classification — one row per accepted finding (test-only exports as `test-only`; any gated dormant vault export as `dormant-feature` with a note citing the vault issue; any known-but-not-yet-removed dead export as `todo-remove`). Genuinely-dead code with no reason to keep is REMOVED in a follow-up, not baselined.

- [ ] **Step 4: Run, verify PASS**: `npm test -- --test-name-pattern="deadcode-baseline"` → PASS.

- [ ] **Step 5: Run the full gate clean**: `npm run deadcode` → exit 0 (current findings == baseline).

- [ ] **Step 6: Commit**: `git add deadcode-baseline.json test/source-invariants.test.js && git commit -m "feat: dead-code baseline + schema guard"`

---

### Task 5: check-unused-css.mjs (PurgeCSS report-only)

**Files:**
- Create: `scripts/check-unused-css.mjs`

**Interfaces:**
- Produces: an advisory report of unused `main.css` selectors; exits 0 always (report-only), never blocks.

- [ ] **Step 1: Enumerate dynamic-class prefixes** — `grep -rEo 'class(Name)?=\{`[^`]*\$\{' src/` (and conditional joins) → build the safelist (`/^toast-/`, `/^logo-phase-/`, `/^status-badge/`, `/^upload-item-status/`, plus any others found).

- [ ] **Step 2: Implement** `scripts/check-unused-css.mjs` using the PurgeCSS Node API against `content: src/**/*.{js,jsx}` + `src/index.html`, `css: ['src/styles/main.css']`, with the safelist. Print the rejected (unused) selectors as a list; `process.exit(0)` regardless.

- [ ] **Step 3: Run** `npm run deadcode:css`. Verify the known dynamic classes (`.toast-success`, `.toast-error`, `.status-badge`) are NOT reported as unused (safelist working). Note any genuinely-unused classes for a later manual prune (advisory).

- [ ] **Step 4: Commit**: `git add scripts/check-unused-css.mjs && git commit -m "feat: report-only unused-CSS check (PurgeCSS, safelisted)"`

---

### Task 6: Acceptance procedure (matched-pair proof)

**Files:**
- Create: `docs/review-deadcode-tooling/acceptance-evidence.md`

- [ ] **Step 1: True-positive RED** — append `export function __deadcodeProbe() { return 1; }` to `src/lib/format.js`. Run `npm run deadcode` → expect **exit 1** naming `format.js __deadcodeProbe`. Capture output.

- [ ] **Step 2: True-positive GREEN** — remove the probe. Run `npm run deadcode` → expect **exit 0**. Capture output.

- [ ] **Step 3: FP zero-finding** — confirm `src/worker/zip-assembler.worker.js` and the dynamic CSS classes appear in NEITHER `npm run deadcode` nor `npm run deadcode:css` unused output.

- [ ] **Step 4: Write evidence** to `docs/review-deadcode-tooling/acceptance-evidence.md` (both captures, tool version, date) and commit: `git add docs/review-deadcode-tooling/acceptance-evidence.md && git commit -m "docs: dead-code gate acceptance evidence"`

---

### Task 7: Wire the gates (pre-push warn + CI blocking)

**Files:**
- Modify: `.githooks/pre-push`
- Modify: `.gitlab-ci.yml`

- [ ] **Step 1: Alpine install proof** — confirm the verify-at-integration risk (spec §9): `podman run --rm -v "$PWD":/w -w /w node:20-alpine sh -c "npm ci && npx knip --version"` → succeeds (oxc-parser musl binary installs). Capture output.

- [ ] **Step 2: Add the pre-push warn step** in `.githooks/pre-push`, as the first action inside the `if [ "$branch_refs" -gt 0 ]` block, before `npm run build`:
```sh
  echo "Checking for dead code (advisory during bake-in)..."
  npm run deadcode || echo "  dead-code findings above (advisory — not blocking yet)"
```

- [ ] **Step 3: Add the blocking CI job** to `.gitlab-ci.yml` in the `test` stage:
```yaml
deadcode:
  stage: test
  image: node:20-alpine
  rules:
    - if: '$RELOCK_MIRROR == "true"'
      when: never
    - when: on_success
  script:
    - npm ci
    - npm run deadcode
```

- [ ] **Step 4: Verify** — pre-push step is warn-only (simulate a finding locally; hook does not abort). Validate CI YAML (`git show`-diff review; `npm run deadcode` is the exact command CI runs).

- [ ] **Step 5: Commit**: `git add .githooks/pre-push .gitlab-ci.yml && git commit -m "ci: dead-code gate — blocking CI job + warn-only pre-push step"`

---

### Task 8: Release (operator-gated)

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json`, `dist/index.html`, `src/lib/changelog.js`

- [ ] **Step 1: Present to operator** — summary of all changes (this arc + held v1.59.4 dead-CSS) and the proposed version level (likely **patch**, dev-tooling only, no user-facing change). **STOP for confirmation of both changes and version level** (global versioning rule).

- [ ] **Step 2: Bump** — `npm version <confirmed> --no-git-tag-version`.

- [ ] **Step 3: CHANGELOG** — add top entry matching the new version; note the dead-code gate + the v1.59.4 dead-CSS prune folded in.

- [ ] **Step 4: Rebuild** — `npm run build`; confirm build invariants pass and the committed dist matches.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "vX.Y.Z — dead-code / unused-code gate (knip + PurgeCSS report-only)"`.

- [ ] **Step 6: Merge to main + push** — fast-forward/merge the feature branch onto local `main`, then **STOP for operator push confirmation** (envelope must-stop). The pre-push hook runs build+unit+component+e2e and tags the current version. Note: v1.59.4 gets no own tag (hook tags only the current version); it's an intermediate commit recorded in the CHANGELOG.

- [ ] **Step 7: Post-push** — verify CI pipeline green (incl. the new `deadcode` job); live-verify the deployed version; write the run debrief (`.claude-scratch/deadcode-debrief-2026-09-13.md`): planned vs shipped, guard blocks, token/wall-clock, lessons.

---

## Self-Review

**Spec coverage:** §2 tool→Task 1–2; §3 config/traps→Task 2; §4 gate integration→Task 7; §5 baseline→Task 3–4; §6 acceptance→Task 6; §7 coherence (no source-invariants fold)→respected (detection in scripts, only schema guard in source-invariants); §8 rollout→Tasks 1–8; §9 risks→verified in Task 2 (node:test discovery, MAX_CONCURRENCY), Task 7 (alpine), Task 3 (reporter shape). Decision A (staged)→Task 7; B (bidirectional)→Task 3; C (imports)→knip default; D (CSS report-only)→Task 5; E (pilot)→no fleet task. Covered.

**Placeholder scan:** The `normalizeKnip` body is explicitly marked as an integration-time adapter with a stable tested contract around it — not a hidden TODO; the diff logic (the actual gate teeth) is fully specified and TDD'd. Version number in Task 8 is operator-gated by design.

**Type consistency:** `findingKey`/`diffFindings` signatures consistent across Task 3 test + impl; baseline entry shape (`file`/`identifier`/`kind`/`reason`/`note`/`added`) consistent across Tasks 3, 4. `npm run deadcode` / `deadcode:css` names consistent Tasks 1, 4, 5, 6, 7.
