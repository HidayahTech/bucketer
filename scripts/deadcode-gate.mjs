#!/usr/bin/env node
// Dead-code ratchet gate. Runs knip, normalizes its JSON findings, and diffs them
// bidirectionally against the committed deadcode-baseline.json:
//   - a finding NOT in the baseline  → the gate has caught new dead code (fail)
//   - a baseline entry with NO matching finding → the code was fixed; delete the stale
//     row (fail, so the baseline can only shrink or turn over, never coast)
// Exit 0 iff both sets are empty. The pure diff/normalize logic is exported for tests
// (test/deadcode-gate.test.js). Design: docs/superpowers/specs/2026-09-13-deadcode-tooling-design.md.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const findingKey = (f) => JSON.stringify([f.file, f.identifier, f.kind]);

// knip --reporter json → { issues: [ { file, exports:[{name}], types:[], files:[],
// dependencies:[...], devDependencies:[...], unlisted:[], ... } ] }. Each per-file issue
// object carries one array per category; flatten every non-empty category array into a
// {file, identifier, kind} finding, where kind is knip's own category name.
export function normalizeKnip(json) {
  const out = [];
  for (const issue of json.issues ?? []) {
    const file = issue.file;
    for (const [kind, val] of Object.entries(issue)) {
      if (kind === 'file' || !Array.isArray(val)) continue;
      for (const e of val) {
        const identifier = typeof e === 'string' ? e : (e.name ?? e.symbol ?? JSON.stringify(e));
        out.push({ file, identifier, kind });
      }
    }
  }
  return out;
}

export function diffFindings(current, baseline) {
  const curKeys = new Set(current.map(findingKey));
  const baseKeys = new Set(baseline.map(findingKey));
  const unexpected = current.filter((f) => !baseKeys.has(findingKey(f)));
  const stale = baseline.filter((f) => !curKeys.has(findingKey(f)));
  return { unexpected, stale };
}

function runKnipJson() {
  try {
    return execFileSync('npx', ['knip', '--reporter', 'json'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch (err) {
    // knip exits 1 when it has findings — that is expected, its stdout still holds the JSON.
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function main() {
  const current = normalizeKnip(JSON.parse(runKnipJson()));
  const baseline = JSON.parse(readFileSync(new URL('../deadcode-baseline.json', import.meta.url), 'utf8'));
  const { unexpected, stale } = diffFindings(current, baseline);
  const show = (f) => `${f.file} ${f.identifier} ${f.kind}`;
  if (unexpected.length) {
    console.error(`\nNew dead-code findings not in deadcode-baseline.json (${unexpected.length}):`);
    unexpected.forEach((f) => console.error('  + ' + show(f)));
    console.error('Fix the code, or (for test-only/dormant code) add a baseline entry with a reason.');
  }
  if (stale.length) {
    console.error(
      `\nStale deadcode-baseline.json entries — code no longer flagged, delete these rows (${stale.length}):`,
    );
    stale.forEach((f) => console.error('  - ' + show(f)));
  }
  if (!unexpected.length && !stale.length) console.log('deadcode gate: clean (findings match baseline).');
  process.exit(unexpected.length || stale.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
