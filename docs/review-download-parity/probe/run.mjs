// Matrix runner: one fresh browser per measurement, repeated, with a control.
//
// Design rationale — every earlier version of this measurement was wrong in a way that
// looked plausible, so the method is now built to make those failures impossible rather
// than to detect them:
//
//   * ONE mechanism at ONE size per browser launch. Nothing can inherit a previous
//     operation's uncollected memory, because there is no previous operation.
//   * REPEATED. Every cell runs N times; the report shows median and spread. A single
//     number cannot distinguish a finding from noise.
//   * A CONTROL that allocates nothing. Whatever it reports is the noise floor, and no
//     smaller result anywhere is meaningful.
//   * Profiles on real disk, never tmpfs, or "disk" writes silently become memory writes.
//   * Sampling far faster than the shortest operation being sampled.
import http from 'node:http';
import { readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const SIZES = JSON.parse(process.env.SIZES || '[64,256,1024,2048]');
const MECHS = (process.env.MECHS || 'control,opfs,blob,idb').split(',');
const ENGINES = (process.env.ENGINES || 'chromium,firefox,webkit').split(',');
const REPS = parseInt(process.env.REPS || '3', 10);
const SAMPLE_MS = 40;

const html = readFileSync(new URL('./probe.html', import.meta.url), 'utf8');
const server = http.createServer((_q, r) => {
  r.setHeader('Content-Type', 'text/html; charset=utf-8');
  r.end(html);
});
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

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

const LAUNCHERS = { chromium, firefox, webkit };
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// One measurement: fresh browser, fresh profile, one mechanism, one size.
async function measure(engine, mech, size, rep) {
  const dir = `${PROFILE_ROOT}/${engine}-${mech}-${size}-${rep}`;
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
  let dlSpan = null;
  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/?mech=${mech}&size=${size}`);
    await page.waitForFunction('window.__RESULT !== undefined', null, { timeout: 600000 });
    const r = await page.evaluate('window.__RESULT');

    // For the -dl mechanisms the file is only prepared; the real download is triggered here
    // so the browser's own download path is what gets measured, not a fetch() proxy.
    if (r.awaitingDownload) {
      await new Promise(res => setTimeout(res, 2000));   // let preparation settle
      const t0 = Date.now();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 600000 }),
        page.evaluate('window.__triggerDownload()'),
      ]);
      let savedBytes = null;
      try {
        const p = await download.path();
        savedBytes = p ? statSync(p).size : null;
      } catch { /* engine did not expose a path */ }
      const t1 = Date.now();
      await new Promise(res => setTimeout(res, 2000));
      dlSpan = { t0, t1, savedBytes };
    }
    clearInterval(sampler);

    // Attribute each marked span against the memory in use just before it began.
    const spans = {};
    const marks = r.marks || [];
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].label.startsWith('/')) continue;
      const close = marks.find(m => m.label === '/' + marks[i].label && m.t >= marks[i].t);
      if (!close) continue;
      const before = samples.filter(s => s.t < marks[i].t).map(s => s.rss);
      const during = samples.filter(s => s.t >= marks[i].t && s.t <= close.t).map(s => s.rss);
      const after = samples.filter(s => s.t > close.t && s.t <= close.t + 2000).map(s => s.rss);
      // Pre-value is the median of the last second, not a single sample, so one spike
      // in the settling window cannot define the baseline.
      const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
      const pre = tail.length ? median(tail) : null;
      spans[marks[i].label] = {
        preMiB: pre,
        peakDeltaMiB: (during.length && pre != null) ? Math.max(...during) - pre : null,
        settledDeltaMiB: (after.length && pre != null) ? median(after) - pre : null,
        ms: close.t - marks[i].t,
      };
    }

    // The control has no marks; measure the whole post-ready window instead.
    if (mech === 'control' && samples.length > 20) {
      const half = Math.floor(samples.length / 2);
      const pre = median(samples.slice(0, half).map(s => s.rss));
      const rest = samples.slice(half).map(s => s.rss);
      spans.idle = { preMiB: pre, peakDeltaMiB: Math.max(...rest) - pre,
                     settledDeltaMiB: median(rest) - pre, ms: 2000 };
    }

    if (dlSpan) {
      const before = samples.filter(s => s.t < dlSpan.t0).map(s => s.rss);
      const during = samples.filter(s => s.t >= dlSpan.t0 && s.t <= dlSpan.t1).map(s => s.rss);
      const after = samples.filter(s => s.t > dlSpan.t1 && s.t <= dlSpan.t1 + 2000).map(s => s.rss);
      const tail = before.slice(-Math.ceil(1000 / SAMPLE_MS));
      const pre = tail.length ? median(tail) : null;
      spans.download = {
        preMiB: pre,
        peakDeltaMiB: (during.length && pre != null) ? Math.max(...during) - pre : null,
        settledDeltaMiB: (after.length && pre != null) ? median(after) - pre : null,
        ms: dlSpan.t1 - dlSpan.t0,
        savedBytes: dlSpan.savedBytes,
      };
    }

    out = { ok: r.ok, error: r.error, quota: r.quota, presence: r.presence, spans,
            bytes: r.detail?.bytes, readBack: r.detail?.readBack };
  } catch (e) {
    clearInterval(sampler);
    out = { error: `run: ${e.message?.split('\n')[0]}` };
  } finally {
    await ctx.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const report = { config: { SIZES, MECHS, ENGINES, REPS, SAMPLE_MS }, runs: [] };
let done = 0;
const total = ENGINES.length * MECHS.length * SIZES.length * REPS;

for (const engine of ENGINES) {
  for (const mech of MECHS) {
    for (const size of (mech === 'control' ? [0] : SIZES)) {
      for (let rep = 1; rep <= REPS; rep++) {
        const r = await measure(engine, mech, size, rep);
        report.runs.push({ engine, mech, size, rep, ...r });
        done++;
        const w = r.spans ? Object.entries(r.spans).map(([k, v]) => `${k}=${v.peakDeltaMiB}`).join(' ') : (r.error || '');
        console.log(`[${done}/${total}] ${engine} ${mech} ${size}MiB #${rep}  ${w}`);
      }
    }
  }
}

await new Promise(r => server.close(r));
writeFileSync(new URL(process.env.OUT_JSON || './results-trials.json', import.meta.url),
              JSON.stringify(report, null, 2));
console.log('\nwrote results-trials.json');
