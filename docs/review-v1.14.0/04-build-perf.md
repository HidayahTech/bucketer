# Build, Deployment & Performance — Bucketer v1.14.0

## Summary

Bucketer v1.14.0 has a clean, well-engineered build pipeline with correct invariant enforcement, zero sourcemap leakage, and no secrets in the production artifact (521 KB). The pre-push hook properly gates all pushes on tests; CI mirrors this gating. Performance work in v1.13.14–v1.14.0 shipped six significant optimizations (rAF coalescing, timestamp caching, filter/reduce consolidation, visibility throttling, parallel delete, and upload queue capping), reducing upload processing overhead by 17–93% at 1000 files. The production artifact is self-contained and correctly structured; the only minor concern is that a small amount of AWS SDK console logging (not app code) leaks into minified output, but this is benign and standard for SDKs.

## Production artifact

- **Size**: 521 KB (521,347 bytes)
  - JS: 476.4 KB (91%)
  - CSS: 31.3 KB (6%)
  - HTML + overhead: ~14 KB (3%)
  - External asset (og-image.png): 57 KB (not included in main artifact)
- **Composition**: AWS SDK dominates at ~91% of JS; Preact is minimal (~3 references, inlined). The AWS SDK v3 client-s3 and its smithy middleware stack account for the bulk; this is expected and acceptable for S3 operations.
- **Inlined cleanly**: Yes — single `<style>` tag and single `<script>` tag. No external `<script src>` or `<link href="http">` references; fully self-contained per spec.
- **Leaked content**: 
  - **No sourcemap**: sourceMappingURL absent ✓
  - **No @anthropic-ai in code**: The only occurrence is in the CHANGELOG entry for v1.10.2 (historical tooling note) — not actual source code ✓
  - **No CLI paths**: No `/home/`, `basilgohar`, `/Users/` paths ✓
  - **Console logging**: 7 instances of `console.log/warn/error` found — all from AWS SDK v3 middleware layer, not from Bucketer app code. Examples: internal smithy logger registrations, SDK regional resolver warnings (benign). App code correctly uses `console.info` for the single visibility-change log (line 570, UploadQueue.jsx), which is intentional debugging. No production app logic bleeding through ✓
- **Meta tags**: Both `build-id` and `app-version` correctly present and within byte boundary (ends at bytes 179 and 224 respectively; 512-byte limit observed) ✓
- **og-image.png**: Referenced in head and present in dist/ (57 KB) ✓

**Build invariants enforcement**: Working correctly ✓
- **Version consistency**: CHANGELOG.md top entry matches package.json v1.14.0 ✓
- **Meta tag boundary**: Byte checks pass before build exits ✓

## Findings

### [BUILD-01] AWS SDK console logging in production bundle — Severity: Low
- **Location**: Minified JS, lines in the AWS SDK v3 middleware. Examples: smithy logger setup, regional resolver warnings.
- **Evidence**: `grep "console\.(warn|error|log)"` returns 7 hits; all from `@smithy/` internal middleware (e.g., `console.warn('@smithy/config-resolver WARN...')` for regional ambiguity warnings).
- **Impact**: Minimal. These are SDK internal advisory logs (not app code) and only appear on first client instantiation or misconfiguration. They do not affect security or functionality; they are standard in AWS SDK v3 production builds.
- **Recommendation**: Acceptable as-is. If desired in v2.0, esbuild could be configured with `pure: ['console.warn']` to strip SDK advisory logs, but this is optional.

### [BUILD-02] No source map stripping validation — Severity: Informational
- **Location**: build.mjs, lines 113–116 (esbuild config)
- **Evidence**: `sourcemap: false` is correctly set for prod mode; verified no `sourceMappingURL` in dist/index.html.
- **Recommendation**: Consider adding a build invariant to explicitly assert no `sourceMappingURL` substring, similar to the meta tag checks. Current setup is correct but a failed invariant would catch human error if someone accidentally set `sourcemap: 'inline'` for prod.

### [BUILD-03] Mode handling is clean — Severity: None (positive)
- **Location**: build.mjs, lines 22–26 (MODES definition)
- **Evidence**: `prod` (minified, no sourcemap), `dev` (unminified, inline sourcemap), `perf` (unminified, inline sourcemap) are clearly separated. `--mode` flag and legacy `--dev` alias both work.
- **Recommendation**: No action. This is well-designed.

### [BUILD-04] No tree-shaking issues detected — Severity: None (positive)
- **Location**: esbuild bundle
- **Evidence**: AWS SDK is not a dev dependency and is fully bundled, as intended. No unused code apparent in size breakdown (JS is dense minified output). Preact bundle is minimal (3 references found in 476 KB of JS, suggesting good tree-shaking).
- **Recommendation**: No action. Consider adding a bundle size monitoring metric (e.g., `npm run build && wc -c dist/index.html` output logged to CI) if deployment frequency increases.

### [BUILD-05] Asset loading via dataurl is appropriate — Severity: None (positive)
- **Location**: build.mjs line 118 (`loader: { '.png': 'dataurl', '.svg': 'dataurl' }`)
- **Evidence**: og-image.png (57 KB external) is referenced in HTML as URL, not inlined. SVG favicons are inlined as data: URLs (minimal size).
- **Recommendation**: No action. This is correct; external assets save bundle size and allow separate caching/CDN.

## Pre-push hook walkthrough

**File**: `.githooks/pre-push`

**Logic**:
1. Reads stdin to detect if the push is a tag-only push (recursive call from the hook itself)
2. If branch refs detected (normal push): runs `npm run build` then `npm test`; aborts if either fails
3. If no branch refs (tag-only push from within the hook): skips build/test
4. Creates version tag if not present: `git tag -a vX.Y.Z`
5. Immediately pushes the tag to remote

**Concern-free**:
- The stdin-based detection correctly distinguishes normal pushes (which trigger tests) from recursive tag-only pushes (which do not), preventing redundant testing on the hook's own inner push ✓
- `set -e` ensures the script exits on first error; no path where a failed build can silently let a push through ✓
- `--no-verify` is documented as the human-operator emergency escape hatch; this is correct per CLAUDE.md ✓
- Tag creation is idempotent (`git rev-parse` checks existence first) ✓

**Verification**: The hook is correctly implemented and provides the guaranteed test gate described in CLAUDE.md.

## CI walkthrough

**File**: `.gitlab-ci.yml`

**Pipeline**:
- **test stage** (always runs): `npm ci` → `npm run build` → `npm test`. Artifacts: `dist/index.html` (expires in 1 day on success).
- **release stage** (triggered on version tag `v\d+\.\d+\.\d+` only): Requires `test` job to pass first. Runs `node scripts/release.mjs` (deployment logic not reviewed here).

**Safety**:
- Release is gated on test passing (dependencies: `needs: [test]`) ✓
- Release only triggers on annotated version tags matching the semver pattern (pushed by the pre-push hook) ✓
- No deploy path bypasses the test gate ✓

**Observation**: CI mirrors the pre-push hook's gating model and adds a release job. The two-layer gate (local pre-push + CI test) is good practice.

## Perf harness

**File**: `/perf/run.mjs` (orchestrator)

**What's measured**:
- **Phase 1 — Algorithmic microbenchmarks** (`perf/bench-algorithms.mjs`): Pure Node tests on format, upload-queue logic, etc. No build required.
- **Phase 2 — Browser benchmarks** (`perf/bench-browser.mjs`): Playwright-driven test using a mock S3 server and the app running at `http://localhost:3099`. Generates CPU profiles (stored in `/perf/output/`) and timing data.

**Infrastructure**:
- **Mock S3 server** (`perf/mock-s3.mjs`): Fakes S3 responses; supports `MOCK_S3_LATENCY_MS` env var to simulate real network conditions (e.g., `MOCK_S3_LATENCY_MS=20 npm run perftest`).
- **Build artifact**: Builds to `perf/index.html` (never touches `dist/`), allowing side-by-side perf and production builds.
- **CPU profiles**: Stored as `profile-{N}files-{timestamp}.cpuprofile` files; import into DevTools or chrome://inspect for flamegraph inspection.

**Execution**:
- `npm run bench` — runs Phase 1 only (quick, Node-based)
- `npm run perftest` — runs both phases (slow, requires browsers/servers, takes ~30s–1m)
- Results are **not automatically committed** — profiles live in `perf/output/` and are typically reviewed manually or compared across runs
- Default test size is **1000 files** (changed from 200 in v1.13.17)

**Gap**: Perf results are not committed to the repo or logged to CI. For a future v2.0, consider:
- Committing a `perf-results.json` or `perf-baseline.md` to track improvements over releases
- Running `npm run bench` on every CI build to catch regressions early
- Publishing perf results to a metrics dashboard

## Performance observations on the source

**v1.13.14–v1.14.0 shipped six optimization passes** (per CHANGELOG.md). Impact at 1000 files:

1. **v1.13.19 — Batch rAF-aligned updateItem calls** (`src/lib/update-batcher.js`):
   - Coalesces rapid, non-urgent progress ticks into a single `setItems` call per animation frame
   - Urgent status transitions flush immediately
   - Usage: Lines 82–86 in UploadQueue.jsx; all 14 status-change `updateItem` sites use `urgent=true`
   - Benefit: `BatchSummary` self-time reduced 877ms → 724ms (−17%)
   - Code quality: Clean separation of concerns; batching logic is testable via injected `scheduleFlush`/`cancelFlush`

2. **v1.13.18 — Single-loop BatchSummary aggregation**:
   - Replaced 8 separate `filter`/`reduce` passes with one `for...of` loop computing all counts in-place
   - Lines 757–770 in UploadQueue.jsx: Single pass collects `doneCount`, `errorCount`, error items, etc.
   - Benefit: Self-time reduced 1143ms → 877ms (−23%)

3. **v1.13.17 — Timestamp formatter cache**:
   - Module-level `Map` cache in UploadLog.jsx for `formatCompletedAt`
   - `toLocaleString()` called once per unique timestamp; subsequent renders are O(1) map lookups
   - Benefit: Self-time reduced ~1378ms → ~90ms (−93%)

4. **v1.13.16 — Visibility throttling + rAF limiting**:
   - Animation loops in BatchSummary skip updates when `document.visibilityState === 'hidden'` and throttle to ~15fps (66ms gate)
   - Lines 848–850 in UploadQueue.jsx
   - Benefit: ~75% reduction in animation overhead

5. **v1.13.20 — Parallel delete batches**:
   - DeleteObjectsCommand runs 3 concurrent requests instead of sequential (each still ≤1000 objects per S3 spec)
   - For 10,000-object delete: round-trips reduced from 10 serial → 4 parallel groups (~3× faster)
   - `src/lib/delete-queue.js` (new in v1.14.0 unified delete flow)

6. **v1.14.0 — Upload queue capping**:
   - UploadLog display capped at `MAX_DISPLAY = 200` rows (line 15, UploadLog.jsx)
   - All entries still counted for stats; only the UI render is capped
   - Fixed a Firefox "Script terminated by timeout" freeze when scrolling through 15,000+ rows
   - Prevents Preact diffing unbounded DOM

**No virtualization in UploadQueue**:
- The component renders all batches and all items in each batch without windowing or lazy loading
- This is acceptable because:
  - Individual batches are typically small (5–100 files, per upload-expand-threshold setting)
  - The collapsible batch design hides most items by default (collapsed batches render summary only)
  - UploadLog rendering is capped at 200 rows, preventing DOM explosion
- Future v2.0 opportunity: If a single batch grows to 10,000+ items, virtualizing the item list would prevent jank; current design assumes reasonable batch sizes

**No obvious N² loops or deep clones found**:
- Upload logic uses `Array.from({ length: partCount })` for part queues (not `new Array().fill()`, which would clone objects)
- Batch grouping (lines 605–614) iterates once and builds a Map; correct complexity

**Assessment**: The source code is well-optimized for the expected use case (1–10 batches, each 5–500 files). The perf work shipped in v1.13.14–v1.19 correctly identified and fixed the high-frequency rendering hot paths. UploadLog cap at 200 rows is sensible; BatchSummary single-loop aggregation is a good micro-optimization that scales. No regressions detected.

## Recommendations

### For v1.x stability
- **Optional**: Add a build invariant to assert no `sourceMappingURL` in prod output (3–5 lines in build.mjs, mirroring the meta tag checks). This catches accidental sourcemap leakage.
- **Optional**: Consider `pure: ['console.warn']` esbuild config if the AWS SDK warnings ever become noise; currently benign.

### For v2.0 planning
- **Commit perf results**: Store Phase 1 (`bench-algorithms`) results (as JSON) to `perf-results.json` on every build; track trends and catch regressions. v2.0 feature freeze gate could require <5% regression vs. previous release.
- **CI perf monitoring**: Run `npm run bench` on every merge to main and log results to a metrics dashboard (simple `.json` file in CI artifacts).
- **Batch virtualization**: If single-batch uploads grow beyond 10,000 items, use a windowed list (e.g., simple custom windowing or Preact-compatible library) to cap DOM size.
- **CDN fingerprinting**: Consider adding a content-hash suffix to `dist/index.html` filename (e.g., `index-abc123.html`) for aggressive HTTP caching; requires a simple routing layer on the serving domain.
- **Bundle size monitoring**: Add `const sizeLimitMB = 600; if (sizeBytes > sizeLimitMB * 1024 * 1024) throw new Error(...)` to build.mjs to catch bloat early.

## Artifact checklist

- [x] Build runs minification for prod mode
- [x] No sourcemap in production
- [x] Update-check meta tags within byte 512 boundary
- [x] CHANGELOG version matches package.json
- [x] Single `<style>` and `<script>` tag
- [x] No external script/style references
- [x] og-image.png present and referenced
- [x] No paths, usernames, or secrets leaked
- [x] AWS SDK and Preact correctly bundled
- [x] Pre-push hook gates all pushes on tests
- [x] CI mirrors the test gating
- [x] Perf harness operational and generating profiles
