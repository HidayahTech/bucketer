# Debrief — E2E flake hardening (2026-09-13)

Runbook: `docs/superpowers/plans/e2e-flake-hardening-execution-plan-2026-09-13.md`.
Shipped as **v1.60.1** (fast-forward to main, commit `7030a28`).

## Planned vs shipped

Both planned items shipped, exactly as scoped; no unplanned fixes, no scope creep.

- **A (#1) CI job retry** — `retry: {max: 2, when: [script_failure, stuck_or_timeout_failure, runner_system_failure]}`
  on `.e2e-browser-base` only. `e2e-node`, `test`, `deadcode`, `reproducibility` deliberately
  excluded. Config guard test added (`test/e2e-matrix-helpers.test.js`): asserts the browser
  base retries max 2 with those reasons AND that `e2e-node` does not.
- **B (#2) per-lane timeout scaling** — new `test/e2e/lane-timeout.mjs`
  (`laneTimeoutFactor`: webkit ×2, mobile ×1.5 → webkit-mobile ×3, desktop ×1; `scaleTimeout`).
  Applied to Playwright's per-page default timeout (harness), the harness deadline helpers
  (`waitForCount`, connect file-input wait), the `waitForKeys` poll across the 5 specs that
  define it, and the sort spec's inline 5 s poll (the exact deadline that blew in #308).
  Pure factor logic unit-tested (`test/e2e-lane-timeout.test.js`, playwright-free).
- **Explicitly deferred (#3):** blanket-scaling the scattered fast-transition `timeout:` literals
  in individual specs / converting hand-rolled polls to web-first assertions. Not evidenced as
  the flake source; a separate audit if flakiness persists.

## Verification

- Container e2e, serialized (host OOMs on concurrent 3×3), image `mcr.microsoft.com/playwright:v1.60.0-noble`:
  chromium × desktop ✓, firefox × desktop ✓, webkit × desktop ✓ (×2), **webkit × iPhone 13 ✓** (×3).
  The #308 flake assertion — "clicking the Name header sorts; descending reverses row order" —
  passed on webkit × iPhone 13 in ~0.94 s, comfortably inside the now-15 s (×3-scaled 5 s) poll.
- Deterministic artifacts: lane-timeout unit test (7/7), CI-config guard test (both directions),
  full `npm test` 1576 ✓, component 551 ✓, dead-code gate clean.
- Matched-pair note: the flake is nondeterministic, so the fails-before/passes-after evidence is
  the pure-function tests + the config guard (fail on origin/main, pass here), not a flake
  reproduction. The webkit × iPhone 13 green run is the real-lane confirmation.
- Harness fidelity: the GitLab job-retry auto-heal is not representable in the local harness
  (stated in the commit); the config guard test is its durable substitute.
- CI main pipeline #310 (v1.60.1): **success — and Item A proved itself in production.**
  `e2e-browser: [firefox, ]` (firefox desktop) flaked once (`script_failure`) and **auto-retried
  to green**; the pipeline finished success with zero manual intervention (14 job attempts =
  13 jobs + 1 auto-retry). Notably a *different* lane than #308's webkit-mobile — confirming the
  random-lane nature of the flakiness the retry is designed to absorb.
- Live-verify: https://bucketer.hidayahtech.net/ serves `build-id`/`app-version` = **1.60.1**.

## Wall-clock / touches / cost

- Wall-clock: ~1 h (dominated by the 4 serialized container e2e lanes + CI).
- Operator touches: 3 (start "implement #1 and #2 as a new run"; "go ahead, use fast forward";
  version-bump confirmation).
- Subagents: 0 (small, done inline — as forecast).
- Token cost: modest; no fan-out.

## Guard blocks

- None this run. (Last run's `run-envelope-guard: BLOCKED — push to 'main' — not in push_branches []`
  was avoided here by adding `main` to `push_branches` at the bump-confirmation moment, then
  re-closing.) The redirection-parsing pitfall (`2>&1` read as a refspec) was avoided by running
  the push bare.

## Lessons (→ milestone-orchestration-mode.md)

- **Avoid the followTags tag-race up front.** The pre-push hook creates and pushes the version
  tag itself; with `push.followTags=true` a plain `git push origin main` then re-tries the same
  tag and exits 1 (benign but noisy — hit on the v1.60.0 push). Pushing the branch with
  `git -c push.followTags=false push origin main` lets the hook own the single tag push → clean
  exit 0. (Only matters on the tag-creating push.)
- **Test-infra/CI-only changes still fit the package version model** — a patch bump with a
  "no user-facing change" CHANGELOG entry keeps a tagged, documented release without implying a
  behaviour change; the dist changes only in its embedded version string.
