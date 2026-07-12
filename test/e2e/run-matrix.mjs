#!/usr/bin/env node
// E2E matrix runner (GitLab #47): the node-integration layer once, then the browser layer
// across every engine × device combo — the same 9-combo grid CI's parallel:matrix runs,
// but in one local invocation. Each combo spawns the existing run.mjs with E2E_ENGINE /
// E2E_DEVICE set, so the harness behaves identically to a single-combo run.
//
//   npm run test:e2e:matrix                                   → full 3×3 matrix + node layer
//   E2E_ENGINES=chromium,firefox npm run test:e2e:matrix      → host-safe subset (no WebKit deps)
//   E2E_DEVICES="desktop,Pixel 5" npm run test:e2e:matrix     → chosen devices ("desktop" = no profile)
//
// WebKit needs system deps a stock Fedora host lacks — run the full matrix through
// scripts/e2e-container.mjs (npm run test:e2e:container), which uses the Playwright image.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseListEnv, parseDeviceListEnv, buildCombos, comboLabel, DEFAULT_ENGINES } from './matrix-helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = join(ROOT, 'test', 'e2e', 'run.mjs');

const engines = parseListEnv(process.env.E2E_ENGINES, DEFAULT_ENGINES);
const devices = parseDeviceListEnv(process.env.E2E_DEVICES);
const combos = buildCombos(engines, devices);

function runLayer(layer, env) {
  const r = spawnSync(process.execPath, [RUN, layer], { stdio: 'inherit', cwd: ROOT, env });
  return r.status === 0;
}

const results = [];

console.log(`\n══ e2e matrix: node layer + ${combos.length} browser combo(s) (${engines.join(', ')} × ${devices.map((d) => d || 'desktop').join(', ')}) ══`);

const nodeOk = runLayer('node', process.env);
results.push({ label: 'node layer', ok: nodeOk });

for (const combo of combos) {
  console.log(`\n══ browser combo: ${comboLabel(combo)} ══`);
  const env = { ...process.env, E2E_ENGINE: combo.engine };
  if (combo.device) env.E2E_DEVICE = combo.device; else delete env.E2E_DEVICE;
  results.push({ label: comboLabel(combo), ok: runLayer('browser', env) });
}

const failed = results.filter((r) => !r.ok);
console.log('\n══ e2e matrix summary ══');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} lanes FAILED` : `\nAll ${results.length} lanes passed`);
process.exit(failed.length ? 1 : 0);
