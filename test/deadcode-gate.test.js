// Unit tests for the dead-code ratchet gate's pure logic (diff + knip-JSON normalization).
// The gate's actual knip invocation is exercised end-to-end by the acceptance procedure
// (docs/review-deadcode-tooling/acceptance-evidence.md), not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFindings, normalizeKnip } from '../scripts/deadcode-gate.mjs';

const base = [
  { file: 'a.js', identifier: 'foo', kind: 'exports', reason: 'test-only', note: 'x', added: '2026-09-13' },
];

test('a new finding not in baseline is unexpected', () => {
  const cur = [
    { file: 'a.js', identifier: 'foo', kind: 'exports' },
    { file: 'b.js', identifier: 'bar', kind: 'exports' },
  ];
  const { unexpected, stale } = diffFindings(cur, base);
  assert.deepEqual(unexpected, [{ file: 'b.js', identifier: 'bar', kind: 'exports' }]);
  assert.equal(stale.length, 0);
});

test('a baseline entry with no matching finding is stale', () => {
  const { unexpected, stale } = diffFindings([], base);
  assert.equal(unexpected.length, 0);
  assert.deepEqual(stale, base);
});

test('exact baseline match is clean', () => {
  const cur = [{ file: 'a.js', identifier: 'foo', kind: 'exports' }];
  const { unexpected, stale } = diffFindings(cur, base);
  assert.equal(unexpected.length, 0);
  assert.equal(stale.length, 0);
});

test('normalizeKnip flattens per-file category arrays into findings', () => {
  const json = {
    issues: [
      {
        file: 'src/lib/format.js',
        exports: [{ name: '__probe', line: 77, col: 17 }],
        types: [],
        files: [],
        dependencies: [],
        devDependencies: [],
      },
    ],
  };
  const out = normalizeKnip(json);
  assert.deepEqual(out, [{ file: 'src/lib/format.js', identifier: '__probe', kind: 'exports' }]);
});

test('normalizeKnip handles string entries (dependency names) and empty input', () => {
  assert.deepEqual(normalizeKnip({ issues: [] }), []);
  const out = normalizeKnip({ issues: [{ file: 'package.json', devDependencies: ['purgecss'] }] });
  assert.deepEqual(out, [{ file: 'package.json', identifier: 'purgecss', kind: 'devDependencies' }]);
});
