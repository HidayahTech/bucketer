# Autonomous run — ③(c): complexity advisory (execution plan, 2026-09-15)

The final rung of the code-quality ladder: ① dead-code (v1.60.0) → ② correctness-lint (v1.61.0)
→ ③(a) audit + guardrails (v1.61.1) → ③(b) formatter (v1.62.0) → **③(c)** a **complexity
advisory**. This is a *signal*, not a gate: it flags over-branchy functions as refactor
candidates without ever blocking a push or forcing a refactor.

**Repo fit:** static committed bundle, no per-MR preview; ff-merge to main (operator preference,
all prior runs). Safety net = pre-push hook + CI guards + the ①/②/③a/③b gates. Small addition.

## 1. Scope

- Add a **cyclomatic-complexity advisory** over `src/`, reusing **oxlint** (no new dependency):
  its `complexity` rule with a threshold. Reports functions above the threshold as refactor
  candidates. **NON-blocking** — a dedicated advisory CI job (`allow_failure`, like `audit`), NOT
  the blocking `lint` job, so complexity creep is *visible* but never gates a push.
- **No source changes.** This run surfaces the signal; actually refactoring flagged functions is
  a deliberate, separate effort. Empty-baseline-style: the advisory just reports.
- NOT in scope: making complexity blocking; other max-* metrics (max-depth/params/lines) unless
  the design gate finds them clearly valuable; any refactor.

## 2. Execution mode

- Integration branch `feature/complexity-advisory` off `origin/main`, private worktree under
  `.claude-scratch/`. Solo. Fast-forward merge to `main`, no MR.
- Since no product source changes, no container e2e is needed (the pre-push hook + CI still run
  it); any incidental source edit would trigger the full lane set.
- Full suite locally before the final push; never `--no-verify`.

## 3. Design must-stop (before wiring the advisory)

After running oxlint's complexity rule at a candidate threshold in the worktree, STOP and bring
the operator, in one message:
1. **The complexity distribution** — how many `src/` functions exceed the candidate threshold, and
   the list of the worst offenders (expected: Browser.jsx, UploadQueue.jsx, etc.).
2. **The chosen threshold** — set so it flags the genuine outliers, not routine functions.
3. **Advisory placement** confirmation (dedicated `allow_failure` CI job; NOT the blocking lint
   job; NOT the pre-push hook, or advisory-only if included).
Only after approval: wire the advisory job + report script.

## 4. Design decisions (session choices — operator may override at handoff or the design gate)

- **C1 (session choice): reuse oxlint's `complexity` (cyclomatic) rule** — no new dependency,
  same toolchain. A dedicated advisory invocation (not folded into the blocking `lint` config, so
  it can't accidentally block).
- **C2 (session choice): NON-blocking** — a dedicated CI `complexity` job with `allow_failure: true`
  (yellow, never reds the pipeline), CI-only (not in the pre-push hook, to avoid noise on every
  push). `complexity` npm script + a guard test keeping the job advisory (mirrors the `audit` guard).
- **C3 (session choice): threshold** derived at the design gate from the actual distribution
  (flag the real outliers, ~top handful, not routine code).
- **C4 (session choice): cyclomatic only** to start; add max-depth/params/lines only if the gate
  shows clear value.
- **Version (confirm at end): patch** (CI/config only, no source change — like ③(a) v1.61.1), or
  no bump; confirmed with the operator per the versioning rule.

## 5. Resumability

Read: this runbook → branch state → the design-gate decision (threshold, in a commit/notes) →
re-enter §3/§4. Single branch, per-item commits.

## 6. Envelope

See `.claude-scratch/run-envelope.md` (written alongside, unconfirmed until handoff).

## 7. Debrief (last step)

File `docs/superpowers/plans/complexity-advisory-debrief-2026-09-15.md`; append a run-log row +
lessons to `milestone-orchestration-mode.md` in the knowledge repo (Tier 2); send the operator the
release + live note + debrief path. Note in the debrief that this completes the ladder (①–③).
