// Turn repeated trials into reportable statistics and charts.
//
// Reports the median across repetitions with the observed spread, never a lone value: the
// point of repeating a measurement is to be able to say how stable it is.
//
// The headline numbers come from results-download.json, which measures a real <a download>
// driven by the browser's own download machinery. results-trials.json holds a supporting
// sweep that reads bytes back through fetch() instead; that is a different operation and its
// figures are not interchangeable with these.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lineChart, barChart } from './chart.mjs';

const load = f => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const dl = load('./results-download.json');
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const SIZES = dl.config.SIZES;
const ENGINES = dl.config.ENGINES;

// (engine, mech, size, span) -> values
const cell = new Map();
for (const r of dl.runs) {
  for (const [span, v] of Object.entries(r.spans || {})) {
    if (v.peakDeltaMiB == null) continue;
    const k = `${r.engine}|${r.mech}|${r.size}|${span}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(v.peakDeltaMiB);
  }
}
const st = (e, m, sz, sp) => {
  const v = cell.get(`${e}|${m}|${sz}|${sp}`);
  return v?.length ? { med: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null;
};
const prepareSpan = m => (m === 'opfs-dl' ? 'write' : 'build');

// Total = preparing the file + the browser downloading it.
const total = (e, m, sz) => {
  const p = st(e, m, sz, prepareSpan(m));
  const d = st(e, m, sz, 'download');
  return (p && d) ? p.med + d.med : null;
};

console.log('PEAK MEMORY, MiB — median (min..max) over 3 reps, real <a download> path\n');
for (const e of ENGINES) {
  console.log(`== ${e} ==`);
  console.log('  ' + 'mechanism / phase'.padEnd(26) + SIZES.map(s => `${s} MiB`.padStart(18)).join(''));
  for (const m of ['opfs-dl', 'blob-dl']) {
    for (const sp of [prepareSpan(m), 'download']) {
      let row = '  ' + `${m === 'opfs-dl' ? 'private storage' : 'in memory'}: ${sp}`.padEnd(26);
      for (const sz of SIZES) {
        const s = st(e, m, sz, sp);
        row += (s ? `${s.med} (${s.min}..${s.max})` : '--').padStart(18);
      }
      console.log(row);
    }
    let row = '  ' + `  TOTAL`.padEnd(26);
    for (const sz of SIZES) row += (total(e, m, sz) ?? '--').toString().padStart(18);
    console.log(row + '\n');
  }
}

console.log('TOTAL COST AS A FRACTION OF FILE SIZE');
for (const e of ENGINES) {
  for (const m of ['opfs-dl', 'blob-dl']) {
    const fr = SIZES.map(sz => { const t = total(e, m, sz); return t == null ? '--' : (t / sz).toFixed(2); });
    console.log(`  ${e.padEnd(10)} ${m.padEnd(9)} ${fr.map(f => f.padStart(8)).join('')}`);
  }
}

// ── Charts ─────────────────────────────────────────────────────────────────────
const assets = fileURLToPath(new URL('../../../assets', import.meta.url));
mkdirSync(assets, { recursive: true });

const series = [];
for (const e of ENGINES) {
  for (const m of ['blob-dl', 'opfs-dl']) {
    const pts = SIZES.map(sz => [sz, total(e, m, sz)]).filter(p => p[1] != null);
    if (pts.length) {
      // Short names: the legend sits in a fixed gutter, and long labels clip.
      series.push({
        name: `${e[0].toUpperCase() + e.slice(1)}, ${m === 'opfs-dl' ? 'storage' : 'memory'}`,
        points: pts,
      });
    }
  }
}
writeFileSync(`${assets}/02-scaling.svg`, lineChart({
  title: 'Total memory cost of downloading a file',
  xLabel: 'File size (MiB)', yLabel: 'Peak memory used (MiB)',
  xTicks: SIZES, series,
  colors: true,
}));

const largest = SIZES[SIZES.length - 1];
writeFileSync(`${assets}/03-engines.svg`, barChart({
  title: `Memory cost of downloading a ${largest} MiB file`,
  yLabel: 'Peak memory used (MiB)',
  groups: ENGINES.map(e => e[0].toUpperCase() + e.slice(1)),
  series: [
    { name: 'In memory', values: ENGINES.map(e => total(e, 'blob-dl', largest)) },
    { name: 'Private storage', values: ENGINES.map(e => total(e, 'opfs-dl', largest)) },
  ],
}));

console.log('\nwrote assets/02-scaling.svg and assets/03-engines.svg');

// ── Capability presence and noise floor, from the supporting sweep ──────────────
try {
  const tr = load('./results-trials.json');
  console.log('\nNOISE FLOOR (control, allocates nothing)');
  for (const e of tr.config.ENGINES) {
    const v = tr.runs.filter(r => r.engine === e && r.mech === 'control')
      .map(r => r.spans?.idle?.peakDeltaMiB).filter(x => x != null);
    if (v.length) console.log(`  ${e.padEnd(10)} median ${median(v)} MiB  range ${Math.min(...v)}..${Math.max(...v)}`);
  }
  console.log('\nCAPABILITY PRESENCE');
  for (const e of tr.config.ENGINES) {
    const r = tr.runs.find(x => x.engine === e && x.presence);
    if (!r) continue;
    console.log(`  ${e}: lacks ${Object.entries(r.presence).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'nothing'}`);
  }
} catch { /* supporting sweep absent */ }
