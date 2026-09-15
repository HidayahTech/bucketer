# Autonomous run — ③(b): formatter + format-check gate (execution plan, 2026-09-15)

The largest rung of the code-quality ladder: ① dead-code (v1.60.0) → ② correctness-lint
(v1.61.0) → ③(a) audit + guardrails (v1.61.1) → **③(b)** a **code formatter** with a
format-check gate. This is the one that reformats nearly every source file — a one-time
whole-repo diff, then a cheap ongoing check. Deferred to ③(c): complexity-advisory.

**Repo fit:** static committed bundle, no per-MR preview; ff-merge to main (operator preference,
all prior runs). Safety net = pre-push hook + CI guards + the ①/②/③a gates.

**Blast radius: higher than any prior run.** Every first-party JS/JSX (and possibly CSS/JSON)
file is rewritten. Two invariants make it safe: (a) formatters are AST-preserving — no behaviour
change; (b) **the shipped bundle must be byte-identical** after the reformat (esbuild reparses +
minifies, so source whitespace never reaches `dist/index.html`). Both are verified at the design
gate and by the full suite + container e2e before merge.

## 1. Scope

- Add a **formatter** (see §4 recommendation) with config **matched to the codebase's existing
  dominant style** (quotes, semicolons, print width, commas) so the diff is reformatting, not a
  style-opinion imposition.
- One-time **whole-repo reformat** of first-party sources; scope (src only vs src+test+scripts+
  root .mjs vs also CSS/JSON) decided at the design gate from the actual diff.
- A **`format:check` gate**: blocking CI job + advisory pre-push step, mirroring the lint/deadcode
  gates. Formatter pinned **exact** with a range-drift guard.
- A **`.git-blame-ignore-revs`** file listing the reformat commit so `git blame` skips it (+ a
  note to configure `blame.ignoreRevsFile` locally / GitLab honours it automatically).
- NOT in scope: style/complexity lint rules (③c), any behavioural change.

## 2. Execution mode

- Integration branch `feature/formatter` off `origin/main`, private worktree under
  `.claude-scratch/`. Solo (mechanical; verified by parity, no persona panel).
- Fast-forward merge to `main`, no MR. Feature branch local; only `main` pushed once, at the end,
  gated on the version-bump confirmation.
- Commits: (1) tooling + config + gate + guard test; (2) the whole-repo reformat as its **own
  isolated commit** (so it's the single SHA in `.git-blame-ignore-revs`); (3) the version bump.
- Full suite locally before the final push; never `--no-verify`.

## 3. Design must-stop (before committing the whole-repo reformat)

After installing the formatter, writing the config matched to existing style, and running it in
the worktree, STOP and bring the operator, in one message:
1. **Chosen formatter** + why (operator may override).
2. **Config**, and how it was matched to the existing style (the specific settings + how they
   were derived — minimise churn).
3. **Diff size** — files changed, insertions/deletions — the real blast radius.
4. **Bundle byte-identity proof** — `dist/index.html` rebuilt from the reformatted source is
   byte-identical to the pre-reformat build (the reproducibility invariant holds).
5. **Scope** confirmation (which trees) + the `.git-blame-ignore-revs` plan.
Only after approval: commit the reformat + wire the gate.

## 4. Design decisions (session choices — operator may override at handoff or the design gate)

- **F1 (session choice, recommend): formatter = Prettier**, exact-pinned. Mature, universal,
  handles JS/JSX (+ CSS/JSON/MD if we widen scope), config maps cleanly to the existing style.
  Alternatives weighed at the design gate: **Biome format** (fast Rust, but we deliberately chose
  oxlint over Biome for linting to avoid tool overlap — using Biome only-as-formatter is viable
  but adds a second Rust toolchain); **oxc formatter** (ideologically consistent with oxlint, but
  I'll only recommend it if it's production-stable at gate time — otherwise Prettier). If the
  trial shows Prettier fights the codebase's style in a way config can't fix, I'll say so.
- **F2 (session choice): config matched to existing dominant style**, derived at the gate
  (detect the prevailing quote/semicolon/width/comma conventions; pick settings that minimise the
  diff). No opinion imposition beyond what consistency requires.
- **F3 (session choice): reformat scope = all first-party JS/JSX** (src, test, scripts, root
  .mjs, build.mjs) to start; extend to CSS/JSON only if clean. Confirmed at the gate from the diff.
- **F4 (session choice): gate = blocking CI `format` job + advisory pre-push**, exact-pin + range
  guard, mirroring lint/deadcode. `.git-blame-ignore-revs` for the reformat SHA.
- **Version (confirm at end): minor** (new gate + notable whole-repo change), like ② — confirmed
  with the operator per the versioning rule before bumping.

## 5. Resumability

Read: this runbook → branch state (tooling commit ± reformat commit) → the design-gate decision
(in a commit/notes) → re-enter §3/§4. Per-commit checkpoints (tooling, reformat, bump) isolate it.

## 6. Envelope

See `.claude-scratch/run-envelope.md` (written alongside, unconfirmed until handoff).

## 7. Debrief (last step)

File `docs/superpowers/plans/formatter-debrief-2026-09-15.md`; append a run-log row + lessons to
`milestone-orchestration-mode.md` in the knowledge repo (Tier 2); send the operator the release +
live note + debrief path.
