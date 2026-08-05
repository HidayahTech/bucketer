// Matched-pair Firefox memory probe: in-place ZIP engine vs. the serial+OPFS-temp engine
// it replaces, on the exact "medium" tier (zip-prefetch.js's TINY_MAX < size <= MEDIUM_MAX,
// i.e. 4-64 MiB) that GitLab #59 measured leaking ~48 MiB/file of Firefox process RSS via
// the OPFS temp read-back cycle. See docs/superpowers/plans/2026-08-04-inplace-offset-
// composition (task 9) and the #59 issue.
//
// METHODOLOGY (v2 — SLOPE, not single-N delta/N). A first version of this probe measured
// peakDeltaMiB at ONE fixed N and divided by N. That is methodologically wrong: at any
// single N, peakDeltaMiB conflates the ~constant transient working set (buffers, fetch
// scratch, GC headroom — similar magnitude for both engines) with the per-file RETAINED
// growth that #59 is actually about. The original probe that found the 48 MiB/file leak
// (run-concurrency.mjs's SCALE_NMEDIUMS mode, see zip-concurrency-scale.md's "A second
// sweep") isolated it by SWEEPING the medium-file count at fixed concurrency and reading
// the SLOPE of peakDeltaMiB vs N: a fixed transient working set only contributes to the
// intercept, so the slope isolates per-file retained growth. This probe does the same
// sweep, for the same reason, comparing two ENGINES instead of two concurrency settings.
//
// THE KEY IDEA: zero production changes. Both runs are the shipped app, unmodified.
//   * Run A ("inplace"): normal load. browser-capability.js detects window.Worker ->
//     caps.webWorker = true -> inPlaceSupported(caps) = true -> selectZipEngine picks
//     'inplace' (src/lib/zip-job.js).
//   * Run B ("serial"): a Playwright addInitScript deletes window.Worker BEFORE the app
//     bundle evaluates (addInitScript lands ahead of any navigated document's own scripts —
//     see task-8-report.md's verified timing note). detectCapabilities() then sees
//     caps.webWorker = false -> inPlaceSupported(caps) = false -> selectZipEngine falls
//     back to 'serial', the exact #59 code path, with no production hack of any kind.
//
// INSTRUMENTATION (why each run's engine is trustworthy, not assumed):
//   * Worker count — same pattern test/e2e/browser/download-zip.test.mjs uses: wrap
//     window.Worker via addInitScript, count constructions. For 'inplace' this is a real
//     observation (>=1 expected). For 'serial' it is not an observation at all — window.Worker
//     is DELETED before navigation, so the wrap can never install (`if (OrigWorker)` is
//     false), and the count is structurally always 0. The serial engine's selection is
//     therefore guaranteed by construction (typeof window.Worker !== 'function' ->
//     browser-capability.js's webWorker=false -> inPlaceSupported()=false -> selectZipEngine
//     always returns 'serial'), not inferred from a side effect — the worker count for
//     serial runs is reported purely as a sanity check that nothing bypassed the forcing.
//   * OPFS usage — navigator.storage.estimate().usage polled in-page at the same cadence as
//     the RSS sampler (same technique as probe-concurrency.html's runPrefetchProbe), giving
//     a secondary, independent confirmation: the serial+temp-tier path stages each file in
//     its own OPFS temp file *in addition to* the growing zip, so it is expected to show
//     higher/more-variable OPFS peaks than in-place, which only ever grows the one output
//     zip file. This is informational, not asserted pass/fail.
//
// Same Firefox binary, same mock, same per-file size, same RSS sampler (treeRssMiB, copied
// from run-concurrency.mjs) for every (mechanism, N) cell -> the SLOPE difference is the
// proof, not any single delta.
//
// Usage:
//   node docs/review-download-parity/probe/run-inplace-memory.mjs
//   NMEDIUMS=2,4,8,16 MEDIUM_MB=8 REPS=2 node docs/review-download-parity/probe/run-inplace-memory.mjs
//
// One-off measurement script, not part of the test suite.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { firefox } from 'playwright';
import { startMock, startAppServer, connectApp, BUCKET } from '../../../test/e2e/harness.mjs';

const NMEDIUMS = (process.env.NMEDIUMS || '2,4,8,16').split(',').map(Number);
const MEDIUM_MB = parseInt(process.env.MEDIUM_MB || '8', 10);
const REPS = parseInt(process.env.REPS || '2', 10);
const SAMPLE_MS = 40;
const MiB = 1024 * 1024;

// Copied from docs/review-download-parity/probe/run-concurrency.mjs's treeRssMiB — same
// method: sample the whole process tree rooted at the browser's own pid via `ps`, so
// Firefox's content/GPU/utility child processes are all counted, not just the main one.
function treeRssMiB(rootPid) {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid,ppid,rss', '--no-headers'], { encoding: 'utf8' })
      .trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) {
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const rssOf = new Map(rows.map(([pid, , rss]) => [pid, rss]));
    let total = rssOf.get(rootPid) || 0;
    const stack = [rootPid];
    while (stack.length) {
      for (const c of kids.get(stack.pop()) || []) { total += rssOf.get(c) || 0; stack.push(c); }
    }
    return Math.round(total / 1024);
  } catch { return null; }
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Ordinary least-squares slope/intercept of ys vs xs. This is the #59 signal: slope isolates
// per-file RETAINED growth from the fixed transient working set (which lands in the
// intercept) — see the file header comment for why a single-N delta/N cannot do this.
function linearFit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y != null);
  if (pts.length < 2) return { slope: null, intercept: null };
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: null, intercept: null };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope: Math.round(slope * 100) / 100, intercept: Math.round(intercept * 100) / 100 };
}

// Deterministic fill so a bug that mixed up entries would be visible; content doesn't
// matter for a memory probe, only size does.
function mkBinary(length, seed) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * seed + 17) % 256;
  return buf;
}

const folderPrefix = n => `mem-${n}/`;
const folderTestId = n => `mem-${n}`;

// Seed once, bounded: allocate exactly maxN buffers (one per file index, MEDIUM_MB each —
// default 16 x 8 MiB = 128 MiB of Node heap, matching the original single-N probe's bound)
// and REUSE the same buffer instance across every N-group's Nth file, rather than
// allocating sum(NMEDIUMS) fresh buffers. Each group gets its own S3 key prefix
// (`mem-<n>/`) so the UI's per-folder "download this folder" flow (open-download-job scopes
// to the browser pane's current prefix; scan enumerates everything under it — confirmed via
// Browser.jsx/DownloadJobPanel.jsx research, no per-file selection needed) selects exactly N
// files with a single folder-row click.
async function seed(ctx) {
  const maxN = Math.max(...NMEDIUMS);
  const bytes = MEDIUM_MB * MiB;
  const buffers = Array.from({ length: maxN }, (_, i) => mkBinary(bytes, i + 3));
  for (const n of NMEDIUMS) {
    for (let i = 0; i < n; i++) {
      const key = `${folderPrefix(n)}m${String(i + 1).padStart(2, '0')}.bin`;
      await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffers[i] }));
    }
  }
}

// One full run: fresh Firefox, optionally strip window.Worker, drive the ZIP flow through
// the exact UI sequence test/e2e/browser/download-zip.test.mjs uses (folder-row ->
// open-download-job -> scan -> start-zip), sample RSS + in-page OPFS usage throughout,
// return the raw measurements for this one (mech, n, rep) cell.
async function measure(mech, n, rep, ctx, app) {
  // firefox.launch() returns a Browser, which has no .process() in this Playwright version
  // (only BrowserServer and ElectronApplication do — confirmed against the pinned
  // playwright-core types.d.ts, and empirically: firefox.launch() then .process() throws
  // "not a function"). launchServer() + connect() gets both: a real OS pid to root the RSS
  // sampler at, and a normal Browser to drive via Playwright's API.
  const server = await firefox.launchServer({ headless: true });
  const pid = server.process()?.pid;
  if (!pid) { await server.close(); throw new Error(`${mech} n=${n} rep=${rep}: could not get Firefox process pid from server.process()`); }
  const browser = await firefox.connect(server.wsEndpoint());

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (mech === 'serial') {
    // Force the pre-#59-fix code path with no production change: no window.Worker means
    // browser-capability.js's webWorker detection is false, so inPlaceSupported() is false
    // and zip-job.js's selectZipEngine() falls back to 'serial'. This is a STRUCTURAL
    // guarantee, not an observation — see the file header's INSTRUMENTATION note.
    await context.addInitScript(() => {
      try { delete window.Worker; } catch (_) { window.Worker = undefined; }
    });
  }
  // Installed unconditionally (harmless no-op when window.Worker is already gone, per the
  // `if (OrigWorker)` guard below): counts Worker constructions, and exposes OPFS-sampling
  // start/stop hooks the Node side drives via page.evaluate around the run span.
  await context.addInitScript(() => {
    window.__zipWorkerCount = 0;
    const OrigWorker = window.Worker;
    if (OrigWorker) {
      window.Worker = class extends OrigWorker {
        constructor(...args) { super(...args); window.__zipWorkerCount++; }
      };
    }
    window.__startOpfsSampling = (intervalMs) => {
      window.__opfsSamples = [];
      window.__opfsTimer = setInterval(async () => {
        try {
          const e = await navigator.storage.estimate();
          window.__opfsSamples.push(Math.round((e.usage || 0) / (1024 * 1024)));
        } catch { /* ignore a transient estimate() failure */ }
      }, intervalMs);
    };
    window.__stopOpfsSampling = () => {
      if (window.__opfsTimer) clearInterval(window.__opfsTimer);
      return window.__opfsSamples || [];
    };
  });
  const page = await context.newPage();

  const downloadNames = [];
  page.on('download', (d) => downloadNames.push(d.suggestedFilename()));

  const samples = [];
  const sampler = setInterval(() => {
    const v = treeRssMiB(pid);
    if (v != null) samples.push({ t: Date.now(), rss: v });
  }, SAMPLE_MS);

  try {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);

    await page.locator(`[data-testid="folder-row:${folderTestId(n)}"]`).click();
    await page.locator('[data-testid="file-row:m01.bin"]').waitFor({ timeout: 10000 });

    // Let RSS/OPFS settle after connect+listing before marking the run start, so the
    // pre-run baseline isn't polluted by the connect/listing itself.
    await page.waitForTimeout(1000);

    const opfsBaselineMiB = await page.evaluate(async () => {
      try { const e = await navigator.storage.estimate(); return Math.round((e.usage || 0) / (1024 * 1024)); }
      catch { return null; }
    });
    await page.evaluate((ms) => window.__startOpfsSampling(ms), SAMPLE_MS);

    const runStart = Date.now();

    await page.locator('[data-testid="open-download-job"]').dispatchEvent('click');
    await page.locator('[data-testid="scan"]').click();
    const startZip = page.locator('[data-testid="start-zip"]');
    const found = await startZip.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    if (!found) {
      throw new Error(
        `${mech} n=${n} rep=${rep}: [data-testid="start-zip"] never appeared after scan — the ` +
        `ZIP-start interaction in this probe no longer matches the app UI (last verified ` +
        `against test/e2e/browser/download-zip.test.mjs's arm 1 sequence). Fix the ` +
        `selector/flow, do not silently skip.`
      );
    }
    await startZip.click();

    // Generous timeout: N medium files fetched through the mock, one job.
    const deadline = Date.now() + 180000;
    while (downloadNames.length < 1) {
      if (Date.now() > deadline) {
        throw new Error(`${mech} n=${n} rep=${rep}: expected 1 zip download, saw ${downloadNames.length} after 180s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const runEnd = Date.now();
    const wallMs = runEnd - runStart;

    const opfsSamples = await page.evaluate(() => window.__stopOpfsSampling());
    const workerCount = await page.evaluate(() => window.__zipWorkerCount);

    // Retained-after-settle: let GC/cleanup run for a few seconds post-download, then take
    // one more RSS reading directly (the interval sampler is stopped right after). A leak
    // retains this; a transient working set does not.
    await page.waitForTimeout(3000);
    const postSettleRss = treeRssMiB(pid);

    clearInterval(sampler);

    const before = samples.filter(s => s.t < runStart).map(s => s.rss);
    const during = samples.filter(s => s.t >= runStart && s.t <= runEnd).map(s => s.rss);
    const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
    const pre = tail.length ? median(tail) : null;
    const peakDeltaMiB = (during.length && pre != null) ? Math.max(...during) - pre : null;
    const retainedDeltaMiB = (postSettleRss != null && pre != null) ? postSettleRss - pre : null;
    const opfsPeakMiB = (opfsSamples.length && opfsBaselineMiB != null)
      ? Math.max(...opfsSamples, opfsBaselineMiB) - opfsBaselineMiB : null;

    return {
      n, rep, wallMs, preMiB: pre, peakDeltaMiB, retainedDeltaMiB,
      workerCount, opfsBaselineMiB, opfsPeakMiB, opfsSampleCount: opfsSamples.length,
    };
  } finally {
    clearInterval(sampler);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// How each mechanism's engine selection is confirmed across its whole set of runs — see the
// file header's INSTRUMENTATION note for why 'serial' is a structural guarantee, not an
// inference, while 'inplace' is a genuine runtime observation.
function engineConfirmation(mech, runs) {
  const counts = runs.map(r => r.workerCount);
  if (mech === 'inplace') {
    const confirmed = counts.every(c => c >= 1);
    return {
      method: 'window.Worker wrapped via addInitScript before navigation; counts `new Worker()` constructions during the run',
      workerCounts: counts,
      confirmed,
      note: confirmed
        ? 'every run constructed >=1 Worker: selectZipEngine only returns "inplace" when caps.webWorker && makeWorker, so this is direct evidence the in-place engine ran'
        : `WARNING: at least one inplace run constructed 0 Workers (${JSON.stringify(counts)}) — the in-place engine may not have run for that cell; treat its numbers as suspect`,
    };
  }
  const confirmed = counts.every(c => c === 0);
  return {
    method: 'window.Worker deleted via addInitScript before navigation (forced, structural, not inferred): typeof window.Worker !== "function" makes browser-capability.js\'s webWorker=false, so inPlaceSupported()=false and zip-job.js\'s selectZipEngine always returns "serial" regardless of runtime behavior',
    workerCounts: counts,
    confirmed,
    note: confirmed
      ? 'every run constructed 0 Workers, consistent with window.Worker being unavailable throughout — the serial engine ran. This is a guarantee of the forcing mechanism itself; the worker count is reported only as a sanity check that nothing bypassed it'
      : `WARNING: a serial run constructed >=1 Worker (${JSON.stringify(counts)}) despite window.Worker being deleted before navigation — this should be structurally impossible; investigate before trusting these numbers`,
  };
}

function aggregateByN(runs, n) {
  const cell = runs.filter(r => r.n === n);
  const peak = cell.map(r => r.peakDeltaMiB).filter(v => v != null);
  const retained = cell.map(r => r.retainedDeltaMiB).filter(v => v != null);
  const opfs = cell.map(r => r.opfsPeakMiB).filter(v => v != null);
  return {
    n,
    medianPeakDeltaMiB: peak.length ? median(peak) : null,
    medianRetainedDeltaMiB: retained.length ? median(retained) : null,
    medianOpfsPeakMiB: opfs.length ? median(opfs) : null,
    reps: cell.length,
  };
}

const ctx = await startMock();
const app = await startAppServer();
await seed(ctx);

const raw = { inplace: [], serial: [] };
for (const mech of ['inplace', 'serial']) {
  for (const n of NMEDIUMS) {
    for (let rep = 1; rep <= REPS; rep++) {
      console.log(`--- ${mech} n=${n} rep=${rep} ---`);
      const r = await measure(mech, n, rep, ctx, app);
      raw[mech].push(r);
      console.log(mech, n, rep, r);
    }
  }
}

await app.close();
await ctx.mock.close();

const firefoxReport = {};
for (const mech of ['inplace', 'serial']) {
  const byN = NMEDIUMS.map(n => aggregateByN(raw[mech], n));
  const { slope, intercept } = linearFit(byN.map(c => c.n), byN.map(c => c.medianPeakDeltaMiB));
  firefoxReport[mech] = {
    runs: raw[mech],
    byN,
    slopeMiBPerFile: slope,
    interceptMiB: intercept,
    engineConfirmation: engineConfirmation(mech, raw[mech]),
  };
}

const ip = firefoxReport.inplace.slopeMiBPerFile;
const se = firefoxReport.serial.slopeMiBPerFile;
let verdict;
if (ip != null && se != null) {
  verdict =
    `serial slope=${se} MiB/file (expected ~40-48 per #59) vs in-place slope=${ip} MiB/file ` +
    `(expected near-0 if #59 is fixed). ` +
    `serial engine confirmed: ${firefoxReport.serial.engineConfirmation.confirmed}. ` +
    `inplace engine confirmed: ${firefoxReport.inplace.engineConfirmation.confirmed}.`;
} else {
  verdict = 'incomplete — one or both mechanisms failed to produce a slope (need >=2 distinct N with valid peakDeltaMiB)';
}

const report = { nMediums: NMEDIUMS, mediumMB: MEDIUM_MB, reps: REPS, firefox: firefoxReport, verdict };

const outPath = fileURLToPath(new URL('./results-inplace-memory.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log('\nwrote', outPath);
console.log('\nverdict:', verdict);
