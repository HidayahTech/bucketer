#!/usr/bin/env node
// Browser benchmark: injects files into the app, profiles the upload queue
// with the V8 CPU profiler via CDP, and reports top hotspots.
// Requires: app server on APP_URL, mock S3 on MOCK_S3_URL.
// Run via: node perf/run.mjs  (which starts both servers first)

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const FILE_COUNT = parseInt(process.env.BENCH_FILES  ?? '200',                    10);
const APP_URL    = process.env.APP_URL    ?? 'http://localhost:3000';
const S3_URL     = process.env.MOCK_S3_URL ?? 'http://localhost:9090';

mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`\nBrowser benchmark — ${FILE_COUNT} files → ${S3_URL}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page    = await context.newPage();

page.on('pageerror', err => process.stderr.write(`[page error] ${err.message}\n`));

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  // ── Fill credential form ──────────────────────────────────────────────────
  await page.locator('input[type="url"]').fill(S3_URL);
  await page.locator('input[placeholder="my-bucket"]').fill('test-bucket');
  await page.locator('input[placeholder="Access Key ID"]').fill('perf-key-id');
  await page.locator('input[placeholder="Secret Access Key"]').fill('perf-secret-key');

  // Region field appears for custom endpoints without an embedded region
  const regionInput = page.locator('input[placeholder="us-east-1"]');
  await regionInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await regionInput.isVisible()) {
    await regionInput.fill('us-east-1');
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  await page.locator('button[type="submit"]').click();
  await page.locator('.upload-zone').waitFor({ timeout: 15000 });

  // ── Build synthetic file list ─────────────────────────────────────────────
  const files = Array.from({ length: FILE_COUNT }, (_, i) => ({
    name:     `bench-${String(i).padStart(6, '0')}.txt`,
    mimeType: 'text/plain',
    buffer:   Buffer.from(`bench content ${i}`),
  }));

  // ── Start CDP profiler before injecting files ─────────────────────────────
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); // 0.1 ms

  const wallStart = Date.now();
  await cdp.send('Profiler.start');

  // ── Inject files via hidden file input ────────────────────────────────────
  await page.locator('[data-testid="file-input"]').setInputFiles(files);

  // ── Wait for queue to drain ───────────────────────────────────────────────
  const timeout = Math.max(60000, FILE_COUNT * 500);
  await page.locator('[data-testid="queue-complete"]').waitFor({ timeout });

  const wallMs = Date.now() - wallStart;

  // ── Stop profiler ─────────────────────────────────────────────────────────
  const { profile } = await cdp.send('Profiler.stop');

  // ── Save raw .cpuprofile ──────────────────────────────────────────────────
  const stamp       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const profilePath = join(OUTPUT_DIR, `profile-${FILE_COUNT}files-${stamp}.cpuprofile`);
  writeFileSync(profilePath, JSON.stringify(profile));

  // ── Analyse and report ────────────────────────────────────────────────────
  const summary = analyzeProfile(profile);
  const totalMs = profile.timeDeltas.reduce((a, b) => a + b, 0) / 1000;

  console.log(`Wall-clock time : ${wallMs} ms`);
  console.log(`CPU profiled    : ${totalMs.toFixed(0)} ms`);
  console.log(`Files processed : ${FILE_COUNT}`);
  console.log(`ms per file     : ${(wallMs / FILE_COUNT).toFixed(2)}\n`);

  console.log('Top functions by CPU self-time:\n');
  console.log('  ' + 'Function / location'.padEnd(44) + ' Self%   Self ms');
  console.log('  ' + '─'.repeat(60));
  for (const fn of summary) {
    const name = (fn.functionName || '(anonymous)') + (fn.lineNumber ? `:${fn.lineNumber}` : '');
    console.log(`  ${name.slice(0, 44).padEnd(44)} ${fn.pct.padStart(5)}  ${fn.selfMs.toFixed(1).padStart(8)}`);
  }

  console.log(`\nProfile saved → ${profilePath}`);
  console.log('To inspect: open Chrome/Chromium DevTools → Performance tab → load profile');

} finally {
  await browser.close();
}

function analyzeProfile(profile) {
  const nodeMap  = new Map(profile.nodes.map(n => [n.id, n]));
  const total    = profile.timeDeltas.reduce((a, b) => a + b, 0); // microseconds
  const usPerSample = total / profile.samples.length;

  const hits = new Map();
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1);

  const rows = [];
  for (const [id, count] of hits) {
    const node = nodeMap.get(id);
    if (!node) continue;
    const { functionName, lineNumber, url } = node.callFrame;
    // Skip pure V8 internals (no source location and no name)
    if (!functionName && !lineNumber) continue;
    const selfMs = (count * usPerSample) / 1000;
    const pct    = (count / profile.samples.length * 100).toFixed(1) + '%';
    rows.push({ functionName, lineNumber, url, selfMs, pct });
  }

  return rows.sort((a, b) => b.selfMs - a.selfMs).slice(0, 15);
}
