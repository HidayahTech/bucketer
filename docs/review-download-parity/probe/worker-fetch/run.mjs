// Runner for the fetch-in-worker experiment. Sweeps mech ∈ {transfer, workerfetch} × N,
// launches Firefox per cell, samples process-tree RSS (ps) across the marked 'run' span,
// and reports the per-file PEAK-RSS SLOPE (peakDelta vs N) per mechanism — the same method
// run-inplace-memory.mjs uses. If workerfetch's slope is materially below transfer's, moving
// the fetch into the worker (no cross-thread ArrayBuffer transfer) cuts the Firefox peak.
//
//   NMEDIUMS=2,4,8,16 REPS=2 MEDIUM_MB=8 node docs/review-download-parity/probe/worker-fetch/run.mjs
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { firefox } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..'); // docs/review-download-parity/probe/worker-fetch → repo root
const NMEDIUMS = (process.env.NMEDIUMS || '2,4,8,16').split(',').map(Number);
const REPS = parseInt(process.env.REPS || '2', 10);
const MEDIUM_MB = parseInt(process.env.MEDIUM_MB || '8', 10);
const MECHS = (process.env.MECHS || 'transfer,workerfetch').split(',');
const SAMPLE_MS = 40;

const probeHtml = readFileSync(join(HERE, 'probe.html'), 'utf8');
const fetchWorker = readFileSync(join(HERE, 'fetch-worker.js'), 'utf8');

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const send = (body, type = 'text/javascript; charset=utf-8') => { res.setHeader('Content-Type', type); res.end(body); };
  if (path === '/' || path === '/probe.html') return send(probeHtml, 'text/html; charset=utf-8');
  if (path === '/fetch-worker.js') return send(fetchWorker);
  if (path.startsWith('/src/')) {
    const file = join(REPO, path.slice(1)); // /src/lib/x.js → <repo>/src/lib/x.js
    if (existsSync(file)) return send(readFileSync(file, 'utf8'));
  }
  res.statusCode = 404; res.end('not found');
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function treeRssMiB(rootPid) {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid,ppid,rss', '--no-headers'], { encoding: 'utf8' })
      .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const rssOf = new Map(rows.map(([pid, , rss]) => [pid, rss]));
    let total = rssOf.get(rootPid) || 0;
    const stack = [rootPid];
    while (stack.length) { for (const c of kids.get(stack.pop()) || []) { total += rssOf.get(c) || 0; stack.push(c); } }
    return Math.round(total / 1024);
  } catch { return null; }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function slope(points) { // least-squares slope of y vs x
  const n = points.length; if (n < 2) return null;
  const sx = points.reduce((s, p) => s + p.x, 0), sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0), sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

async function measure(mech, n) {
  const server2 = await firefox.launchServer({ headless: true });
  const pid = server2.process()?.pid;
  const browser = await firefox.connect(server2.wsEndpoint());
  const samples = [];
  const sampler = setInterval(() => { const v = treeRssMiB(pid); if (v != null) samples.push({ t: Date.now(), rss: v }); }, SAMPLE_MS);
  let out = {};
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/?mech=${mech}&n=${n}&mb=${MEDIUM_MB}`);
    await page.waitForFunction('window.__RESULT !== undefined', null, { timeout: 120000 });
    const r = await page.evaluate('window.__RESULT');
    clearInterval(sampler);
    const marks = r.marks || [];
    const runMark = marks.find((m) => m.label === 'run');
    const endMark = marks.find((m) => m.label === '/run');
    let peakDelta = null, pre = null;
    if (runMark && endMark) {
      const before = samples.filter((s) => s.t < runMark.t).map((s) => s.rss);
      const during = samples.filter((s) => s.t >= runMark.t && s.t <= endMark.t).map((s) => s.rss);
      const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
      pre = tail.length ? median(tail) : null;
      peakDelta = (during.length && pre != null) ? Math.max(...during) - pre : null;
    }
    out = { ok: r.ok, error: r.error, wallMs: r.wallMs, preMiB: pre, peakDeltaMiB: peakDelta };
  } catch (e) { clearInterval(sampler); out = { ok: false, error: `run: ${e.message?.split('\n')[0]}` }; }
  finally { await browser.close().catch(() => {}); await server2.close().catch(() => {}); }
  return out;
}

const report = { config: { NMEDIUMS, REPS, MEDIUM_MB, MECHS }, cells: [] };
for (const mech of MECHS) {
  for (const n of NMEDIUMS) {
    for (let rep = 1; rep <= REPS; rep++) {
      const r = await measure(mech, n);
      report.cells.push({ mech, n, rep, ...r });
      console.log(`${mech} n=${n} #${rep}  peakDelta=${r.peakDeltaMiB} wallMs=${r.wallMs?.toFixed?.(0)} ${r.error || ''}`);
    }
  }
}

report.slopes = {};
for (const mech of MECHS) {
  const pts = [];
  for (const n of NMEDIUMS) {
    const cells = report.cells.filter((c) => c.mech === mech && c.n === n && c.peakDeltaMiB != null);
    if (cells.length) pts.push({ x: n, y: median(cells.map((c) => c.peakDeltaMiB)) });
  }
  report.slopes[mech] = { slopeMiBPerFile: slope(pts), points: pts };
}
await new Promise((r) => server.close(r));
writeFileSync(join(HERE, 'results.json'), JSON.stringify(report, null, 2));
const t = report.slopes.transfer?.slopeMiBPerFile, w = report.slopes.workerfetch?.slopeMiBPerFile;
console.log(`\nSLOPE MiB/file — transfer=${t?.toFixed?.(2)} workerfetch=${w?.toFixed?.(2)}`);
if (t != null && w != null) console.log(w < t ? `workerfetch is LOWER by ${(t - w).toFixed(2)} MiB/file (${Math.round((1 - w / t) * 100)}% less)` : `workerfetch NOT lower`);
console.log('wrote', join(HERE, 'results.json'));
