#!/usr/bin/env node
// Containerized e2e (GitLab #47): run the full cross-engine + mobile matrix locally in the
// official Playwright image — the same image CI uses — so WebKit (whose system deps cannot
// be installed on a stock Fedora host) runs locally too.
//
//   npm run test:e2e:container                       → full 3×3 matrix in the container
//   E2E_ENGINES=webkit npm run test:e2e:container    → WebKit-only lane, containerized
//   E2E_ENGINE=webkit E2E_DEVICES="Pixel 5" ...      → any env the harness understands passes through
//
// Design (docs/superpowers/specs/2026-07-12-containerized-e2e-design.md):
// - podman preferred (rootless, Fedora default), docker fallback.
// - Image tag derives from the LOCKED playwright version so browsers always match the suite.
// - The repo bind-mounts at /work (:Z — SELinux relabel, standard for rootless Podman);
//   a named volume overlays /work/node_modules so the container keeps its own jammy
//   npm ci, never touching host node_modules. A lock-hash marker skips reinstall while
//   package-lock.json is unchanged.
// - --ipc=host per Playwright's container guidance (Chromium shared memory).
// - Everything (mock S3, app server, browsers) runs inside — no ports published.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { imageTagFromLock, pickRuntime } from '../test/e2e/matrix-helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOLUME = 'bucketer-e2e-node_modules';

function available(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

const runtime = pickRuntime(['podman', 'docker'].filter(available));
if (!runtime) {
  console.error('No container runtime found: install podman (preferred) or docker.');
  process.exit(1);
}

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const image = imageTagFromLock(lock);
const lockHash = createHash('sha256').update(readFileSync(join(ROOT, 'package-lock.json'))).digest('hex');

// npm ci only when the lock changed since the volume's last install (npm ci wipes
// node_modules by design, so an unconditional ci would re-download every run).
const script = [
  'set -e',
  'cd /work',
  'if [ ! -f node_modules/.bucketer-lock-hash ] || [ "$(cat node_modules/.bucketer-lock-hash)" != "$LOCK_HASH" ]; then',
  '  echo "── npm ci (lockfile changed or first run) ──"',
  '  npm ci --no-audit --no-fund',
  '  echo "$LOCK_HASH" > node_modules/.bucketer-lock-hash',
  'fi',
  'npm run test:e2e:matrix',
].join('\n');

// Harness/matrix env passes through so single-combo containerized runs work too.
const PASS_ENV = ['E2E_ENGINES', 'E2E_DEVICES', 'E2E_ENGINE', 'E2E_DEVICE', 'E2E_JUNIT'];
const envArgs = PASS_ENV.filter((k) => process.env[k]).flatMap((k) => ['-e', `${k}=${process.env[k]}`]);

console.log(`── containerized e2e: ${runtime} + ${image} (volume ${VOLUME}) ──`);
const r = spawnSync(runtime, [
  'run', '--rm', '--ipc=host',
  '-v', `${ROOT}:/work:Z`,
  '-v', `${VOLUME}:/work/node_modules`,
  '-w', '/work',
  '-e', `LOCK_HASH=${lockHash}`,
  ...envArgs,
  image,
  'bash', '-c', script,
], { stdio: 'inherit' });
process.exit(r.status ?? 1);
