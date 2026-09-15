# e2e-robustness run — debrief (2026-09-15)

Autonomous run `e2e-robustness`: GitLab **#62** (e2e deadline audit) + **#63** (runner-migration
evaluation), sequenced #62 → #63. Runbook:
`docs/superpowers/plans/e2e-robustness-execution-plan-2026-09-15.md`.

## Planned vs shipped

| Item | Planned | Outcome |
|---|---|---|
| #62 | Convert/scale hand-rolled e2e deadlines | **Shipped v1.62.2** — ~164 deadline literals scaled across 25 browser specs |
| #63 | Evaluate Playwright Test runner migration | **Evaluated → operator DEFER + CLOSE** (doc: `e2e-runner-migration-evaluation-2026-09-15.md`) |
| unplanned | — | Format-gate recovery (codemod edits weren't Prettier-clean); one follow-up commit |

## #62 — what shipped

Routed the remaining unscaled deadline literals (`waitFor({ timeout: N })` and `Date.now() + N`
poll deadlines) through the existing per-lane `scaleTimeout()` factor. The specs were **already
condition-based** (Playwright `waitFor`/condition polls); only their deadlines were unscaled, so
this was the issue's "route the remaining literals through `scaleTimeout()`" clause — no harness
rewrite. Implemented via a reviewed codemod (`.claude-scratch/runs/e2e-robustness/scale-deadlines.mjs`);
the one deliberate best-effort `.catch()` probe (prefix-scope, optional region field) left raw.
Shipped as patch **v1.62.2** (operator-confirmed level), "no user-facing change".

## Evidence (E2E Evidence Rules)

- **Baseline** (untouched tree, image `mcr.microsoft.com/playwright:v1.60.0-noble`): all 10 lanes
  green (node + chromium/firefox/webkit × desktop/Pixel 5/iPhone 13).
- **Post-change** (same image): all 9 browser lanes + node green, run as **two containerised
  invocations** (chromium+firefox 7/7; webkit 4/4) — split only to fit a memory-starved host, same
  image, full coverage.
- Local: 1580 unit + 551 component green; build reproducible (no dist drift — the source change is
  test-only).
- CI: branch pipeline 2852421435 green (all gates incl. `format` + 9 e2e lanes + reproducibility);
  main pipeline 2852449242 green; live site serves `1.62.2` (build-id + app-version).

## Merges performed

- **bucketer!16** *v1.62.2 — E2E deadline robustness (#62)*
  (https://gitlab.com/hidayahtech/bucketer/-/merge_requests/16), target **main**, merged under the
  `merge_prod_branches: main` grant → merge commit `8605a57`. Project `merge_method=merge`, so this
  is a **merge commit**, a divergence from prior ladder releases' direct ff pushes (the run's
  envelope grants merge-to-main via MR, and the guard blocks direct pushes to main).

## Grant changes

- 2026-09-15 14:47 CDT — operator: "You can merge to prod once you're done and you need to.
  Granted." → `merge_prod_branches: main`.

## Guard blocks / environment friction (and what was done instead)

- **Guard: `git push … 2>&1` misread `2>&1` as a refspec** → ran pushes bare, read output from the
  tool result. (Known lesson, re-confirmed.)
- **Guard: tag-ref deletion (`:refs/tags/v1.62.2`) blocked** as a branch deletion → could not move
  the hook-auto-created tag. See TAG WART below.
- **Host OOM pressure** (2.9 GiB → <0.5 GiB free, heavy swap, from *other* concurrent workloads):
  killed the single-invocation container matrix mid-webkit and repeatedly culled background bash
  pollers. Worked around by (a) splitting the matrix into per-engine containerised invocations, and
  (b) using the **Monitor tool** (harness-managed, survived) for CI waits where detached bash did not.

## TAG WART (flagged to operator)

The pre-push hook created annotated tag **v1.62.2 → `e16b991`** (the bump commit) on the first
branch push, *before* the format fix. The format fix landed as a follow-up commit (`9563441`); the
guard blocks tag-ref deletion and moving a published tag is bad practice, so the tag stayed on
`e16b991`. `e16b991`'s specs are pre-Prettier (would fail the `format` gate if re-run), but its
**deployable bundle is byte-identical** to the formatted tip (formatting touched only test files),
so only test-file whitespace differs. Operator can move the tag to `8605a57`/`9563441` with
maintainer perms if desired. **Root fix for next time:** run `npm run format:check` locally before
the *first* push of any codemod/source edit, so the bump commit is gate-clean and the tag lands right.

## #63 — evaluation outcome

Recommendation was **defer** (urgency dropped after v1.60.1 retry/scaling + #62 source-side
scaling; a big-bang rewrite of a green, evidence-disciplined suite is high-risk for mostly-quality
gains). Operator chose **defer + close**. #63 closed with the rationale; evaluation doc committed.

## Metrics

- Wall-clock: ~2 h (envelope confirmed 14:41 → live-verified 16:37).
- Operator touches: 5 (batch selection; handoff yes; prod-merge grant; version-level; #63 decision).
- Subagents: 0 (the work was mechanical + judgment I kept inline; no fan-out needed).
- Releases: 1 (v1.62.2).

## Lessons (also appended to milestone-orchestration-mode.md)

1. **The pre-push hook only ADVISES `format`; the blocking gate is CI-only.** A codemod's mechanical
   output is not Prettier-clean — run `npm run format:check` (and fix) locally before the first push,
   or the blocking CI `format` job reds the pipeline after the tag is already cut.
2. **A hook that auto-tags on the bump-commit push makes that push effectively irreversible** under a
   guard that blocks tag deletion — get the bump commit gate-clean *before* pushing it.
3. **Under host memory starvation, prefer the Monitor tool over detached bash** for CI waits (the
   OOM monitor culls detached bash instantly), and **split the container matrix into per-engine
   containerised invocations** (same image, full coverage) to lower peak memory.
4. **Review codemod import edits specifically** — a lazy regex injected an import into the wrong
   `import {` (node:test) block; caught in diff review before it shipped.
