// Bundle the presign bench with esbuild (same settings as the app build), then time it in
// real engines.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));  // run from the repo root
const built = await esbuild.build({
  entryPoints: [here + 'entry.js'],
  bundle: true, format: 'iife', write: false, minify: false, target: 'es2020',
});
const js = built.outputFiles[0].text;

const html = `<!doctype html><meta charset="utf-8"><title>presign bench</title><body><pre id=o>…</pre><script>${js}</script>`;
const server = http.createServer((_q, r) => {
  r.setHeader('Content-Type', 'text/html; charset=utf-8'); r.end(html);
});
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const LAUNCH = { chromium, firefox, webkit };
const out = {};
for (const name of (process.env.ENGINES || 'chromium,firefox,webkit').split(',')) {
  let b;
  try { b = await LAUNCH[name].launch(); }
  catch (e) { out[name] = { launchError: e.message.split('\n')[0] }; continue; }
  try {
    const page = await b.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    out[name] = await page.evaluate(({ ep, bk }) =>
      window.__runPresignBench({ endpoint: ep, bucket: bk }), { ep: 'http://127.0.0.1:9', bk: 'test-bucket' });
  } catch (e) {
    out[name] = { error: e.message.split('\n')[0] };
  } finally { await b.close(); }
}
await new Promise(r => server.close(r));

const f = n => (n == null ? '--' : n.toFixed(3));
console.log('\nSigV4 presign cost, milliseconds per call\n');
console.log('engine      median   mean    min     max    fresh-client  worst frame gap in a 256-call burst');
for (const [k, v] of Object.entries(out)) {
  if (v.launchError || v.error) { console.log(`${k.padEnd(12)}${v.launchError || v.error}`); continue; }
  console.log(`${k.padEnd(12)}${f(v.reused.median).padStart(6)}${f(v.reused.mean).padStart(8)}`
    + `${f(v.reused.min).padStart(8)}${f(v.reused.max).padStart(8)}`
    + `${f(v.freshClient.median).padStart(14)}${f(v.burst256.worstFrameGapMs).padStart(12)} ms`);
}

console.log('\nImplied overhead of signing every chunk instead of once per file:');
for (const [k, v] of Object.entries(out)) {
  if (!v.reused) continue;
  for (const [chunkMiB, label] of [[8, '8 MiB chunks'], [32, '32 MiB chunks']]) {
    const chunks = Math.ceil(2048 / chunkMiB);
    console.log(`  ${k.padEnd(10)} 2 GiB file, ${label.padEnd(14)} ${chunks} signings `
      + `= ${(chunks * v.reused.median).toFixed(0)} ms total`);
  }
}
