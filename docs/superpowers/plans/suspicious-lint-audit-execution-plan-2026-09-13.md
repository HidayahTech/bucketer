# Autonomous run — ③(a): suspicious-lint + npm audit advisory (execution plan, 2026-09-13)

Next slice of the code-quality ladder: ① dead-code (v1.60.0) → ② correctness-lint (v1.61.0) →
**③(a)** the highest-value-per-effort part of the "full sweep" (degree ③): add oxlint's
**`suspicious`** category (bug-adjacent patterns) on top of correctness, and a **non-blocking
`npm audit`** advisory for known-CVE dependencies. Deferred to later ③ slices: a formatter
(③b), complexity thresholds (③c), broader `style`/`pedantic` lint. Type coverage is separate.

**Repo fit:** static committed bundle, no per-MR preview; ff-merge to main (operator preference,
last three runs). Safety net = pre-push hook + CI guards + the ①/② gates. Small addition.

## 1. Scope

- **(i) Suspicious-lint.** Enable oxlint's `suspicious` category in `.oxlintrc.json` (alongside
  the existing `correctness`). It catches bug-adjacent code the correctness set doesn't — e.g.
  floating/un-awaited promises (real risk in the async S3 paths), `await`-in-loop, accidental
  fallthrough, debugger/console leftovers. Fix or reason-baseline the findings.
- **(ii) npm audit advisory.** Add a **non-blocking** CI check reporting known-CVE dependencies
  (`npm audit`). Advisory by design: a new transitive CVE must NOT block every push until fixed;
  it's a security *signal*, triaged deliberately, not a gate.
- Explicitly NOT in this slice: formatter/reformat (③b), complexity gate (③c), `style`/`pedantic`
  lint categories, license checks. One coherent, small change.

## 2. Execution mode

- Integration branch `feature/suspicious-lint-audit` off `origin/main`, private worktree under
  `.claude-scratch/`. Never switch the shared checkout's branch.
- Solo (no panel). Fast-forward merge to `main`, no MR. Feature branch stays local; only `main`
  is pushed once, at the end, gated on the version-bump confirmation.
- Per-item commits. Full suite locally before the final push; never `--no-verify`.

## 3. Design must-stop (before editing source / wiring gates)

After enabling `suspicious` and running oxlint + `npm audit` in the worktree, STOP and bring the
operator, in one message:
1. **Suspicious-lint violation count + a sample**, and whether it stays **blocking** (added to the
   existing `lint` job) or drops to **advisory** if the volume/FP-rate is high.
2. **Fix-vs-baseline plan** for the suspicious findings (fix the clear ones; reason-baseline any
   deliberate patterns — e.g. an intentional fire-and-forget).
3. **`npm audit` current findings** (count by severity) + confirmation of the advisory,
   non-blocking handling.
Only after approval: fix/baseline + wire the gates.

## 4. Design decisions (session choices — operator may override at handoff or the design gate)

- **S1 (session choice): add `suspicious` to the same blocking `lint` job**, pending the count at
  the design gate — if it's large/noisy, downgrade `suspicious` to a separate advisory step and
  keep only `correctness` blocking. Correctness stays blocking regardless.
- **S2 (session choice): `npm audit` is advisory/non-blocking** — a dedicated CI job with
  `allow_failure: true` (yellow, never reds the pipeline), **CI-only** (not added to the pre-push
  hook, to avoid a network call + latency on every push). Prod-dependency scope where practical
  (`--omit=dev` or `--production`) so dev-tool CVEs don't create noise.
- **S3 (session choice): baseline mechanism** = oxlint inline-disable-with-reason for the few
  deliberate suspicious patterns (consistent with ②'s empty-baseline approach), decided per-item
  at the design gate once the count is known.
- **S4 (session choice): solo**, no panel.
- **Version (confirm at end):** likely **minor** (extends the quality gate, like ② v1.61.0) — but
  confirmed with the operator per the versioning rule before bumping. Could be patch if the change
  is tiny.

## 5. Resumability

Read: this runbook → the branch state + the design-gate decision (in a commit/notes) → re-enter
§3/§4. Single branch, per-item commits checkpoint it.

## 6. Envelope

See `.claude-scratch/run-envelope.md` (written alongside, unconfirmed until handoff).

## 7. Debrief (last step)

File `docs/superpowers/plans/suspicious-lint-audit-debrief-2026-09-13.md`; append a run-log row +
lessons to `milestone-orchestration-mode.md` in the knowledge repo (Tier 2); send the operator the
release + live note + debrief path.
