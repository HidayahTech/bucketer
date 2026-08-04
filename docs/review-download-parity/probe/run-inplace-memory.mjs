// Matched-pair Firefox memory probe: in-place ZIP engine vs. the serial+OPFS-temp engine
// it replaces, on the exact "medium" tier (zip-prefetch.js's TINY_MAX < size <= MEDIUM_MAX,
// i.e. 4-64 MiB) that GitLab #59 measured leaking ~48 MiB/file of Firefox process RSS via
// the OPFS temp read-back cycle. See docs/superpowers/plans/2026-08-04-inplace-offset-
// composition (task 9) and the #59 issue.
//
// THE KEY IDEA: zero production changes. Both runs are the shipped app, unmodified.
//   * Run A ("inplace"): normal load. browser-capability.js detects window.Worker ->
//     caps.webWorker = true -> inPlaceSupported(caps) = true -> selectZipEngine picks
//     'inplace' (src/lib/zip-job.js).
//   * Run B ("serial"): a Playwright addInitScript deletes window.Worker BEFORE the app
//     bundle evaluates (addInitScript lands ahead of any navigated document's own scripts —
//     see task-8-report.md's verified timing note). detectCapabilities() then sees
//     caps.webWorker = false -> inPlaceSupported(caps) = false -> selectZipEngine falls back
//     to 'serial', the exact #59 code path, with no production hack of any kind.
//
// Same Firefox binary, same mock, same workload, same RSS sampler (treeRssMiB, copied from
// run-concurrency.mjs's implementation) for both runs -> the difference in peak-RSS-delta
// per file is the proof.
//
// Usage:
//   node docs/review-download-parity/probe/run-inplace-memory.mjs
//   NMEDIUM=8 MEDIUM_MB=8 node docs/review-download-parity/probe/run-inplace-memory.mjs
//
// One-off measurement script, not part of the test suite.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { firefox } from 'playwright';
import { startMock, startAppServer, connectApp, BUCKET } from '../../../test/e2e/harness.mjs';

const NMEDIUM = parseInt(process.env.NMEDIUM || '8', 10);
const MEDIUM_MB = parseInt(process.env.MEDIUM_MB || '8', 10);
const SAMPLE_MS = 40;
const PREFIX = 'mem/';

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

// Deterministic, distinguishable bodies (same rationale as download-zip.test.mjs's mkBinary):
// different fill so a bug that mixed up entries would still be visible, though this probe
// only cares about memory, not zip correctness.
function mkBinary(length, seed) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * seed + 17) % 256;
  return buf;
}

async function seed(ctx) {
  const bytes = MEDIUM_MB * 1024 * 1024;
  for (let i = 0; i < NMEDIUM; i++) {
    const key = `${PREFIX}m${String(i + 1).padStart(3, '0')}.bin`;
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: mkBinary(bytes, i + 3) }));
  }
}

// One full run: launch Firefox fresh, optionally strip window.Worker, drive the ZIP flow
// through the exact UI sequence test/e2e/browser/download-zip.test.mjs uses (folder-row ->
// open-download-job -> scan -> start-zip), sample RSS throughout, return {preMiB,
// peakDeltaMiB, perFileMiB}.
async function measure(mech, ctx, app) {
  // firefox.launch() returns a Browser, which has no .process() in this Playwright
  // version (only BrowserServer and ElectronApplication do — confirmed against the
  // pinned playwright-core types.d.ts). launchServer() + connect() gets both: a real OS
  // pid to root the RSS sampler at, and a normal Browser to drive via Playwright's API.
  const server = await firefox.launchServer({ headless: true });
  const pid = server.process()?.pid;
  if (!pid) { await server.close(); throw new Error(`${mech}: could not get Firefox process pid from server.process()`); }
  const browser = await firefox.connect(server.wsEndpoint());

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (mech === 'serial') {
    // Force the pre-#59-fix code path with no production change: no window.Worker means
    // browser-capability.js's webWorker detection is false, so inPlaceSupported() is false
    // and zip-job.js's selectZipEngine() falls back to 'serial'.
    await context.addInitScript(() => {
      try { delete window.Worker; } catch (_) { window.Worker = undefined; }
    });
  }
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

    await page.locator('[data-testid="folder-row:mem"]').click();
    await page.locator('[data-testid="file-row:m001.bin"]').waitFor({ timeout: 10000 });

    // Let RSS settle after connect+listing before marking the run start, so the pre-run
    // median isn't polluted by the connect/listing itself.
    await page.waitForTimeout(1000);
    const runStart = Date.now();

    await page.locator('[data-testid="open-download-job"]').dispatchEvent('click');
    await page.locator('[data-testid="scan"]').click();
    const startZip = page.locator('[data-testid="start-zip"]');
    const found = await startZip.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    if (!found) {
      throw new Error(
        `${mech}: [data-testid="start-zip"] never appeared after scan — the ZIP-start ` +
        `interaction in this probe no longer matches the app UI (last verified against ` +
        `test/e2e/browser/download-zip.test.mjs's arm 1 sequence). Fix the selector/flow, ` +
        `do not silently skip.`
      );
    }
    await startZip.click();

    // Generous timeout: NMEDIUM medium files fetched through the mock, one job.
    const deadline = Date.now() + 120000;
    while (downloadNames.length < 1) {
      if (Date.now() > deadline) {
        throw new Error(`${mech}: expected 1 zip download, saw ${downloadNames.length} after 120s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const runEnd = Date.now();
    // Small settle so the sampler catches any post-download-event RSS tail (e.g. OPFS
    // temp-file cleanup) before we stop it.
    await page.waitForTimeout(1000);

    clearInterval(sampler);

    const before = samples.filter(s => s.t < runStart).map(s => s.rss);
    const during = samples.filter(s => s.t >= runStart && s.t <= runEnd + 1000).map(s => s.rss);
    const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
    const pre = tail.length ? median(tail) : null;
    const peakDeltaMiB = (during.length && pre != null) ? Math.max(...during) - pre : null;
    return {
      preMiB: pre,
      peakDeltaMiB,
      perFileMiB: peakDeltaMiB != null ? Math.round((peakDeltaMiB / NMEDIUM) * 100) / 100 : null,
    };
  } finally {
    clearInterval(sampler);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

const ctx = await startMock();
const app = await startAppServer();
await seed(ctx);

const results = {};
for (const mech of ['inplace', 'serial']) {
  console.log(`--- running ${mech} ---`);
  results[mech] = await measure(mech, ctx, app);
  console.log(mech, results[mech]);
}

await app.close();
await ctx.mock.close();

const report = { nMedium: NMEDIUM, mediumMB: MEDIUM_MB, firefox: results };
const outPath = fileURLToPath(new URL('./results-inplace-memory.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log('\nwrote', outPath);
console.log(JSON.stringify(report, null, 2));

const ip = results.inplace?.perFileMiB;
const se = results.serial?.perFileMiB;
if (ip != null && se != null) {
  console.log(
    `\nverdict: serial=${se} MiB/file vs in-place=${ip} MiB/file` +
    ` (serial expected ~40-48 MiB/file per #59; in-place expected small/flat)`
  );
} else {
  console.log('\nverdict: incomplete — one or both runs failed to produce a perFileMiB figure');
}
