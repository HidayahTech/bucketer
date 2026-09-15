# Debrief — ③(c) complexity advisory (2026-09-15)

Runbook: `docs/superpowers/plans/complexity-advisory-execution-plan-2026-09-15.md`.
Shipped as **v1.62.1** (fast-forward to main, commit `3a875da`). **This completes the
code-quality ladder** (①–③).

## Planned vs shipped

Shipped exactly as scoped — a non-blocking complexity signal, no refactors, no source changes.

- **Cyclomatic-complexity advisory** reusing oxlint (no new dependency): `.oxlintrc.complexity.json`
  runs only the `complexity` rule at **warn-level, threshold 20** (correctness off, so the output
  is purely the complexity list). `complexity` npm script.
- **Dedicated non-blocking CI `complexity` job** (`allow_failure`, CI-only) prints the **27**
  functions over threshold as a refactor-candidate list. Warn-level exits 0 → a **green
  informational report**, not a permanent yellow (there are always findings until the big
  components are refactored); `allow_failure` guards against a future severity bump ever blocking.
- Guard test keeps the job advisory (mirrors the `audit` guard).
- **Threshold 20** chosen by the operator at the design gate (from the distribution: 74@10,
  41@15, 27@20, 17@25, 13@30).

**The refactor-candidate list** (the value this run surfaces): Browser.jsx (67), DownloadJobPanel
(57), MasterQueue (53), App (49), BatchSummary (45), UploadQueue (40, and 34), HiddenVersions (39),
move-queue (38), CredentialForm (34 ×2), then a 20–32 band. Refactoring these is a deliberate,
separate effort — deliberately NOT forced by this gate.

## Design decision worth recording

- **Warn-level (green report) over error+allow_failure (permanent yellow).** The `audit` advisory
  is normally green (0 findings) and yellows only on a finding; complexity *always* has findings,
  so an error+allow_failure job would be permanently yellow → yellow-fatigue, ignored. Warn-level
  makes it a green job whose log is the current complexity report — a reference, not a nag —
  while `allow_failure` still guards a future severity bump. Flagged for the operator; trivial to
  switch to a yellow nudge if preferred.

## Verification

- `npm run complexity`: exits 0 (green), prints the 27-function list.
- 1580 unit + 551 component green; the new advisory-guard test passes; lint/deadcode/format:check
  clean. No `src/` touched (CI + config + one test only), so no separate container e2e (the
  pre-push hook + CI run it regardless).
- CI main pipeline #2851652043 (v1.62.1): **success.** The new advisory `complexity` job rendered
  **green** (the warn-level informational report, as designed — not a yellow nag); all other gates
  green; zero flakes this run. (The pipeline sat in a GitLab shared-runner queue for ~10 min before
  starting — backlog, not a problem.)
- Live-verify: https://bucketer.hidayahtech.net/ serves `build-id`/`app-version` = **1.62.1**.
- Harness fidelity: the job's advisory (`allow_failure`) behaviour is a GitLab-runtime property;
  the guard test is its durable local substitute.

## Wall-clock / touches / cost

- Wall-clock: ~40 min (threshold sweep + wiring + suite + CI). Operator touches: 4 (start;
  handoff; threshold; bump). Subagents: 0 (solo). Token cost: modest.

## The ladder is complete

① dead-code (v1.60.0) · ② correctness-lint (v1.61.0) · ③(a) audit + guardrails (v1.61.1) ·
③(b) formatter (v1.62.0) · ③(c) complexity advisory (v1.62.1). Six releases across the arc
(with the e2e-flake hardening v1.60.1 alongside). Remaining backlog beyond the ladder: the e2e
harness deep-fixes (#3 = source-side hand-rolled-deadline audit, #4 = Playwright Test runner),
and actually refactoring the high-complexity components the advisory now lists.

## Lessons (→ milestone-orchestration-mode.md)

- **For an always-finding advisory, prefer a green log-report over permanent yellow.** allow_failure
  is right for a normally-clean check (audit); a check that always has findings (complexity) should
  be warn-level/green so it's a reference, not yellow-fatigue — keep allow_failure only as the
  guard against a future severity bump.
- **A dedicated config (`-c`) keeps an advisory's output clean.** Running oxlint's complexity rule
  with correctness off (separate from the blocking `lint` config) makes the job log purely the
  refactor-candidate list, not a mix with the correctness gate.
