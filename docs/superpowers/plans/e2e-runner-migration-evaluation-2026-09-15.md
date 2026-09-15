# #63 — Evaluation: migrate the browser e2e layer to the Playwright Test runner?

Deliverable of GitLab #63 (https://gitlab.com/hidayahtech/bucketer/-/issues/63), produced in the
`e2e-robustness` autonomous run **after** #62 (v1.62.2) scaled the remaining deadline literals.
This is an evaluation + recommendation for an operator go/no-go — **not** a migration. The actual
migration, if greenlit, is separate work.

## The question

Should the hand-rolled `node:test` + raw-Playwright browser e2e layer move to `@playwright/test`
(the Playwright Test runner), which offers built-in per-test retries with trace, per-project
config/timeouts, and web-first auto-retrying assertions?

## Current architecture (what exists today)

- **`test/e2e/run-matrix.mjs`** — spawns `run.mjs` once per lane (node layer + 9 browser combos:
  chromium/firefox/webkit × desktop/Pixel 5/iPhone 13) via `E2E_ENGINE`/`E2E_DEVICE` env; prints a
  lane summary. Lanes run sequentially.
- **`test/e2e/run.mjs`** — builds the app to `perf/` (gitignored), then `node --test
  --test-concurrency=1` over the collected `*.test.mjs`; emits JUnit in CI.
- **`test/e2e/harness.mjs`** — the hand-rolled core: `e2eTest()` wrapper (manual screenshot +
  console capture on throw, since `node:test` has no per-test failure hook), engine/device launch
  (`launchBrowser`/`newE2EContext`/`newE2EPage`), **per-spec** mock-S3 + app-server boot, the
  `scaleTimeout` lane factor, `collectDownloads` (the presence-assertion side of the E2E Evidence
  Rules), and the fake directory-picker.
- **`test/e2e/matrix-helpers.mjs`** — combo building + `imageTagFromLock` (pins the container image
  to the locked Playwright version); unit-tested under `npm test`.
- **`scripts/e2e-container.mjs`** — podman/docker + the pinned Playwright image, `npm ci` into a
  named volume, runs the matrix. This is the only way WebKit runs (host can't).
- **`test/e2e/lane-timeout.mjs`** — `scaleTimeout` (webkit ×2, mobile ×1.5). After #62, every
  browser-spec deadline is routed through it.
- **`.gitlab-ci.yml`** — the browser lanes are a `parallel:matrix`, `retry:max=2` on the browser
  lanes only; a unit test asserts the CI image == the locked-Playwright image (lockstep guard).

## What `@playwright/test` would provide

- Built-in per-test **retries with trace/screenshot/video** on the retried run (today: hand-built
  retry in CI + manual screenshot capture).
- **Per-project** (engine × device) timeouts and config in one `playwright.config`.
- **Web-first auto-retrying assertions** (`expect(locator).toBeVisible()`, `expect.poll`) — these
  remove the hand-rolled-deadline class structurally. (#62 has already *scaled* that class; this
  would *eliminate* it.)
- Standard tooling: trace viewer, HTML report, sharding, `--project` selection.

## What the migration would touch (scope / cost — effort L, as labelled)

1. **All 26 specs** — swap `node:test` + `node:assert` for `import { test, expect } from
   '@playwright/test'`; convert manual polls and `waitFor` deadlines to web-first assertions; adopt
   fixtures instead of `before/after` harness boot.
2. **`harness.mjs` → fixtures** — the biggest change. The per-spec mock-S3 + app-server boot and
   the page/context/engine selection become Playwright **fixtures** (worker- or test-scoped). The
   `collectDownloads` presence-assertion and the fake picker must survive as fixtures/helpers.
3. **Matrix/runner** — `run-matrix.mjs` + `run.mjs` largely replaced by `playwright.config`
   projects and `playwright test --project=…`; `e2e-container.mjs` calls `npx playwright test`.
4. **CI** — the `parallel:matrix` lanes become `--project`/shard invocations; keep the retry and
   the image↔version lockstep guard (now `@playwright/test` version).
5. **New dependency** `@playwright/test` (dev-only; no bundle impact, but the repo prizes minimal
   deps and exact-pinning — it must lockstep with the container image, same as `playwright` does).

## What must be preserved (non-negotiable)

- The **in-repo stateful mock S3** (`test/e2e/mock-s3/`) and its request log (`mock.requestLog`) —
  the absence-assertion half of the E2E Evidence Rules.
- The **containerised 3×3** with **no engine special-cased** (WebKit can't run on the host).
- The **E2E Evidence Rules**: one observable per feature, presence **and** absence assertions,
  matched-pair for fixes. `@playwright/test` makes presence assertions easier but does not by
  itself preserve the *absence* discipline (`collectDownloads`/`requestLog`) — that must be ported
  deliberately.
- The **CI image ↔ locked-Playwright-version lockstep guard**.

## Benefit *now*, after #62 + v1.60.1

The urgency that motivated #63 has **dropped twice**:
- v1.60.1 added CI job retry + per-lane timeout scaling (absorbs transient stalls).
- v1.62.2 (#62, this run) scaled every remaining deadline literal (removes the unscaled-deadline
  flake source at the source).

So the acute pain — flaky mobile/webkit lanes going red on timing — is now mitigated at both the
CI and the source level. The migration's remaining value is **structural/quality**, not
firefighting: better failure artifacts (trace viewer), auto-retrying assertions that can't drift
back to raw deadlines, and standard tooling. Those are real but not urgent.

## Risks

- A full-harness rewrite of a **known-green, evidence-disciplined** suite risks re-introducing
  flake and, worse, silently weakening the presence/absence assertion discipline the 2026-07-31
  postmortem exists to enforce (a green `@playwright/test` suite is just as capable of asserting
  nothing).
- Fixture-scoped mock-S3/app-server lifecycle is subtly different from the current per-spec boot;
  getting worker-scoping wrong can cross-contaminate state between specs.
- New dependency + lockstep maintenance surface.

## Options

- **A — Defer (recommended).** Keep the current harness; #62 + v1.60.1 have removed the urgency.
  Revisit only if flakiness returns materially or the failure-artifact gap (no trace viewer) starts
  costing real debugging time. Cost: none.
- **B — Full migration now.** Effort L, big-bang risk against a green suite for mostly-quality
  gains. Not justified while the suite is stable.
- **C — Incremental/hybrid.** Introduce `playwright.config` + fixtures and migrate a *few* specs
  behind the same containerised matrix, proving the fixture model + evidence-rule port on a small
  surface before committing the rest. This is the right shape **if** the operator wants to pursue
  the quality gains — a staged migration, never big-bang. A throwaway spike (convert 1–2 specs,
  measure) would ground the effort estimate; not done here to avoid installing a new dep
  speculatively before the go/no-go.

## Recommendation

**Defer the full migration (Option A).** After #62 and v1.60.1 the flake urgency is gone, and a
big-bang rewrite of a green, evidence-disciplined suite is high-risk for mostly-quality reward. If
and when the quality gains (trace viewer, auto-retrying assertions) are worth pursuing, do it as a
**staged Option C**, starting with a spike, not a big-bang — and port the presence/absence
assertion discipline explicitly, not incidentally.

Suggested disposition of #63: keep open, relabel as evaluated/deferred with this doc linked, or
close as "evaluated — defer" per operator preference.
