#!/usr/bin/env node
// One-shot backfill tool. Walks every version in the project's Generic Package
// Registry, fetches the published bucketer-v{VERSION}.html, computes SHA-256,
// and uploads a matching bucketer-v{VERSION}.integrity.json next to it.
//
// Idempotent: skips versions where the manifest already exists.
// Safe to re-run.
//
// Uses `glab api` for authenticated uploads, so the developer needs glab logged
// in (`glab auth status`). Reads (HTML fetch, manifest HEAD) are unauthenticated.
//
// Usage:
//   node scripts/backfill-integrity-manifests.mjs --dry-run
//   node scripts/backfill-integrity-manifests.mjs

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const PROJECT_PATH = 'hidayahtech%2Fbucketer';
const API_BASE     = `https://gitlab.com/api/v4/projects/${PROJECT_PATH}`;
const PKG_BASE     = `${API_BASE}/packages/generic/bucketer`;

const DRY_RUN = process.argv.includes('--dry-run');

async function listVersions() {
  const versions = new Set();
  for (let page = 1; ; page++) {
    const res = await fetch(`${API_BASE}/packages?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`packages list failed: HTTP ${res.status}`);
    const pkgs = await res.json();
    if (pkgs.length === 0) break;
    for (const p of pkgs) {
      if (p.version) versions.add(p.version);
    }
    if (pkgs.length < 100) break;
  }
  return [...versions].sort(semverCompare);
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function manifestExists(version) {
  const url = `${PKG_BASE}/${version}/bucketer-v${version}.integrity.json`;
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

async function fetchAndHash(version) {
  const url = `${PKG_BASE}/${version}/bucketer-v${version}.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch HTML failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { bytes: buf.length, sha256 };
}

async function uploadManifest(version, manifest) {
  const body = JSON.stringify(manifest, null, 2) + '\n';
  const path = `projects/${PROJECT_PATH}/packages/generic/bucketer/${version}/bucketer-v${version}.integrity.json`;
  return new Promise((resolve, reject) => {
    const proc = spawn('glab', ['api', '--method', 'PUT', '--input', '-', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`glab api exited ${code}: ${(stderr || stdout).slice(0, 200)}`));
    });
    proc.stdin.end(body);
  });
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writes to Package Registry)'}`);
  const versions = await listVersions();
  console.log(`Found ${versions.length} versions in Package Registry.\n`);

  const results = { skipped: 0, processed: 0, failed: 0 };

  for (const version of versions) {
    process.stdout.write(`v${version.padEnd(10)} `);
    try {
      if (await manifestExists(version)) {
        console.log('skip (manifest already exists)');
        results.skipped++;
        continue;
      }
      const { bytes, sha256 } = await fetchAndHash(version);
      const manifest = {
        version,
        filename: `bucketer-v${version}.html`,
        hashes: { sha256 },
      };
      if (DRY_RUN) {
        console.log(`would upload  ${bytes}B  sha256:${sha256.slice(0, 16)}…`);
      } else {
        await uploadManifest(version, manifest);
        console.log(`uploaded      ${bytes}B  sha256:${sha256.slice(0, 16)}…`);
      }
      results.processed++;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      results.failed++;
    }
  }

  console.log(`\nDone. Skipped: ${results.skipped}  ${DRY_RUN ? 'Would-upload' : 'Uploaded'}: ${results.processed}  Failed: ${results.failed}`);
  if (results.failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
