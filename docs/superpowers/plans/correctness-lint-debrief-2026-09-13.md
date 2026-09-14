# Debrief — Correctness-lint slice (degree ②), 2026-09-13

Runbook: `docs/superpowers/plans/correctness-lint-execution-plan-2026-09-13.md`.
Shipped as **v1.61.0** (fast-forward to main, commit `f306afb`).

## Planned vs shipped

Both parts of the one item shipped as scoped; one unplanned in-run fix (see below).

- **Tool:** oxlint 1.82.0, exact-pinned, `.oxlintrc.json` enabling the **correctness category only**
  (no style/format/complexity), `no-unused-vars` with `ignoreRestSiblings` for the drop-a-key
  destructure idiom. Chosen at the design gate over Biome (formatter scope-creep) and ESLint
  (heaviest); trial confirmed zero-config + JSX-aware.
- **Gate:** blocking CI `lint` job (node:20-alpine) + advisory pre-push step, mirroring the
  dead-code gate. Exact-pin guard extended to oxlint (`test/source-invariants.test.js`).
- **Findings:** 18 on `src/`, **all fixed, empty baseline** (operator choice): unused
  imports/params/vars removed, a ternary-statement → `if/else`, two `new Array(n)` →
  `Array.from({length})`, an array-copy spread removed (verified safe — immutable `.filter`),
  and `DuplicatesModal.onDeleteRequest` de-destructured with a comment (dormant dedup-iteration-2
  API, still passed by App).

## Unplanned in-run fix (the gates composed)

The pre-push hook's advisory dead-code step caught that **oxlint itself tripped the knip gate**:
knip flagged `oxlint` as both an unused devDependency and an unlisted binary (it can't resolve
oxlint's platform binary-dispatch packaging to see it's used by the `lint` script). Fixed in
`knip.json` (`ignoreDependencies`/`ignoreBinaries: ["oxlint"]`) — an FP fixed in config, never
baselined, per the dead-code design. Caught **before** the push landed (push stopped mid-hook,
fix amended into the v1.61.0 commit), so v1.61.0's first pipeline is clean rather than red.

## Verification

- oxlint clean (0 findings / 133 files) on the host **and** in `node:20-alpine` (real container run).
- Full container e2e green, serialized (host OOMs on concurrent 3×3), image `v1.60.0-noble`:
  chromium × desktop, firefox × desktop, webkit × desktop.
- 1577 unit + component green; oxlint pin guard + dead-code gate green.
- CI main pipeline #313 (v1.61.0): **success.** New blocking `lint` job ✓ and `deadcode` ✓.
  A `firefox × Pixel 5` lane flaked once (`script_failure`) and **auto-retried to green** — the
  v1.60.1 CI-retry (Item A of the prior run) doing its job again, on a mobile lane this time.
- Live-verify: https://bucketer.hidayahtech.net/ serves `build-id`/`app-version` = **1.61.0**.
- Harness fidelity: the blocking-vs-advisory CI behaviour and the alpine run are exercised in CI;
  the local host verified oxlint + all suites.

## Wall-clock / touches / cost

- Wall-clock: ~1.5 h (design-gate trial + 18 fixes + 3 serialized container e2e lanes + CI).
- Operator touches: 4 (start; handoff yes; design-gate rule+disposition; bump level).
- Subagents: 0 (solo, as planned).
- Token cost: modest; no fan-out.

## Guard blocks

- None. (The push to main was gated via `push_branches`, opened at the bump-confirm moment and
  re-closed after — no BLOCKED lines.) Pushes run bare to avoid the guard's redirection-parsing.

## Lessons (→ milestone-orchestration-mode.md)

- **A new static-analysis tool can trip the existing one — let the advisory gate catch it.** The
  correctness-lint cleanup + oxlint's own packaging both surfaced in the pre-push advisory
  dead-code step; reading that output before the push landed turned a would-be red CI into a
  clean first pipeline. Run the cheap advisory gates and *read them* before pushing.
- **oxlint fits the dead-code gate's mold exactly** — exact-pin + range guard, blocking CI +
  advisory pre-push, empty baseline, musl binary for alpine. Degrees of the cleanup ladder can
  reuse one gate architecture.
