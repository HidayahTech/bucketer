# Infra lane — dead-code gate integration point

Scope: where/how the dead-code gate (unused files/exports/deps/CSS classes) runs,
given the existing `.githooks/pre-push` and `.gitlab-ci.yml`. Read-only lane;
no code or config changed. Both files were read in full for this analysis.

## 1. Recommendation (lead)

**Both, but with different jobs**: a fast local check in `.githooks/pre-push`
(advisory-in-effect, since the hook is bypassable), and a dedicated, blocking CI
job as the real gate.

- **Pre-push**: add a new step **before** `npm run build`, as the very first
  thing the hook does after the branch-push check on line 24 of
  `.githooks/pre-push`. Dead-code analysis reads `src/` statically — it needs
  neither a build nor a running test suite — so it can run before the ~minutes-long
  build→test→test:ui→test:e2e chain and fail in seconds instead of minutes. This
  matches the hook's own existing intent (fail fast) and costs nothing extra when
  the tree is clean.
- **CI**: add a new job, e.g. `deadcode`, in the existing `test` stage
  (`.gitlab-ci.yml` line 1-4), parallel to `test` and the `e2e-*` jobs rather than
  folded into the `test` job's script. Image: `node:20-alpine` — same as `test`
  and `reproducibility`, no browser needed. Rationale for a separate job over a
  step inside `test`:
  - **Distinct pipeline dot.** A failure shows as "deadcode failed," not "test
    failed," so attribution is unambiguous at a glance — same reasoning the repo
    already applies by keeping `reproducibility` and `release` as their own jobs
    rather than steps tacked onto `test`.
  - **No coupling to the stale-dist guard.** The `test` job's script snapshots
    `dist/index.html`, runs `npm ci && npm run build`, and diffs (lines 18-27)
    before running any test command. A dead-code job has no reason to build at
    all (see §5) — folding it in would force it to ride along after a build step
    it doesn't need, adding wall-clock to a job whose current shape is already
    build-then-test.
  - **Independent rerun.** GitLab lets a single failed job be retried; a
    dead-code false-positive (see §4) shouldn't require re-running the build/test
    job to get a clean pipeline.

Why not CI-only: pre-push is where the *author* gets the fast local signal per
the repo's stated intent (`.githooks/pre-push` line 2, "builds, runs the full
test suite... "). Adding a seconds-long step ahead of the existing minutes-long
chain is close to free and shortens the feedback loop for the most common
finding (an orphaned file/export from a refactor) — exactly the shape of change
this repo does a lot of (`useRename`/`useNewFolder` hook extractions in the
recent log). Why not pre-push-only: the hook is explicitly client-side and
bypassable by design (`--no-verify`, hook header lines 14-15; also stated as
the general policy in the repo's `CLAUDE.md` Verification Gate section — "the
hook is client-side (bypassable by design); the build invariants... are the
backstop"). A dead-code regression that ships because someone used
`--no-verify` under time pressure is exactly the failure mode the CI job exists
to catch.

## 2. Pinning mechanism

Pin the tool as an **exact version** (no `^`/`~`) in `package.json`
`devDependencies`, e.g. `"knip": "5.x.y"` — not the caret-range style already
used for `esbuild`/`playwright`/etc. This is a deliberate deviation from the
existing convention, not an oversight: dead-code/unused-export detectors change
their analysis heuristics between minor versions (new export patterns
recognized, new false-positive suppressions, changed defaults), so a routine
`npm update` could silently start failing (or silently stop catching things) on
unrelated commits — a form of the same "signal wanders when a dependency is
under-pinned" problem this repo already worked around with playwright.

Unlike the playwright image, there is no second artifact to drift out of
sync — the tool never touches a Docker image tag, only `package.json` /
`package-lock.json`, and `npm ci` in both `.githooks/pre-push`'s environment
and every CI job already installs the exact locked resolution. So the
playwright lockstep test's specific mechanism (parse the lockfile, derive an
image tag, assert `.gitlab-ci.yml` matches — `test/e2e-matrix-helpers.test.js`
lines 52-66) doesn't have a direct analog to keep in sync. What *is* worth an
analogous guard, in the same spirit and same file family as
`test/source-invariants.test.js`, is a small assertion that the pin hasn't
regressed to a range:

```js
// package.json devDependency for the dead-code tool must be an exact version,
// not a range — see docs/review-deadcode-tooling/infra-lane.md §2.
const spec = pkg.devDependencies.knip;
assert.ok(/^\d+\.\d+\.\d+$/.test(spec), `knip devDependency must be pinned exact (got "${spec}")`);
```

This makes drift (someone hand-editing back to `^5.0.0`, or a dependency-bot PR
loosening it) fail loudly in both `npm test` (pre-push and CI `test` job) and
stand as a self-documenting reason, the same role `test/source-invariants.test.js`
already plays for other structural rules.

## 3. Failure semantics & reporting

- **Exit code**: rely on the tool's own default — confirmed for the likely
  candidate, knip: exit 0 = clean, exit 1 = at least one finding, exit 2 =
  config/internal error (knip.dev/reference/cli, fetched 2026-09-13). No
  `--no-exit-code` flag anywhere in this pipeline — the gate must fail the job.
- **Pre-push reporting**: plain console output (the tool's default `symbols`
  reporter or `compact`) is sufficient — a human is watching the terminal
  synchronously.
- **CI reporting**: the existing e2e jobs upload `junit-e2e.xml` via GitLab's
  `artifacts.reports.junit` for MR test-summary integration (`.gitlab-ci.yml`
  lines 66-70, 81-87). Knip has **no built-in JUnit reporter** — its built-in
  set is `symbols` (default), `compact`, `codeowners`, `json`, `codeclimate`,
  `markdown`, `disclosure`, `github-actions`, `sarif`, `cycles`
  (knip.dev/features/reporters, fetched 2026-09-13). Two honest options, not a
  reporter that doesn't exist:
  - Use the `codeclimate` reporter and wire it as a `codequality` report
    artifact (GitLab natively renders Code Quality reports in the MR widget —
    this is arguably a better fit than forcing JUnit and gets equivalent
    MR-surfaced visibility without writing a custom reporter).
  - Or keep it simple: plain console output plus `artifacts: paths:` on a
    saved `deadcode-report.json` (`--reporter json --reporter-options
    '{"path":"deadcode-report.json"}'` or equivalent), `expire_in: 1 week` to
    match the e2e artifact retention, with no MR-widget integration. Lower
    effort, less discoverable on failure.
  - **Recommendation**: `codeclimate` reporter → `codequality` artifact if the
    chosen tool's version at integration time still supports it (verify against
    the pinned version once selected); fall back to plain console + JSON
    artifact otherwise. This is a one-line choice to confirm against whichever
    exact version gets pinned per §2, not a blocking unknown.

## 4. DX impact

- **Pre-push added wall-clock**: a static source scan (no build, no browser)
  is a seconds-scale operation on a project this size (per-file/export graph
  walk over `src/`, no I/O beyond the filesystem). Against a hook that already
  runs a full build + three test layers including a Playwright e2e pass
  (described as "already SLOW (minutes; e2e dominates)" in the task framing,
  consistent with the hook comment about e2e being the long pole) — adding
  low-single-digit-seconds ahead of that is not a meaningfully different
  developer experience. Placed first (§1), it can also *shorten* the average
  loop: a dead-file/export finding is a common, cheap-to-fix mistake, and
  catching it before a multi-minute build+e2e run saves time on the failure
  path, which is the path that matters for DX.
- **False-positive risk is the real DX cost, not runtime.** Dead-code tools are
  more prone to false positives than lint/build steps: dynamic imports,
  framework-magic entry points (Preact's JSX runtime, test-file-only exports,
  `build.mjs`/`scripts/*.mjs` used only from `package.json` scripts) can all be
  flagged as "unused" incorrectly. This is a tooling-configuration concern for
  whichever lane owns tool selection/config, but it is the dominant DX risk for
  *this* lane's placement recommendation: a pre-push step that cries wolf
  trains developers to reach for `--no-verify`, quietly undermining the rest of
  the hook (tests included) — not just the new gate. Mitigate by keeping the
  pre-push step non-fatal-with-warning-only during a bake-in period (print
  findings, exit 0) while the CI job runs in blocking mode from day one, then
  flip pre-push to blocking once a clean run streak is established — a staged
  rollout rather than a permanent split, so the two layers converge on the same
  strictness. **Flagging this as a recommendation for whichever lane finalizes
  the rollout sequencing**, since it trades off against that lane's config
  choices for suppressing legitimate framework-magic exports.
- **Verdict**: pre-push addition is acceptable as a fast, cheap check, *not* as
  a substitute for the CI gate — see §1's bypass argument. If the false-positive
  rate turns out high in practice, the fallback is to drop the pre-push step
  and keep the CI job as sole enforcement (advisory locally via a documented
  `npm run deadcode` a developer can run by hand); this is a low-cost fallback
  because nothing else in the hook or CI depends on the pre-push step's
  presence.

## 5. Interaction with determinism

Confirmed no interaction with the `reproducibility` job or the committed
bundle:

- The dead-code tool analyzes `src/` (and `package.json`) as static source
  input — it does not invoke `build.mjs`, does not read or write `dist/`, and
  is not part of `npm run build`. `.gitlab-ci.yml`'s `reproducibility` job
  (lines 134-148) only ever runs `npm run build` twice and diffs `dist/`; a
  new `deadcode` job in the `test` stage runs independently and produces no
  build output for that job to consume or be perturbed by.
- It also cannot affect the `test` job's stale-dist guard (lines 18-27), which
  compares a snapshot of the committed `dist/index.html` against a fresh
  build — again, no shared inputs or outputs with a source-only scanner.
- One caveat worth stating explicitly rather than assuming: if whichever tool
  is chosen ships a native/binary component (e.g. a Rust-based parser via
  napi), confirm it has a prebuilt binary for the CI image's actual libc.
  Checked for the likely candidate: knip depends on `oxc-parser`, whose napi
  target list includes `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl` (registry.npmjs.org/oxc-parser/latest, fetched
  2026-09-13) — i.e. it ships a musl-compatible prebuilt binary and should
  install cleanly under `npm ci` on `node:20-alpine` the same way `esbuild`
  (already a devDependency, also a native binary, already proven to work in
  this same `node:20-alpine` `test` job) does. This is a point-in-time fact
  about the current `oxc-parser` release, not a permanent guarantee — worth a
  one-line confirmation (`npm ci && npx <tool> --version` in the alpine image)
  at integration time rather than trusting this doc indefinitely.

## 6. Open risks / unverified

- **Tool selection is out of this lane's scope** — this analysis assumes a
  Node-CLI devDependency shaped like knip, per the task framing. If a different
  tool is chosen (e.g. one requiring a TypeScript project or a bundler-specific
  plugin), re-check §5's native-binary/alpine claim and §3's reporter
  inventory against that tool specifically — both were verified against knip
  only.
- **CI cache**: the `test` job runs bare `npm ci` with no `cache:` block; only
  `.e2e-base` caches `node_modules/` (keyed on `package-lock.json`, lines
  58-61) because it's reused across the 3×2 + 3×2 matrix jobs. A single
  `deadcode` job has no parallel siblings to share a cache with, so plain
  `npm ci` (no cache) is fine and consistent with how `test` and
  `reproducibility` already behave — not recommending a cache addition unless
  the job's own `npm ci` time becomes a measured problem.
- **Reporter choice (§3)** is contingent on the exact tool version pinned;
  flagged as a one-line check to redo once §2's version is chosen, not
  performed here since no version is pinned yet.
- **Bake-in staging (§4)** — the pre-push-warn-only / CI-blocking split is this
  lane's recommendation for rollout risk, but the decision of how long to stay
  in that state (and how to track the "clean streak" before flipping pre-push
  to blocking) belongs to whichever lane owns rollout sequencing; not decided
  here.
