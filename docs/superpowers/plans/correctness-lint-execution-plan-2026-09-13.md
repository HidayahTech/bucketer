# Autonomous run — Correctness-lint slice (degree ②, execution plan 2026-09-13)

Operator-directed next degree after the v1.60.0 dead-code gate. From the 2026-09-13
"what should the tooling enforce?" ladder: ① dead code + unused (shipped v1.60.0),
② **dead code + linting** (this run — the *correctness-only* slice), ③ full optimal sweep
(lint + complexity + formatting + dep hygiene — deferred). This run adds a **correctness-only
linter gate** — the bug-catchers, not style/formatting/complexity.

**Repo fit:** bucketer ships a committed static bundle (Forge serves it); no per-MR preview.
Safety net = pre-push hook + CI guards + the existing dead-code gate. Small, well-scoped
addition. ff-merge to main (operator's established preference across the last two runs), no MR.

## 1. Scope

- Add a **correctness-focused linter** to the quality pipeline: flags real defects
  (unused/undeclared vars, unreachable code, invalid regex, `==` foot-guns, self-compare,
  duplicate keys/cases, etc.) across `src/`. Explicitly **NOT** style/formatting rules, NOT
  cyclomatic complexity — those are degree ③, a separate proposal.
- Reality: the repo has **no lint config today**, ~133 source files, vanilla JS/JSX (Preact,
  no TS). First run volume is unknown → a **design must-stop** brings the real count before any
  fix/baseline decision.
- Wire it into the gates **mirroring the dead-code gate**: pre-push **advisory** during a
  bake-in period + a **blocking CI job**; a **ratchet baseline** for pre-existing violations so
  it's green day-one with real teeth. Fix what's cheap and real; baseline the rest with reasons.
- Dependency order: single coherent change. No carve-outs.

## 2. Execution mode

- Integration branch `feature/correctness-lint` off `origin/main`, private worktree under
  `.claude-scratch/`. Never switch the shared checkout's branch.
- Solo investigation (no persona panel — the linter landscape is well-understood; blow-up guard).
- **Fast-forward merge to `main`, no MR** (operator choice, consistent with the last two runs).
  Feature branch stays local; only `main` is pushed, once, at the end (gated on the bump confirm).
- Per-item commits. Full suite locally before the final push; never `--no-verify`.

## 3. Design must-stop (before implementing across 133 files)

After a brief solo trial in the worktree (install the candidate linter, run it, read the
output), STOP and bring the operator, in one message:
1. **Chosen tool** + why (see §4 recommendation) — operator may override.
2. **Exact rule set** enabled (the correctness category; the specific rules).
3. **Violation count + a sample** — the real blast radius.
4. **Fix-vs-baseline plan** — which violations are trivially/safely fixable now vs. baselined
   (with reasons) to keep the gate green without a risky mass edit.
5. **Gate placement** confirmation (pre-push advisory + CI blocking).
Only after approval: fix/baseline + wire the gate.

## 4. Design decisions (session choices — operator may override at handoff or the design gate)

- **T1 (session choice, recommend): tool = `oxlint`.** Rust-based, very fast, **zero-config**,
  correctness-category rules out of the box, **no formatter baggage** (keeps us strictly in
  degree ②, not ③), JSX-aware, deterministic when version-pinned, installs on `node:20-alpine`
  like knip/esbuild. Alternatives: **Biome** (also fast but is a linter+formatter → scope-creep
  pull toward ③; needs `biome.json`); **ESLint** (most capable/mature but heaviest — flat config
  + Preact/JSX plugins, slower). Recommendation stands unless the trial surfaces a blocker.
- **T2 (session choice): rules = correctness category only.** No `style`/`suspicious`-as-style,
  no complexity, no formatting. The bug-catchers only.
- **T3 (session choice): baseline = ratchet**, same idiom as `deadcode-baseline.json`
  (oxlint supports disable-directives/ignore; prefer a committed baseline + a schema/guard test
  consistent with `source-invariants`). Fix trivially-safe violations, baseline the rest with a
  reason enum. Exact mechanism decided at the design gate once the count is known.
- **T4 (session choice): gate = pre-push advisory (bake-in) + blocking CI job**, mirroring
  `deadcode`. Pin the tool version **exact** with a range-drift guard (heuristics shift between
  minors), same as knip/purgecss.
- **T5 (session choice): investigation = solo**, not a panel (cost). Offer a panel only if the
  operator wants more rigor.
- **Version (confirm at end):** likely **minor** (new quality-gate capability, like the dead-code
  gate v1.60.0) — but confirmed with the operator per the versioning rule before bumping.

## 5. Resumability

Read: this runbook → the branch state + the design-gate decision (recorded in a commit/notes) →
re-enter §3/§4. Single-branch, per-item commits checkpoint it.

## 6. Envelope

See `.claude-scratch/run-envelope.md` (written alongside, unconfirmed until handoff).

## 7. Debrief (last step)

File `docs/superpowers/plans/correctness-lint-debrief-2026-09-13.md`; append a run-log row +
lessons to `milestone-orchestration-mode.md` in the knowledge repo (Tier 2); send the operator
the release + live note + debrief path.
