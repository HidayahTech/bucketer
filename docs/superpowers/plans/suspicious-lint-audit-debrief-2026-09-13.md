# Debrief — ③(a) suspicious-lint + npm audit advisory (2026-09-13/14)

Runbook: `docs/superpowers/plans/suspicious-lint-audit-execution-plan-2026-09-13.md`.
Shipped as **v1.61.1** (fast-forward to main, commit `95d3d61`).

## Planned vs shipped

The plan was "suspicious-lint + npm audit." The design-gate investigation reshaped it: the
`suspicious` half was **investigated and deliberately dropped**, replaced by a narrow, clean
guardrail cherry-pick (operator chose "audit + cherry-pick" at the gate).

- **npm audit advisory:** a **non-blocking** (`allow_failure`) CI `audit` job, production scope
  (`--omit=dev`), reading the lockfile directly (no `npm ci`). `audit` npm script + a
  source-invariant guard that keeps the job non-blocking. **0 vulnerabilities** today.
- **oxlint guardrails:** 5 genuine bug-catcher rules enabled beyond the correctness category —
  `no-self-compare`, `no-template-curly-in-string`, `no-constant-binary-expression`,
  `no-unsafe-negation`, `no-unreachable-loop` — **all 0 findings** today (empty baseline holds,
  no churn, pure forward protection).
- **`suspicious` category — investigated, NOT adopted.** 103 findings, **zero real bugs**:
  52 `no-underscore-dangle` (fights the codebase's `_`-prefix convention), 23
  `prefer-add-event-listener` + 8 `consistent-function-scoping` (style/perf), 11
  `require-post-message-target-origin` (**false positives** — Web Worker `postMessage` takes no
  `targetOrigin`), 6 `no-array-sort` + 1 `no-array-reverse` (would need `toSorted`/`toReversed`,
  which are ES2023 and beyond the project's `es2020` esbuild target; and every flagged site
  already sorts a defensive copy), 2 `no-new` (validation-by-construction). Poor value/noise, so
  not enabled — the design must-stop earned its keep here.

No `src/` was touched — CI + config + one test only.

## Verification

- oxlint clean (guardrails: 0 findings); `npm audit --omit=dev`: 0 vulnerabilities.
- **Full local suite passed via the pre-push hook** (build + 1578 unit + 551 component + all
  e2e layers) — the push completed exit 0, which the hook only allows on a green suite.
- No container e2e run separately: no product source changed (the pre-push hook's e2e layer +
  CI cover it).
- **Live-verify:** https://bucketer.hidayahtech.net/ serves `build-id`/`app-version` = **1.61.1**.
- **CI pipeline: UNVERIFIED** — glab's OAuth grant (and its stored token) expired mid-run
  (`invalid_grant`), so the cloud pipeline for `95d3d61` (incl. the new advisory `audit` job and
  the lint job with the added guardrails) could not be polled. The local full-suite pass + the
  live deploy are the evidence on hand; CI confirmation is pending `glab auth login`. Honesty
  note per the postmortem rules: do not read this as "CI green" — it is "CI not checked."
- Harness fidelity: the `audit` job's advisory (`allow_failure`) behaviour is a GitLab-runtime
  property; the source-invariant guard is its durable local substitute.

## Wall-clock / touches / cost

- Wall-clock: ~1 h (design-gate investigation dominated; near-zero implementation since 0 findings).
- Operator touches: 4 (start; handoff yes; design-gate direction; bump level).
- Subagents: 0 (solo).
- Token cost: modest.

## Guard blocks

- None from the run-envelope guard. External blocker: glab OAuth expiry stopped CI polling
  (not a guard, a credential lapse).

## Lessons (→ milestone-orchestration-mode.md)

- **A design must-stop can turn a planned feature into a "don't ship it."** The `suspicious`
  category sounded valuable but investigation showed 103 findings / 0 bugs for this codebase;
  the gate meant we didn't churn 103 non-bugs. Trial before you commit, and be willing to report
  "the thing you asked for isn't worth it — here's the evidence."
- **Target constraints kill "obvious" fixes.** `no-array-sort` → `toSorted()` looked clean until
  the `es2020` esbuild target ruled out the ES2023 method. Check the runtime baseline before
  proposing an API swap.
- **Prefer 0-finding forward guardrails when adding lint rules to a mature codebase** — real
  bug-catchers that don't currently fire add protection with no churn and no baseline growth.
- **glab OAuth can expire mid-session;** git push (SSH) keeps working but CI polling dies. Live
  deploy + the local pre-push full-suite are the fallback evidence; flag CI as unverified rather
  than assuming green.
