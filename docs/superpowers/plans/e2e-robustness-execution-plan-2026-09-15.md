# Autonomous run — e2e robustness (deadline audit + runner evaluation)

Batch: bucketer **#62 + #63**, sequenced #62 → #63. Written from `/autonomous-run`
Branch 1 on 2026-09-15. Envelope: `.claude-scratch/runs/e2e-robustness/run-envelope.md`.

**Repo fit:** bucketer is a static-bundle repo. It has **CI** (GitLab branch pipelines +
the containerised 3×3 e2e matrix) but **no per-MR preview** — Forge serves the committed
`main` bundle, so `main` *is* production. Per the template's repo-fit note, the safety net is
thinner without previews, so this batch is deliberately small (one implementable item + one
evaluation). Ships the way the code-quality-ladder runs did: feature branch → full local suite
→ ff-merge to `main` (the branch pipeline is the continuous check; an MR is optional, for diff
review only).

## 1. Scope

- **#62** — *e2e: convert hand-rolled time-deadlines to condition-based/retrying assertions*
  (chore, effort M) — https://gitlab.com/hidayahtech/bucketer/-/issues/62
  Audit the per-spec deadline literals and hand-rolled `while (Date.now() < deadline)` polls in
  `test/e2e/browser/*` (~26 specs; ~48 `Date.now()` sites, ~149 `timeout:` literals) and convert
  them from *time-based* waits to *condition-based* / retrying assertions that wait for the final
  state, and/or route remaining literals through the existing `scaleTimeout()` lane factor
  (`test/e2e/lane-timeout.mjs`). Goal: specs robust to a slow runner without leaning on the
  v1.60.1 retry safety net. **This is the shipping item** → one patch release.
- **#63** — *e2e: evaluate migrating the browser layer to the Playwright Test runner*
  (refactor, effort L) — https://gitlab.com/hidayahtech/bucketer/-/issues/63
  **Deliverable is an evaluation + recommendation, not an assumed migration.** Assess whether
  `@playwright/test` (built-in retries, per-project timeouts, web-first auto-retrying assertions,
  trace-on-failure) is still worth the harness/matrix/container-wiring refactor *now that #62 has
  removed the hand-rolled-deadline class at the source*. Optional throwaway spike (convert 1–2
  specs) to ground the cost estimate. **Ends at a design must-stop:** operator decides go/no-go on
  the actual migration, which is a *follow-up* (own run or explicit extension), never executed
  unattended.

- Dependency order: **#62 first** (source-side fix), **then #63** (its issue text gates the
  migration on "flakiness stays material after … the source-side deadline audit"). *(session
  choice — corrects the "#63 → #62" ordering in the planning-question option text; the issues
  themselves argue #62 → #63.)*

## 2. Execution mode

- Integration branch `feature/e2e-robustness` off `origin/main`, in the run's private worktree
  `.claude-scratch/runs/e2e-robustness/wt`. Never switch the shared checkout's branch.
- No per-MR preview exists; the **branch CI pipeline** is the continuous check. An optional draft
  MR to `main` may be opened for diff/CI visibility but is not required.
- Per-item commits referencing the issue (`#62` / `#63`).
- `main` = prod. Shipping #62 = ff-merge `feature/e2e-robustness` → `main`, which triggers the
  pre-push hook (build + test + tag) and a Forge deploy. **The merge to `main` is an operator act**
  unless the operator grants a prod merge in words during the run (`merge_prod_branches: main`).
- One container e2e matrix run at a time (memory/CPU pressure); the container matrix is long
  (~10–20 min per full 3×3) — see §3.

## 3. Per-item loop and gates

**E2E Evidence Rules apply hard here — #62 changes the e2e specs themselves.**

0. **Baseline first (required, before any change):** run `npm run test:e2e:container` on the
   untouched tree once; record the result (image tag + browser versions + pass counts). A later
   red lane without this baseline can't be attributed.
1. Label `status::in-dev` equivalent via a status note on the issue; assign basilgohar (already).
2. #62: convert specs in reviewable batches (by file / by pattern). For each converted spec, the
   **parity proof** is that the same spec still passes *and* the new assertion waits for final
   state rather than snapshotting a time window. List intended differences in the commit.
3. **Full local suite before every push** (`npm test` + `npm run test:ui`); never `--no-verify`.
4. **Container matrix after the conversion is complete** (`npm run test:e2e:container`) — all three
   engines in the Playwright image, no host-browser mixing (CLAUDE.md rule). Record image tag +
   versions. This is the "one observable": every converted spec still green across the full 3×3.
5. qa-verify persona (read-only, worktree path attached) may verify the evidence — baseline vs
   post-change matrix, that no spec was weakened to green (e.g. a converted assertion that no longer
   asserts presence). Findings recorded.
6. Version bump for #62: **propose patch `v1.62.2`** ("no user-facing change" CHANGELOG entry, per
   the test-infra-still-bumps rule) — *confirm the level with the operator at bump time* (versioning
   rule). Bump with `npm version 1.62.2 --no-git-tag-version`; run `npm run build`; commit rebuilt
   `dist/index.html` + `src/lib/changelog.js` + CHANGELOG in the bump commit (stale-dist guard).
7. #63: read `test/e2e/harness.mjs`, `run-matrix.mjs`, `e2e-container.mjs`/`run.mjs`, mock-server
   wiring; write the evaluation to `docs/superpowers/plans/e2e-runner-migration-evaluation-2026-09-15.md`
   (cost, what must be preserved — in-repo mock S3, containerised 3×3, E2E Evidence Rules, CI ↔
   locked-playwright-version lockstep guard — and a clear recommendation). **Design must-stop.**

## 4. Checkpoints (only these)

- **#62 ship:** operator ff-merges `feature/e2e-robustness` → `main` (or grants `merge_prod_branches:
  main`) after reviewing the branch pipeline + QA note. Prod deploy.
- **#63 design must-stop:** operator reads the evaluation and rules go/no-go on the migration. The
  migration itself is out of this run's autonomous scope.
- Never autonomous: merging to `main` (prod) absent a grant; closing issues; prod/env/secrets.

## 5. Resumability (cold session picks up here)

Read: this runbook → issues #62/#63 state and notes → the branch + its pipeline → the QA note /
evaluation doc if started → re-enter §3 on the next unfinished step. Baseline result is recorded in
the run's worktree / issue note.

## 6. Envelope

Lives at `.claude-scratch/runs/e2e-robustness/run-envelope.md` (written separately, no `confirmed:`
line until the operator hands off).

## 7. Debrief (last step, `e2e-robustness-debrief-2026-09-15.md`)

Baseline + post-change matrix results (image tag, versions, counts); #62 shipped version; #63
recommendation + the must-stop outcome; every merge + grant change; guard blocks; planned vs
shipped; hours / operator touches / rough tokens; lessons → `milestone-orchestration-mode.md` +
run-log row.
