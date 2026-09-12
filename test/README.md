# Test suite — layout and conventions

Moved from `AGENTS.md` on 2026-09-11 (repo-baseline §10.3: inventories live
next to the code, the agent file stays an operating card). **The directory is
the authoritative file list — this document is not.** An earlier version of
this catalog enumerated every test file; it went stale (dozens of files
missing) and the stale list nearly caused an agent to overwrite an existing
test file it believed didn't exist (2026-08-13, `move-picker-modal.test.jsx`).
Before creating a "new" test file, always check whether one already exists for
that module (`ls test/ test/components/`), and extend it rather than replacing
it. The groups below describe the layers and their conventions, with anchor
examples only.

Tests run with `node --test` (no framework).

**Unit tests (`test/*.test.js`) — pure Node, no build step, run by `npm test`:**
roughly one per `src/lib` module, grouped by domain:
- Formatting/provider/media basics (`format`, `provider`, `media`, `sort`, `constants`)
- S3 operations: listing, move (queue/guards/key/multipart/drag), delete, purge,
  crawl, dedup (`list-objects`, `move-*`, `delete-queue`, `purge-versions`,
  `crawl-prefix`, `dedup-scan*`)
- Upload pipeline: queue, sharding, part sizing, resume records, metadata, cleanup
  (`upload-*`, `calc-part-size`, `collect-parts` (BUG-007), `indexeddb-*` — the latter
  using `fake-indexeddb`)
- Download manager + ZIP: manifests, naming, lifecycle, verification, zip
  layout/assembly/jobs/prefetch (`download-*`, `zip-*`, `rate-tracker`,
  `verify-bytes`)
- Persistence and connection model: `storage`, `connections`, `vault`, `url-params`,
  `base-prefix` (prefix-scoped keys, #60) — browser globals mocked via
  `global.localStorage`/`global.window` set before import
- Validation and config: `credential-form-validation` (BUG-016), `cors-config`
  (BUG-012), `validate-object-name`, `s3-client`

**Source-level structural assertions — no build step needed:**
- `source-invariants.test.js` — regex/structural checks against `src/` (BUG-006,
  BUG-014, BUG-017, BUG-021, package-lock version lockstep)
- `e2e-matrix-helpers.test.js` — `.gitlab-ci.yml` image pin ⇄ locked playwright version

**Build output assertions — require `npm run build` first:**
- `build.test.js` — placeholder replacement (BUG-001), Preact JSX transform (BUG-002),
  version consistency, CORS DELETE (BUG-012), single-bundle structure

**Component rendering tests (`test/components/*.test.jsx`) — require `npm run test:ui`, NOT `npm test`:**

They use jsdom (a browser DOM emulator) and `preact/test-utils` to render components
and assert on their output. Nearly every component in `src/components/` has a matching
test file — assume one exists and check before creating. Naming: the
component's kebab-case name; additional aspect files use a suffix (e.g.
`browser-internals`, `browser-base-prefix`, `browser-download-entries`,
`browser-folder-rename`, `upload-queue-ui`, `upload-queue-destination`,
`master-queue-download`). Representative anchors:
- `credential-form.test.jsx` — fields (incl. Base folder), validation, provider
  auto-detection, submission
- `browser-internals.test.jsx` — Breadcrumb (incl. floor pinning), SortTh,
  CopyLinkPopover
- `error-block.test.jsx` — CORS heuristic, S3 error metadata, prefix-scope hints
- `setup-guide.test.jsx` — all provider guides render; provider-specific caveats

**How the component test layer works:**

- `test/helpers/jsx-loader.mjs` — custom Node ESM loader that transforms `.jsx` files using esbuild (same settings as the production build: `jsx: 'automatic'`, `jsxImportSource: 'preact'`). No additional dependencies beyond esbuild.
- `test/helpers/with-dom.js` — sets up jsdom globals (`window`, `document`, `navigator`, etc.) before any component imports. **Must be the first import in every component test file.** ES module imports evaluate in order — placing it first guarantees `global.document` is set before Preact accesses it at render time.
- `test/helpers/render.js` — shared `mount(vnode)` helper (returns `text`, `html`, `query`, `queryAll`, `container`, `cleanup`) and `fire(element, eventName)` / `setInput(element, value)` utilities. Import this instead of writing inline mount logic.

**Adding new component tests:** Write `test/components/<name>.test.jsx`. Start with `import '../helpers/with-dom.js'` as the very first line. Import `{ mount, fire }` from `'../helpers/render.js'`. Run with `npm run test:ui`.

**Adding new unit tests:** Write `test/<name>.test.js`. The test command (`node --test test/*.test.js`) picks it up automatically. For browser globals, set `global.<name>` before the module import. For IndexedDB, use `fake-indexeddb`.
