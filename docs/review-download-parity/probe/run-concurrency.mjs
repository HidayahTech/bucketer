// Matrix runner for the D6 throughput probe (docs/superpowers/specs/2026-08-04-download-
// concurrency-design.md): sequential (concurrency=1) vs bounded-prefetch (concurrency=4)
// on a many-small-files ZIP-download workload, and a mixed workload that also exercises
// the OPFS temp tier. Same method as run.mjs — see its header comment and the README's
// "Method, in one paragraph" — trimmed to this probe's shape (no real-download trigger;
// the measured span is runPrefetch() itself, marked by the page).
//
//   * ONE mechanism/workload/concurrency per browser launch.
//   * REPEATED — every cell runs REPS times; report shows median and spread.
//   * A CONTROL that allocates nothing establishes the noise floor.
//   * Profiles on real disk, never tmpfs.
//   * RSS sampled far faster than the shortest operation being sampled; OPFS usage
//     sampled in-page via navigator.storage.estimate() at the same cadence (ps cannot
//     see OPFS — those bytes are on disk under the profile dir, not in RSS).
import http from 'node:http';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const MECHS = (process.env.MECHS || 'control,prefetch').split(',');
const WORKLOADS = (process.env.WORKLOADS || 'tiny,mixed').split(',');
const CONCS = (process.env.CONCS || '1,4').split(',').map(Number);
const ENGINES = (process.env.ENGINES || 'chromium,firefox').split(',');
const REPS = parseInt(process.env.REPS || '3', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '50', 10);
const OPFS_POLL_MS = process.env.OPFS_POLL_MS; // investigation knob; unset = probe's own default (50ms)
const SAMPLE_MS = 40;

const html = readFileSync(new URL('./probe-concurrency.html', import.meta.url), 'utf8');
// Served so probe-concurrency.html can import the REAL zip-prefetch.js (and its real
// relative-import siblings) — the same module the app ships, not a reimplementation.
const LIB_FILES = {
  'zip-prefetch.js': readFileSync(new URL('../../../src/lib/zip-prefetch.js', import.meta.url), 'utf8'),
  'upload-queue.js': readFileSync(new URL('../../../src/lib/upload-queue.js', import.meta.url), 'utf8'),
  'zip-writer.js': readFileSync(new URL('../../../src/lib/zip-writer.js', import.meta.url), 'utf8'),
  'download-preflight.js': readFileSync(new URL('../../../src/lib/download-preflight.js', import.meta.url), 'utf8'),
  // upload-queue.js's only import is `ListPartsCommand` from '@aws-sdk/client-s3', used
  // solely by collectParts() — never reached by runPool, the only export this probe
  // exercises. Redirected here via the page's import map so the real source can be
  // served completely unmodified; the stub is never invoked.
  'aws-sdk-stub.js': 'export class ListPartsCommand {}\n',
};

const server = http.createServer((q, r) => {
  const path = q.url.split('?')[0];
  const libMatch = path.match(/^\/lib\/(.+)$/);
  if (libMatch && LIB_FILES[libMatch[1]]) {
    r.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    r.end(LIB_FILES[libMatch[1]]);
    return;
  }
  r.setHeader('Content-Type', 'text/html; charset=utf-8');
  r.end(html);
});
const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));

const PROFILE_ROOT = process.env.PROFILE_ROOT
  || fileURLToPath(new URL('../../../output/probe-profiles', import.meta.url));

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

const LAUNCHERS = { chromium, firefox };
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// One measurement: fresh browser, fresh profile, one mechanism/workload/concurrency.
async function measure(engine, mech, params, rep) {
  const tag = mech === 'control' ? 'control' : `prefetch-${params.workload}-c${params.concurrency}`;
  const dir = `${PROFILE_ROOT}/${engine}-${tag}-${rep}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let ctx;
  try { ctx = await LAUNCHERS[engine].launchPersistentContext(dir, {}); }
  catch (e) { return { error: `launch: ${e.message?.split('\n')[0]}` }; }

  let pid = null;
  try {
    pid = Math.min(...execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' })
      .trim().split('\n').map(Number).filter(Boolean));
  } catch { /* RSS simply unavailable */ }

  const samples = [];
  const sampler = setInterval(() => {
    const v = treeRssMiB(pid);
    if (v != null) samples.push({ t: Date.now(), rss: v });
  }, SAMPLE_MS);

  let out = {};
  try {
    const page = await ctx.newPage();
    const qs = new URLSearchParams({ mech, latency: String(LATENCY_MS) });
    if (OPFS_POLL_MS) qs.set('opfspoll', OPFS_POLL_MS);
    if (params.ntiny != null) qs.set('ntiny', String(params.ntiny));
    else if (process.env.NTINY) qs.set('ntiny', process.env.NTINY);
    if (params.nmedium != null) qs.set('nmedium', String(params.nmedium));
    else if (process.env.NMEDIUM) qs.set('nmedium', process.env.NMEDIUM);
    if (mech === 'prefetch') {
      qs.set('workload', params.workload);
      qs.set('concurrency', String(params.concurrency));
    }
    await page.goto(`http://127.0.0.1:${port}/?${qs}`);
    await page.waitForFunction('window.__RESULT !== undefined', null, { timeout: 120000 });
    const r = await page.evaluate('window.__RESULT');
    clearInterval(sampler);

    // Attribute the marked 'run' span against the memory in use just before it began —
    // same logic as run.mjs.
    const spans = {};
    const marks = r.marks || [];
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].label.startsWith('/')) continue;
      const close = marks.find(m => m.label === '/' + marks[i].label && m.t >= marks[i].t);
      if (!close) continue;
      const before = samples.filter(s => s.t < marks[i].t).map(s => s.rss);
      const during = samples.filter(s => s.t >= marks[i].t && s.t <= close.t).map(s => s.rss);
      const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
      const pre = tail.length ? median(tail) : null;
      spans[marks[i].label] = {
        preMiB: pre,
        peakDeltaMiB: (during.length && pre != null) ? Math.max(...during) - pre : null,
        ms: close.t - marks[i].t,
      };
    }
    if (mech === 'control' && samples.length > 10) {
      const half = Math.floor(samples.length / 2);
      const pre = median(samples.slice(0, half).map(s => s.rss));
      const rest = samples.slice(half).map(s => s.rss);
      spans.idle = { preMiB: pre, peakDeltaMiB: Math.max(...rest) - pre, ms: 2000 };
    }

    out = { ok: r.ok, error: r.error, spans, detail: r.detail };
  } catch (e) {
    clearInterval(sampler);
    out = { error: `run: ${e.message?.split('\n')[0]}` };
  } finally {
    await ctx.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// SCALE_NMEDIUMS mode: an orthogonal sweep added after an initial run surfaced a
// Firefox-specific finding — see task-8-report.md. Holds concurrency fixed at 1 and
// varies only the medium-file COUNT (ntiny=0, so nothing but the OPFS temp-tier path
// runs) to test whether RSS scales with cumulative bytes cycled through the temp store
// rather than with concurrency. Independent of the normal MECHS/WORKLOADS/CONCS loop
// below so a scale-sweep invocation doesn't also have to pay for the full matrix.
const SCALE_NMEDIUMS = process.env.SCALE_NMEDIUMS ? process.env.SCALE_NMEDIUMS.split(',').map(Number) : null;

const report = { config: { MECHS, WORKLOADS, CONCS, ENGINES, REPS, LATENCY_MS, SAMPLE_MS, SCALE_NMEDIUMS }, runs: [] };
let done = 0;

if (SCALE_NMEDIUMS) {
  const total = ENGINES.length * SCALE_NMEDIUMS.length * REPS;
  for (const engine of ENGINES) {
    for (const nmedium of SCALE_NMEDIUMS) {
      for (let rep = 1; rep <= REPS; rep++) {
        const r = await measure(engine, 'prefetch', { workload: 'mixed', concurrency: 1, nmedium, ntiny: 0 }, rep);
        report.runs.push({ engine, mech: 'prefetch', workload: 'mixed', concurrency: 1, nmedium, ntiny: 0, rep, ...r });
        done++;
        const w = r.spans?.run
          ? `wallMs=${r.detail?.wallMs?.toFixed(0)} rssDelta=${r.spans.run.peakDeltaMiB} opfsPeakMiB=${r.detail?.opfsPeakMiB}`
          : (r.error || '');
        console.log(`[${done}/${total}] ${engine} scale nmedium=${nmedium} #${rep}  ${w}`);
      }
    }
  }
  await new Promise(r => server.close(r));
  writeFileSync(new URL(process.env.OUT_JSON || './results-zip-concurrency-scale.json', import.meta.url),
                JSON.stringify(report, null, 2));
  console.log('\nwrote', process.env.OUT_JSON || './results-zip-concurrency-scale.json');
  process.exit(0);
}

const cellsPerEngine = MECHS.reduce((n, mech) => n + (mech === 'control' ? 1 : WORKLOADS.length * CONCS.length), 0);
const total = ENGINES.length * cellsPerEngine * REPS;

for (const engine of ENGINES) {
  for (const mech of MECHS) {
    const cells = mech === 'control' ? [{}] : WORKLOADS.flatMap(workload => CONCS.map(concurrency => ({ workload, concurrency })));
    for (const params of cells) {
      for (let rep = 1; rep <= REPS; rep++) {
        const r = await measure(engine, mech, params, rep);
        report.runs.push({ engine, mech, ...params, rep, ...r });
        done++;
        const w = r.spans?.run
          ? `wallMs=${r.detail?.wallMs?.toFixed(0)} rssDelta=${r.spans.run.peakDeltaMiB} opfsPeakMiB=${r.detail?.opfsPeakMiB}`
          : (r.spans?.idle ? `idleDelta=${r.spans.idle.peakDeltaMiB}` : (r.error || ''));
        console.log(`[${done}/${total}] ${engine} ${mech} ${params.workload || ''} c${params.concurrency || ''} #${rep}  ${w}`);
      }
    }
  }
}

await new Promise(r => server.close(r));
writeFileSync(new URL(process.env.OUT_JSON || './results-zip-concurrency.json', import.meta.url),
              JSON.stringify(report, null, 2));
console.log('\nwrote', process.env.OUT_JSON || './results-zip-concurrency.json');
