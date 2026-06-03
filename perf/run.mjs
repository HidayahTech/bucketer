#!/usr/bin/env node
// Orchestrator for npm run perftest.
// Builds a perf artifact to perf/index.html, starts mock S3 + inline app
// server, runs all benchmarks, then cleans up. Never touches dist/.

import { spawn, execFileSync } from 'child_process';
import { createServer }        from 'http';
import { readFileSync }        from 'fs';
import { fileURLToPath }       from 'url';
import { dirname, join }       from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const MOCK_S3_PORT = process.env.MOCK_S3_PORT ?? '9090';
const APP_PORT     = process.env.PORT         ?? '3099';

let s3Proc, appServer;

function cleanup() {
  try { s3Proc?.kill();    } catch {}
  try { appServer?.close(); } catch {}
}

process.on('exit',    cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const id   = setTimeout(() => ctrl.abort(), 1000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(id);
      return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(label, args, env = {}) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(` ${label}`);
  console.log('─'.repeat(50) + '\n');
  execFileSync(process.execPath, args, {
    stdio: 'inherit',
    cwd:   ROOT,
    env:   { ...process.env, ...env },
  });
}

// ── Phase 1: Algorithmic microbenchmarks (no servers needed) ──────────────────
run('Phase 1 — algorithmic microbenchmarks', [join(__dirname, 'bench-algorithms.mjs')]);

// ── Build perf artifact → perf/index.html (never touches dist/) ───────────────
console.log('\n' + '─'.repeat(50));
console.log(' Phase 2 — browser benchmark (building + starting servers…)');
console.log('─'.repeat(50) + '\n');

execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--mode=perf'], {
  stdio: 'inherit',
  cwd:   ROOT,
});

// ── Start mock S3 server ──────────────────────────────────────────────────────
s3Proc = spawn(process.execPath, [join(__dirname, 'mock-s3.mjs')], {
  env:   { ...process.env, MOCK_S3_PORT },
  stdio: ['ignore', 'pipe', 'inherit'],
});
s3Proc.stdout.on('data', d => process.stdout.write(d));
s3Proc.on('error', err => { console.error('mock-s3 error:', err.message); cleanup(); process.exit(1); });

// ── Start inline app server serving perf/index.html ──────────────────────────
const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
appServer   = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((resolve, reject) => {
  appServer.listen(parseInt(APP_PORT, 10), '127.0.0.1', resolve);
  appServer.on('error', reject);
});
console.log(`Perf app server ready on http://localhost:${APP_PORT}`);

await waitForHttp(`http://localhost:${MOCK_S3_PORT}/`);

// ── Phase 2: Browser benchmark ────────────────────────────────────────────────
// Must use spawn (not execFileSync) so the event loop stays alive to serve
// HTTP requests from the inline app server while Playwright runs.
console.log(`\n${'─'.repeat(50)}`);
console.log(' Phase 2 — browser benchmark');
console.log('─'.repeat(50) + '\n');

await new Promise((resolve, reject) => {
  const proc = spawn(
    process.execPath,
    [join(__dirname, 'bench-browser.mjs')],
    {
      stdio: 'inherit',
      cwd:   ROOT,
      env:   { ...process.env, APP_URL: `http://localhost:${APP_PORT}`, MOCK_S3_URL: `http://localhost:${MOCK_S3_PORT}` },
    }
  );
  proc.on('close', code => code === 0 ? resolve() : reject(new Error(`bench-browser exited ${code}`)));
  proc.on('error', reject);
});

cleanup();
