import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListEnv,
  parseDeviceListEnv,
  buildCombos,
  comboLabel,
  imageTagFromLock,
  pickRuntime,
  DEFAULT_ENGINES,
  DEFAULT_DEVICES,
} from './e2e/matrix-helpers.mjs';

describe('parseListEnv', () => {
  test('unset/empty → defaults', () => {
    assert.deepEqual(parseListEnv(undefined, DEFAULT_ENGINES), DEFAULT_ENGINES);
    assert.deepEqual(parseListEnv('', DEFAULT_ENGINES), DEFAULT_ENGINES);
  });
  test('splits, trims, and drops empty entries', () => {
    assert.deepEqual(parseListEnv(' chromium , firefox ,', ['x']), ['chromium', 'firefox']);
  });
  test('all-empty value falls back to defaults', () => {
    assert.deepEqual(parseListEnv(' , ,', ['x']), ['x']);
  });
});

describe('parseDeviceListEnv', () => {
  test('"desktop" maps to the empty (no-profile) device', () => {
    assert.deepEqual(parseDeviceListEnv('desktop, Pixel 5'), ['', 'Pixel 5']);
    assert.deepEqual(parseDeviceListEnv('Desktop'), ['']);
  });
  test('unset → full default device list including desktop', () => {
    assert.deepEqual(parseDeviceListEnv(undefined), DEFAULT_DEVICES);
  });
});

describe('buildCombos', () => {
  test('engine-major expansion mirrors the CI matrix layout', () => {
    assert.deepEqual(buildCombos(['a', 'b'], ['', 'd1']), [
      { engine: 'a', device: '' },
      { engine: 'a', device: 'd1' },
      { engine: 'b', device: '' },
      { engine: 'b', device: 'd1' },
    ]);
  });
  test('defaults produce the full 9-combo grid', () => {
    assert.equal(buildCombos(DEFAULT_ENGINES, DEFAULT_DEVICES).length, 9);
  });
  test('comboLabel names desktop explicitly', () => {
    assert.equal(comboLabel({ engine: 'webkit', device: '' }), 'webkit × desktop');
    assert.equal(comboLabel({ engine: 'firefox', device: 'Pixel 5' }), 'firefox × Pixel 5');
  });
});

describe('imageTagFromLock', () => {
  // The base is noble, not jammy, and that is load-bearing rather than incidental: jammy
  // ships a C library predating the work that makes environment reads safe against a
  // concurrent write. Chromium hits that race during startup and segfaults inside getenv,
  // which failed the chromium lane on roughly two runs in three. See the e2e crash issue.
  test('derives the pinned noble image from the locked playwright version', () => {
    const lock = { packages: { 'node_modules/playwright': { version: '1.60.0' } } };
    assert.equal(imageTagFromLock(lock), 'mcr.microsoft.com/playwright:v1.60.0-noble');
  });
  test('throws on missing or non-exact versions (a wrong image skews every result)', () => {
    assert.throws(() => imageTagFromLock({}), /Cannot derive/);
    assert.throws(() => imageTagFromLock({ packages: {} }), /Cannot derive/);
    assert.throws(
      () => imageTagFromLock({ packages: { 'node_modules/playwright': { version: '^1.60.0' } } }),
      /Cannot derive/,
    );
  });
  test('matches the image pinned in .gitlab-ci.yml (keep CI and local in lockstep)', async () => {
    const { readFileSync } = await import('node:fs');
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    assert.ok(
      ci.includes(`image: ${imageTagFromLock(lock)}`),
      `.gitlab-ci.yml must pin ${imageTagFromLock(lock)} (locked playwright version) — update the image tag or the dependency together`,
    );
  });
});

// The two browser-e2e matrix jobs (e2e-browser, e2e-browser-webkit) extend .e2e-browser-base,
// which carries `retry: max 2` so a flaky mobile/webkit lane auto-heals instead of reddening
// the pipeline. This guard locks that in AND keeps it scoped: the node-integration lane
// (e2e-node, deterministic) and the non-e2e jobs must NOT retry, so a real regression there
// fails hard. Paired with per-lane timeout scaling in test/e2e/harness.mjs. The retry auto-heal
// is a GitLab-runtime behaviour the local harness cannot represent — this config guard is its
// durable substitute (harness-fidelity rule).
describe('e2e browser lanes retry flaky failures (CI)', () => {
  function section(ci, header) {
    const lines = ci.split('\n');
    const start = lines.findIndex((l) => l.startsWith(header));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;
    return lines.slice(start, end).join('\n');
  }

  test('.e2e-browser-base declares retry max 2 on flake-shaped failures', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    const block = section(ci, '.e2e-browser-base:');
    assert.match(block, /retry:/, '.e2e-browser-base must declare retry');
    assert.match(block, /max:\s*2/, 'browser-lane retry must be max: 2');
    for (const reason of ['script_failure', 'stuck_or_timeout_failure', 'runner_system_failure']) {
      assert.ok(block.includes(reason), `browser-lane retry when: must include ${reason}`);
    }
  });

  test('the deterministic e2e-node lane does NOT retry', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    assert.ok(
      !section(ci, 'e2e-node:').includes('retry'),
      'e2e-node is deterministic — a failure there is real and must not be retried',
    );
  });

  // The npm-audit CVE check is deliberately ADVISORY: a fresh transitive vulnerability must
  // surface as a signal, never block a push. This guard keeps it non-blocking — if someone
  // later drops allow_failure, a single new advisory would red every pipeline until fixed.
  test('the npm-audit job stays advisory (allow_failure)', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    const block = section(ci, 'audit:');
    assert.ok(block, '.gitlab-ci.yml must define an audit job');
    assert.match(block, /allow_failure:\s*true/, 'the audit job must be non-blocking (allow_failure: true)');
  });
});

describe('pickRuntime', () => {
  test('prefers podman over docker', () => {
    assert.equal(pickRuntime(['docker', 'podman']), 'podman');
  });
  test('falls back to docker', () => {
    assert.equal(pickRuntime(['docker']), 'docker');
  });
  test('null when neither exists', () => {
    assert.equal(pickRuntime([]), null);
  });
});
