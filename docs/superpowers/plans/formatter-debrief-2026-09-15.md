# Debrief — ③(b) formatter + format-check gate (2026-09-15)

Runbook: `docs/superpowers/plans/formatter-execution-plan-2026-09-15.md`.
Shipped as **v1.62.0** (fast-forward to main, commit `10b7387`). The largest rung of the
code-quality ladder — a whole-repo reformat.

## Planned vs shipped

Shipped as scoped, with the design-gate choices confirmed by the operator:

- **Prettier 3.9.6**, exact-pinned, `.prettierrc.json` = `singleQuote: true` + `printWidth: 120`
  (every other setting is a Prettier default that already matched the codebase; each was
  verified — semicolons, 2-space, `trailingComma: all`, `arrowParens: always`, JSX double-quotes).
  `.prettierignore` excludes built/generated (dist, perf, the generated `src/lib/changelog.js`,
  lockfile).
- **Whole-repo reformat** of all first-party JS/JSX/mjs: **280 source files, +16,121/−7,270**,
  as its own isolated commit (`268ee2c`), recorded in **`.git-blame-ignore-revs`**.
- **Gate:** blocking CI `format` job (`prettier --check`, node:20-alpine) + advisory pre-push
  step, mirroring lint/deadcode. Exact-pin guard extended to prettier.
- **Version:** minor v1.62.0 (confirmed at the design gate).

Design-gate choices: `printWidth 120` over 100 (halved the churn: net +8,851 vs +13,420, and
matches the codebase's ~120-char comfort — 99% of lines already ≤120); full scope over src-only
(consistency; src-only would have left test/scripts unformatted).

## Corrections / surprises (honesty over tidiness)

- **The bundle is NOT byte-identical — my pre-run claim was wrong.** The reformat changes
  `dist/index.html` by exactly **one minified variable name** (`$s` → `Fs`): esbuild's minifier
  assigns short internal names sensitively to source structure, so a whole-repo reformat shuffles
  one. Functionally identical, build deterministic (verified: two builds of the reformatted source
  are byte-identical), and the **reproducibility CI guard still holds** (it compares committed
  dist to a fresh build of the *committed* source). Safe to ship — but the artifact does change.
- **Two source-invariant tests broke** on the reformat: `arrowParens: always` rewrote `e =>` →
  `(e) =>`, breaking two exact-source regexes for Browser.jsx drag-drop wiring. Fixed by making
  the regexes arrow-parens-tolerant (`\(?e\)?`). The wiring is intact; the tests were just
  format-brittle.
- **Prettier idempotency wrinkle:** one file (`properties.test.mjs`) needed a second `format`
  pass to reach the fixed point; verified `format` → `format:check` is clean and idempotent
  before committing, so the CI `format` job is stable.
- **Transient SIGPIPE on push:** the first push passed the full suite and pushed the *tag*, then
  the SSH connection dropped before the *main ref* landed (exit 141). Re-pushed cleanly (tag
  already present, so skipped). Left the tag briefly ahead of main; re-push reconciled it.

## Verification

- Full container e2e green, serialized, image `v1.60.0-noble`: chromium × desktop, firefox ×
  desktop, webkit × desktop — the reformat is behaviour-neutral across all engines.
- 1579 unit + 551 component green; `format:check` + oxlint + deadcode clean; format idempotent.
- CI main pipeline #2851466559 (v1.62.0): **success.** The new blocking `format` job passed;
  `lint`/`deadcode`/`test`/`reproducibility` all green. Two mobile e2e lanes (webkit × iPhone 13,
  firefox × Pixel 5) flaked and **auto-retried to green** — the v1.60.1 CI-retry again.
- Live-verify: https://bucketer.hidayahtech.net/ serves `build-id`/`app-version` = **1.62.0**.
- Harness fidelity: the blocking `format` CI behaviour is a GitLab-runtime property; the local
  host verified `format:check` + all suites + the byte-diff/determinism of the bundle.

## Wall-clock / touches / cost

- Wall-clock: ~2 h (whole-repo reformat + config-matching + 2 test fixes + full suite + 3 e2e
  lanes + a re-push after the SIGPIPE + CI).
- Operator touches: 3 (start; handoff yes; design-gate decision — the bump was folded into it).
- Subagents: 0 (solo, mechanical).

## Lessons (→ milestone-orchestration-mode.md)

- **A formatter is NOT bundle-neutral for a minifier that name-mangles.** esbuild reassigns one
  short internal name for reformatted source. Don't promise byte-identity; verify determinism +
  that the reproducibility guard (committed-dist == build-of-committed-source) still holds, and
  ship the changed dist.
- **Source-invariant tests that regex exact code are formatter-brittle.** Introducing a formatter
  will break some; make them tolerant (e.g. optional arrow-parens) rather than pinning a format.
- **Verify formatter idempotency before wiring a `--check` gate** — one pass isn't always the
  fixed point; run `format` then `format:check` and confirm clean, or the CI gate can flake.
- **A push can pass the hook, land the tag, then SIGPIPE before the branch ref.** Re-push is safe
  (the tag step is idempotent); check origin/main actually advanced, don't assume the exit code
  means nothing shipped.
- **printWidth chosen from the codebase's own line-length distribution** minimises churn — measure
  before picking.
