#!/usr/bin/env node
// E2E runner: build the app (so browser specs have dist/index.html), then run the e2e test
// files with the node test runner. Each spec self-boots its stack (mock S3 + app server) via
// the harness, so no long-lived orchestration is needed here.
//
//   node test/e2e/run.mjs            → node-integration + browser layers
//   node test/e2e/run.mjs node       → node-integration only (mock-s3 + node, no browser)
//   node test/e2e/run.mjs browser    → browser only
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const layer = process.argv[2] || 'all';

const dirs = layer === 'node'    ? ['test/e2e/mock-s3', 'test/e2e/node']
           : layer === 'browser' ? ['test/e2e/browser']
           : ['test/e2e/mock-s3', 'test/e2e/node', 'test/e2e/browser'];

// This Node version's `--test` imports directory args rather than searching them, so collect
// the *.test.mjs files explicitly and pass them as paths.
function collect(dir) {
  let out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out = out.concat(collect(p));
    else if (e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

function run(args) {
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
}

try {
  if (layer !== 'node') {
    // Build to perf/ (gitignored), NOT dist/ — keeps the committed dist/index.html pristine and
    // avoids interfering with build.test.js, which asserts on the prod dist build.
    console.log('\n── Building app for browser e2e (→ perf/index.html) ──\n');
    run(['build.mjs', '--mode=perf']);
  }
  const files = dirs.flatMap(collect);
  console.log(`\n── Running e2e layer: ${layer} (${files.length} files) ──\n`);
  // Serialize test files (--test-concurrency=1): the browser specs each launch Chromium, and
  // running them concurrently overloads the machine and causes timeout flakes. Serial is slower
  // but deterministic — the right trade for browser e2e.
  run(['--test', '--test-concurrency=1', ...files]);
} catch (err) {
  process.exit(err.status ?? 1);
}
