#!/usr/bin/env node
// Integration check for the in-app integrity verifier against live GitLab.
//
// Exercises src/lib/integrity.js → verifyIntegrity() using real Node primitives
// (fetch, crypto.webcrypto.subtle) against real Generic Package Registry
// artifacts. Stronger than the unit tests in test/integrity.test.js, which use
// stubs — this hits the network and proves the production code path works
// end-to-end against historical data.
//
// Not part of `npm test`: this hits external services and would be slow/flaky
// in CI. Run manually when you want to (re)verify the backfill or after any
// change to integrity.js or release tooling.
//
// Cases cover:
//   - positive (match) across the version range
//   - negative (mismatch) using mismatched bytes vs manifest from different versions
//   - missing-manifest path against a never-released version
//
// Usage:
//   node scripts/verify-historical-manifests.mjs
//
// Exits 0 if all cases produce the expected result, 1 otherwise.

import { verifyIntegrity } from '../src/lib/integrity.js';
import { webcrypto } from 'node:crypto';

const PKG = 'https://gitlab.com/api/v4/projects/hidayahtech%2Fbucketer/packages/generic/bucketer';

const cases = [
  // Positive: page bytes and manifest both for the same version.
  { label: 'v1.0.0  (oldest)',                    version: '1.0.0',  pageUrl: `${PKG}/1.0.0/bucketer-v1.0.0.html`,   expect: 'match' },
  { label: 'v1.10.2 (one of 3 same-size patches)',version: '1.10.2', pageUrl: `${PKG}/1.10.2/bucketer-v1.10.2.html`, expect: 'match' },
  { label: 'v1.13.0 (post-parallel-delete jump)', version: '1.13.0', pageUrl: `${PKG}/1.13.0/bucketer-v1.13.0.html`, expect: 'match' },
  { label: 'v1.16.0 (T1-T5 backlog era)',         version: '1.16.0', pageUrl: `${PKG}/1.16.0/bucketer-v1.16.0.html`, expect: 'match' },
  { label: 'v1.21.1 (just before feature)',       version: '1.21.1', pageUrl: `${PKG}/1.21.1/bucketer-v1.21.1.html`, expect: 'match' },

  // Negative: claim version=v1.20.0, but feed v1.21.0 bytes. Manifest URL uses
  // `version`, so we fetch v1.20.0's manifest and validate against v1.21.0 bytes.
  { label: 'cross: bytes=v1.21.0 vs manifest=v1.20.0', version: '1.20.0', pageUrl: `${PKG}/1.21.0/bucketer-v1.21.0.html`, expect: 'mismatch' },

  // Missing manifest: version that does not exist.
  { label: 'no-manifest: v0.0.1 (never released)', version: '0.0.1', pageUrl: `${PKG}/1.0.0/bucketer-v1.0.0.html`, expect: 'no-manifest' },
];

function summarize(result) {
  if (result.status === 'match')    return result.hash.slice(0, 16) + '…';
  if (result.status === 'mismatch') return `actual=${result.actual.slice(0, 12)}… expected=${result.expected.slice(0, 12)}…`;
  if (result.status === 'network-error') return result.message;
  return '';
}

console.log(`Running ${cases.length} cases through src/lib/integrity.js → verifyIntegrity()`);
console.log('-'.repeat(78));

let pass = 0, fail = 0;
for (const c of cases) {
  const result = await verifyIntegrity({
    version: c.version,
    pageUrl: c.pageUrl,
    fetchFn: fetch,
    subtle: webcrypto.subtle,
  });
  const ok = result.status === c.expect;
  if (ok) pass++; else fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.label.padEnd(50)} ` +
    `expect=${c.expect.padEnd(12)} got=${result.status.padEnd(12)} ${summarize(result)}`
  );
}

console.log('-'.repeat(78));
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
