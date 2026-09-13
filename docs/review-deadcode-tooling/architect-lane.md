# Dead-code tooling — Architect lane (SCOPE & COHERENCE)

Panel: deterministic dead-code / unused-code tooling for `bucketer`. Operator-fixed
scope: unused **files / exports / deps / CSS classes** only (not lint/style).
This lane answers shape, fleet-scope, and scope-flex. It does **not** pick the
concrete tool (frontend lane), CI-vs-pre-push placement (infra lane), or
blocking/baseline policy (qa lane).

Sources read: `test/source-invariants.test.js`, `build.mjs`, `.githooks/pre-push`,
`.gitlab-ci.yml`, `package.json`; fleet `repo-baseline.md` and
`standards-vs-happenstance.md` (both `~/dev/hidayahtech-knowledge/hidayahtech/`).

---

## 1. Recommendation (lead)

- **Shape: standalone reachability tool, sited inside the existing suite — NOT
  the source-invariants idiom.** Dead-code detection is whole-import-graph
  reachability analysis; it cannot be expressed as bespoke per-symbol regex
  guards without re-implementing a module-graph resolver badly. The
  source-invariants idiom does the *opposite* job — it asserts the *presence* of
  required semantic code — and must be left untouched. So this is not a "which
  idiom" fork; the two cover disjoint domains. Add one pinned dev dependency +
  one curated config + one `npm` script wired into the gate the infra lane
  chooses. No new test runner.
- **Fleet scope: pilot in bucketer, then propose to the baseline as a §8
  watch-item — NOT baseline-now, NOT bucketer-only-forever.** A fleet dead-code
  standard fails the evidence test today (no provenance, no direction-of-travel).
  Prove it here first; graduate it the way the fleet graduates every standard.
- **Scope verdict: hold the line at dead/unused. One rider is in-scope, not a
  flex — unused *imports***, which is the same "unused code" family the tool
  reports for free. Everything else the operator excluded (formatting, naming,
  complexity, style lint) stays out.

The one framing that must travel with this to the other lanes: on a single-file
esbuild bundle, **dead code already tree-shakes out of the shipped artifact**, and
the `build.mjs` size tripwire already guards accidental bloat. So this gate buys
**source-tree legibility and an honest dependency manifest**, not production
safety. That is a real but lower-stakes value than the existing preventive
invariants — which is exactly why pilot-then-propose (not baseline-now) is the
calibrated call, and it informs the qa lane's severity/blocking decision.

---

## 2. Approaches (architecture level)

**A — Standalone reachability tool (knip-class), gated in the existing suite.**
One config declares entrypoints; the tool walks the import graph and reports
unreachable files, unused exports, unused deps, unused CSS. Covers all four
operator categories in one deterministic runner.
*For:* the only shape that actually expresses "all unused exports" — a global
graph property, not a local one. Extends a pattern the fleet already trusts
(pinned dev tooling with a version-lockstep guard — the Playwright image ⇔
locked-version test). Runs locally with the same command as CI (satisfies
baseline §4 light-parity).
*Against:* a new dependency (burden of proof) and a real config surface that must
be curated and maintained — see the entrypoint risk in §6.

**B — Extend the source-invariants unit-test idiom.**
Hand-write `node:test` guards for dead code in `test/source-invariants.test.js`.
*For:* zero new dependency; runs in the existing `npm test`; the idiom is trusted.
*Against:* category error. "All unused exports / unreachable files" is a
reachability question over the whole module graph; a regex per symbol cannot
answer it, and enumerating every export by hand is both unbounded and instantly
stale. You would be writing a worse knip inside a test file. **Rejected as the
primary mechanism.**

**C — Hybrid: tool for breadth, source-invariants kept for the bug-specific
semantic guards.**
*For:* recognizes the domains are disjoint and assigns each to the right
mechanism — the tool owns unused files/exports/deps/CSS; source-invariants keeps
owning presence-of-required-code guards (try/catch present, `MAX_DISPLAY ≤ 500`,
required hook imported). No migration of existing tests.
*Against:* none of substance — this is simply A stated honestly, plus an explicit
"do not fold dead-code into source-invariants and do not migrate existing
invariants into the tool."

**Recommendation: C (which is A + a hands-off rule for source-invariants).** The
"new dependency" burden of proof is met: (a) reachability genuinely cannot be done
in the unit-test idiom, and (b) the fleet already accepts a pinned dev tool with a
lockstep guard, so a pinned dead-code tool with the same lockstep is *extending a
proven pattern*, not inventing one — which is the tie-breaker the "prefer boring"
discipline asks for.

---

## 3. Coherence check (no duplication, no contradiction)

The repo already has three distinct mechanical layers; the dead-code tool is a
fourth, disjoint one:

| Layer | Question it answers | Locus |
|---|---|---|
| `build.mjs` invariants | Is the *build output* structurally correct? (CHANGELOG⇔version lockstep, meta-tag byte boundary, size tripwire, no sourcemap leak, worker inlined) | build-time assertion |
| `source-invariants.test.js` | Is *required semantic code present* in source? (bug-derived presence guards) | unit test |
| stale-dist + reproducibility CI | Does the committed bundle match a fresh build, deterministically? | CI |
| **dead-code tool (proposed)** | Is any source *unreachable / unused*? | new check, existing runner |

No overlap: the first three assert **presence / correctness / determinism**; the
new one asserts **absence of the unused**. The nearest neighbours are `T1-2` ("a
used `XCommand` must be imported") and `BUG-014` ("a required hook must be
imported") — both guard *undefined* references (used-but-not-imported), the
*inverse* of unused-but-present, so they don't collide either. The size tripwire
guards shipped bytes; the dead-code tool guards the source tree — different
artifacts. Coherence holds cleanly. The only rule that must be written down: the
dead-code tool never absorbs a source-invariant, and no existing invariant
migrates into it.

Placement note for the infra/qa lanes (not my call): the pre-push hook is already
heavy (build + unit + component + e2e). Where this check runs, and whether it
blocks, is theirs — I only note that light-parity (§4) requires it be one plain
`npm` script runnable identically locally and in CI.

---

## 4. Fleet call (standards-vs-happenstance evidence test)

Applying the test from `standards-vs-happenstance.md` to "should this be a fleet
repo-baseline standard?":

- **Provenance — FAIL.** No decision record, no milestone, no existing fleet
  dead-code standard. Baseline §8 watch-items (the fleet's on-ramp for
  candidate rules) do not list dead-code tooling. There is nothing to cite.
- **Direction of travel — FAIL.** No in-progress migration toward dead-code gates
  anywhere in the fleet. bucketer would be the first adopter, not a laggard
  catching up to a destination.
- **Scope — bucketer-local.** A deliberate choice here is a standard *here*. The
  other JS frontends (adventlorer, websites) differ in shape — a mostly-static
  site has little export graph to police — so this does not auto-apply. Suggest
  it where a repo's shape maps cleanly onto it; don't impose.

Verdict: a fleet standard is **not earned today**. But bucketer-only-forever
under-serves the fleet if the gate proves its worth. The calibrated path is the
one the fleet already uses to promote things: **pilot in bucketer, and after a few
release cycles of it earning its keep (few false positives, real catches), file it
as a baseline §8 watch-item with a short rationale**, exactly as autonomous-run
mode graduated from watch-item to rule "once the run log has several rows." That
keeps the promotion evidence-based and reversible, and honors "prefer boring —
new patterns carry a burden of proof."

---

## 5. Scope verdict (hold vs. flex)

**Hold the operator's line at dead/unused — with one in-family rider, not a flex.**

- **In scope, and correct as fixed:** unused files, unused exports, unused deps,
  unused CSS classes. These are one coherent reachability family, and a
  knip-class tool reports them together. Good boundary.
- **Rides along, same family — recommend accepting: unused imports.** An import
  that is never used is unused code by definition; it is not lint/style, and the
  tool surfaces it for free. Including it is honoring the operator's scope, not
  widening it. (Flag it as a one-line choice, per default-then-flag.)
- **Hold the exclusion of everything else the operator named:** formatting,
  naming, cyclomatic complexity, stylistic lint. Those are a *different tool
  class* (ESLint/Biome), a *different value* (style consistency, not dead code),
  and a *much larger config-and-argument surface*. Pulling them in now would add
  a second, much noisier way to gate source — precisely the "second way to do
  something" the discipline says to flag. The dead/unused boundary is the right
  architectural seam; keep it.

Advice, not override: if a broader lint gate is ever wanted, it is its own
proposal with its own cost case — do not let it ride in on this one.

---

## 6. Open risks / unverified

1. **Entrypoint config is the whole ballgame (top risk).** This repo has
   reachability edges a naive graph walk will get wrong and false-positive on:
   - `src/worker/zip-assembler.worker.js` is a **separate esbuild entrypoint wired
     by string substitution** (`build.mjs` bundles it and injects it via the
     `'__WORKER_SRC__'` placeholder in `assembler-worker-url.js`) — it is *not*
     reached through the `src/main.jsx` import graph. A tool will call it "unused"
     unless it is declared an entrypoint.
   - Non-graph entrypoints that must be declared: `build.mjs`, `serve.mjs`,
     `scripts/*.mjs` (release, e2e-container, backfill/verify-integrity),
     `perf/*.mjs`, and the test trees (`test/*.test.js`, `test/components/*.test.jsx`,
     `test/e2e/**`).
   - `src/lib/changelog.js` is **@generated** by `build.mjs`; its unused-export
     profile will look odd and should likely be excluded from the export scan.
   A mis-curated config produces false positives, which produce ignore-fatigue,
   which silently voids the gate. The config's correctness is itself worth a small
   guard or a documented review step. (This risk is why the *shape* decision is
   easy but the *rollout* is not — it belongs in the infra/frontend lanes' care.)

2. **Determinism across environments — verify before it can gate.** The
   reproducibility job depends on byte-identical builds; a dead-code tool that
   varies its findings by Node version, OS, or its own patch version would
   undermine that ethos. The fleet's answer already exists (pin the tool, add a
   version-lockstep guard mirroring the Playwright-image test) — but that the
   chosen tool *is* deterministic given pinned inputs is a frontend-lane
   verification, not something I confirmed.

3. **CSS-class detection fidelity is unverified.** Bucketer's CSS is a single
   hand-authored `src/styles/main.css` and classes are referenced as string
   literals in JSX (`class="..."`, template strings, conditional joins). Whether a
   given tool tracks class usage accurately through those patterns — vs.
   flagging dynamically-composed class names as unused — is unconfirmed and is
   the category most prone to false positives. The frontend lane should probe this
   specifically before CSS-class detection is allowed to block.

4. **Value framing must reach the qa lane.** Because dead code tree-shakes out of
   the single-file artifact and the size tripwire already guards bloat, this is a
   *developer-hygiene* gate, not a *ship-safety* gate. If the qa lane weighs
   blocking severity, that framing (not mine to decide) is the input it needs.
