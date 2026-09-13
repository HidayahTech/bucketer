# Dead-code gate — acceptance evidence

Run 2026-09-13 in the `feature/deadcode-tooling` worktree. Tools: **knip 6.35.1**, **purgecss 8.0.0** (both exact-pinned). Node 20. Procedure per spec §6.

## 1. True-positive matched pair (proves the gate detects real dead code)

**RED** — appended `export function __deadcodeProbe() { return 1; }` to `src/lib/format.js` (referenced nowhere), then `npm run deadcode`:

```
New dead-code findings not in deadcode-baseline.json (1):
  + src/lib/format.js __deadcodeProbe exports
exit: 1
```

**GREEN** — removed the probe (`git checkout src/lib/format.js`), then `npm run deadcode`:

```
deadcode gate: clean (findings match baseline).
exit: 0
```

## 2. False positives are zero-finding via config (never baselined)

`npx knip` on the clean tree flags **no** finding for any of:
- `src/worker/zip-assembler.worker.js` — declared as a second `entry` in `knip.json` (it is a separate esbuild entrypoint wired by the `__WORKER_SRC__` string substitution in `build.mjs`, not reached through the `src/main.jsx` import graph).
- Dynamic CSS classes (`toast-*`, `logo-phase-*`, `status-badge`, …) — safelisted in `scripts/check-unused-css.mjs`; the report-only CSS check reports "no unused selectors."

Grep of `npx knip` output for `worker|toast-|status-badge|logo-phase` → none flagged.

## 3. Baseline state

`deadcode-baseline.json` is **empty (`[]`)** — all 6 findings from the first real run were cleaned rather than suppressed (3 de-exported, 3 deleted; see commit `a5eb206`). Nothing is suppressed, so the gate's teeth are undulled.

## 4. Gate logic unit coverage

`test/deadcode-gate.test.js` (5 tests): `diffFindings` flags new findings as unexpected, flags stale baseline entries, passes on exact match; `normalizeKnip` flattens knip's per-file category arrays and handles string dep entries + empty input. All pass.

## Not covered / notes
- CSS check is **advisory** (exit 0 always), never blocking — dynamic-class fidelity is the highest FP risk (spec §9), so it stays report-only until proven over time.
- The knip JSON shape (`{issues:[{file, exports:[{name}], …}]}`) was confirmed live against knip 6.35.1; `normalizeKnip` is written to that shape.
