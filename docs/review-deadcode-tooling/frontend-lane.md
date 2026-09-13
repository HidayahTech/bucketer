# Frontend lane — dead-code tooling evaluation

Scope per panel charter: unused **files**, **exports**, **dependencies**, **CSS
classes** only (no lint/format/complexity). Investigated read-only against the
actual repo state at commit `586ac91` (2026-09-13).

## 1. Recommendation

**Primary: [knip](https://knip.dev/)** (webpro-nl/knip on GitHub) for files,
exports, and dependencies. Knip is the only actively-maintained tool in this
space that covers all three of those categories in one config, needs no
TypeScript (it walks plain `.js`/`.jsx` via its own resolver — `allowJs` is a
TS-project knob, not a requirement to use it at all), supports multiple entry
points (needed for the inlined worker), has a first-class notion of
"production" vs "everything" analysis (needed for the test-only-export gray
area), and is deterministic and pinnable like any npm devDependency. Its
closest competitors in this category — **depcheck** and **unimported** — are
both unmaintained (last publish ~3 years ago on npm as of this check,
2026-09-13); depcheck's own maintainers now point users to knip. **ts-prune**
is TypeScript-only and formally archived in favor of knip. None of the
lint-family tools (ESLint + eslint-plugin-unused-imports, oxlint, Biome) can
do cross-file unused-export or unused-file detection at all — they only catch
unused *local* bindings/imports within a single file, which is a different
(and already out-of-scope, per the panel charter) problem.

**CSS is a separate concern.** Knip has no general unused-CSS-class checker
for a hand-written stylesheet (its CSS-class support is a Tailwind-v4-specific
compiler, and this repo's `src/styles/main.css` is not Tailwind). For the
single `main.css`, recommend **PurgeCSS** (`@fullhuman/purgecss` — actively
released, v8.0.0 ~7 months old as of this check) run in **report-only mode**
(its Node API, not its CLI `--css`/output-writing mode) as a second, narrow
check — never wired into `build.mjs`'s actual bundle output, per the
byte-for-byte reproducibility invariant.

## 2. Candidate comparison

| Tool | Vanilla JS/JSX (no TS) | Files | Exports | Deps | CSS | FP-trap handling | Config burden | Health | Determinism |
|---|---|---|---|---|---|---|---|---|---|
| **knip** | Yes, native — TS is optional, not required | Yes | Yes | Yes | No (Tailwind-only compiler) | Multi-`entry` handles the worker; production-mode (`!` suffix) vs default-mode diff handles test-only exports; `ignore`/`@internal` tag handles dormant vault code | Medium — one `knip.json`, needs explicit entry list | Active; part of a broad plugin ecosystem; ts-prune explicitly defers to it | Deterministic per pinned version; no network/AI step |
| **depcheck** | Yes | No | No | Yes only | No | N/A (deps-only) | Low | **Inactive** — no release in ~3 yrs, maintainers recommend knip | Deterministic |
| **unimported** | Yes | Yes | No | Yes | No | Partial (entry list exists) but no export-level granularity | Low–Medium | **Inactive** — no release in ~3 yrs | Deterministic |
| **ts-prune** | No — TypeScript AST only | No | Yes (TS only) | No | No | N/A | N/A | **Archived**, author redirects to knip | N/A |
| **eslint + eslint-plugin-unused-imports** | Yes | No | No (only unused *local* import bindings, not cross-file "is this export used anywhere") | No | No | N/A | Medium (needs an ESLint config, which the repo doesn't have) | Active | Deterministic |
| **oxlint** | Yes | No | No (same single-file-scope limitation) | No | No | N/A | Low | Active, fast-growing | Deterministic |
| **Biome** | Yes | No | No (same limitation; also a formatter/linter, not a project-graph tool) | No | No | N/A | Low–Medium | Active | Deterministic |
| **PurgeCSS** | N/A (CSS tool) | — | — | — | Yes | Must special-case dynamic `` `toast-${type}` `` style class construction (see §4) | Low (one script, report-only) | Active (v8.0.0, ~7 months old) | Deterministic given the same `content` file set |

Sources: knip.dev homepage and GitHub (webpro-nl/knip), archived ts-prune
README (redirects to knip), npm registry pages for depcheck (v1.4.7, ~3 yr
stale) and unimported (v1.31.1, ~3 yr stale), Socket.dev/npm registry for
purgecss (v8.0.0). All checked 2026-09-13.

## 3. Config sketch (knip)

```jsonc
// knip.json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": [
    "src/main.jsx!",                        // esbuild's real bundle root
    "src/worker/zip-assembler.worker.js!"   // Trap 1: only referenced as a
                                             // string in build.mjs's separate
                                             // esbuild.build({entryPoints:[...]})
                                             // call, never `import`ed from src/.
                                             // Without this line knip's module
                                             // graph never reaches it and
                                             // reports the whole file dead.
  ],
  "project": ["src/**/*.{js,jsx}"],
  "ignore": [
    "src/lib/changelog.js"                  // @generated by build.mjs from
                                             // CHANGELOG.md — not hand-authored,
                                             // exclude like any generated file
  ]
}
```

- **Test files as consumers (Trap 2):** do NOT add `test/**` to `project` —
  that would make knip try to lint the tests themselves for unused exports,
  which isn't the goal. Instead run knip twice and diff:
  1. `knip` (default mode) — treats every `test/*.test.js` /
     `test/components/*.test.jsx` file's imports as real usage (knip's
     node:test/jsdom-style test files are picked up as implicit entries when
     present under `project`/via its test-runner plugins, or explicitly add
     `"test/**/*.{js,jsx}"` to `project` without a `!` suffix so they count
     as consumers but are excluded from production mode). Anything still
     flagged unused here is unused by **both** src and test — truly dead.
     Confirmed example from a manual scan: `MAX_CONCURRENCY` in
     `src/lib/zip-prefetch.js` is exported but has zero references in `src/`
     or `test/` — this is what should land in that list.
  2. `knip --production` — only the `!`-suffixed entries/project globs count,
     so `test/**` drops out of the graph entirely. Exports that are clean in
     run 1 but flagged in run 2 are used **only** by tests — the gray-area
     set (confirmed examples: `enumerateObjects`, `groupBySize`,
     `deriveSignals`, `headSizeGroups`, `classifyGroups` in
     `src/lib/dedup-scan.js`; `classifyTier`, `createTempStore`,
     `sweepOrphanTemps`'s sibling exports in `src/lib/zip-prefetch.js`;
     several `src/lib/transfer-commands.js` builders). Report these
     separately in CI output — do not auto-fail on them, since removing a
     unit-tested internal is a design decision, not a dead-code fact.
- **Inlined worker (Trap 1):** handled by the explicit second `entry` line
  above. `assembler-worker-url.js` itself needs no special handling — it
  *is* statically `import`ed by `src/components/App.jsx`, so it's already
  reachable; only the worker source file that build.mjs treats as its own
  bundle root needs declaring.
- **Dormant vault code (Trap 4):** `src/lib/vault.js` is statically imported
  by `App.jsx` and `VaultUnlock.jsx` today (gated behind the `VAULT_ENABLED =
  false` constant, not behind a dead import), so knip's default graph walk
  already sees it as used — no special-case needed for the *file*. For the
  handful of vault exports used only by its own test file, treat them under
  the same test-only-gray-area bucket as Trap 2, not as a unique annotation.
  If a future export becomes truly orphaned while the feature stays
  deliberately shipped-but-off, mark it with a `/** @internal */` JSDoc tag
  and add `"tags": ["-internal"]` to knip.json so tagged dormant exports are
  excluded from the *fail* list but still visible in a verbose report —
  this keeps "intentionally dormant" distinguishable from "silently ignored."
- **Dependencies:** default knip dependency check against `package.json`
  needs no extra config here; `@aws-sdk/client-s3` and
  `@aws-sdk/s3-request-presigner` are both referenced under `src/lib/`, so a
  quick manual grep found no false-unused risk there, but this wasn't
  exhaustively re-verified against knip's actual output (see §5).

## 4. CSS coverage

Knip does not cover it for this repo — its class-usage detection is a
Tailwind v4-specific compiler feature, and `main.css` is hand-authored (BEM-
ish custom classes, not utility classes), so that feature doesn't apply.
**A second, narrow tool is needed: PurgeCSS run programmatically in
report-only mode**, comparing `src/styles/main.css` selectors against the
`content` glob `src/**/*.{js,jsx}` (and `src/index.html`), printed as a diff
list, never writing back to any file esbuild consumes.

Trap 3 is real and confirmed broadly, not just for toasts — this repo builds
many class names as template literals across at least a dozen components
(`` `toast toast-${t.type}` `` in `ToastHost.jsx`; `` `app-logo logo-phase-${phase}` ``
in `BucketerLogo.jsx`; `` `status-badge ${cls}` `` in `App.jsx`;
`` `upload-item-status ${statusClass}` `` in `UploadItem.jsx`; similar
patterns in `SortTh.jsx`, `MasterQueue.jsx`, `Browser.jsx`,
`CopyLinkPopover.jsx`, `PreviewMedia.jsx`, `BatchSummary.jsx`, `App.jsx`'s
sidebar toggle). PurgeCSS's default extractor only pulls whole tokens that
appear literally in source text, so `.toast-success` / `.toast-error` /
`.status-badge` (confirmed present in `main.css` at lines 237 and
1185–1186) would be **false-positived as unused** under a naive run. Two
mitigations, in order of preference:
1. **PurgeCSS `safelist` patterns** for every confirmed dynamic-prefix family
   (`/^toast-/`, `/^logo-phase-/`, `/^col-sort/`, etc.) — enumerate the
   prefixes by grepping ``class={`...${`` once and hand-maintaining the list;
   this repo's dynamic-class surface is small and stable enough that this is
   the pragmatic choice over building a custom extractor.
2. A **custom PurgeCSS `extractor` function** that additionally captures the
   static portions of each template literal (splits on `${`) — more
   accurate, more code to maintain. Given the scale here (~10 dynamic-class
   sites, one CSS file), the safelist approach is proportionate; recommend
   starting there and only building a custom extractor if the safelist
   becomes hard to keep in sync.

Either way: run PurgeCSS as a **standalone report script** invoked outside
`build.mjs` (e.g. `scripts/check-unused-css.mjs`, wired into CI as its own
job/npm script), never inside the production build path — the panel's
byte-for-byte reproducibility invariant must not depend on a class-usage
heuristic that could misfire and strip a class the app needs at runtime.

## 5. Open risks / not verified

- **Not run**: neither knip nor PurgeCSS was actually installed or executed
  against this repo (read-only investigation panel, no writes/installs
  permitted). Everything above is grounded in reading `build.mjs`,
  `src/index.html`, `src/lib/toast.js`, `src/lib/vault.js`,
  `src/lib/assembler-worker-url.js`, `src/lib/dedup-scan.js`,
  `src/lib/zip-prefetch.js`, `src/lib/transfer-commands.js`, and
  `src/styles/main.css` directly, plus targeted greps — not from a tool's
  actual output. The EM/whoever integrates this should do a real
  `npx knip@<pinned>` dry run before wiring it into CI, and treat the
  "truly dead" and "test-only" example lists above as spot-checks, not an
  exhaustive inventory.
- **Knip's default-mode test discovery** — whether knip auto-detects
  `node --test` files as implicit entries via a built-in plugin, versus
  needing them added to `project` explicitly, was not confirmed against
  knip's plugin list for the Node test runner specifically (its plugin
  ecosystem documents Jest/Vitest/etc. explicitly; plain `node:test` support
  wasn't independently verified). The two-run diff strategy in §3 works
  either way, but the exact `project`/`entry.production` wording may need a
  small adjustment once tested live.
- **`.githooks/pre-push`** is unmodified by this proposal — this lane only
  evaluates the tool, not where in CI/pre-push it should run; that's an
  integration decision for whoever synthesizes the four lanes (a dead-code
  check running on every push likely belongs in CI rather than the pre-push
  hook, given the hook already runs a full build + test cycle).
- **Dependency-category check (knip vs `package.json`)** was reasoned about,
  not run — the claim that current `dependencies`/`devDependencies` are all
  used is a manual-grep spot-check, not a tool result.
