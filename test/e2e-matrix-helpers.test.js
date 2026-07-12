import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListEnv, parseDeviceListEnv, buildCombos, comboLabel, imageTagFromLock, pickRuntime,
  DEFAULT_ENGINES, DEFAULT_DEVICES,
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
      { engine: 'a', device: '' }, { engine: 'a', device: 'd1' },
      { engine: 'b', device: '' }, { engine: 'b', device: 'd1' },
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
  test('derives the pinned jammy image from the locked playwright version', () => {
    const lock = { packages: { 'node_modules/playwright': { version: '1.60.0' } } };
    assert.equal(imageTagFromLock(lock), 'mcr.microsoft.com/playwright:v1.60.0-jammy');
  });
  test('throws on missing or non-exact versions (a wrong image skews every result)', () => {
    assert.throws(() => imageTagFromLock({}), /Cannot derive/);
    assert.throws(() => imageTagFromLock({ packages: {} }), /Cannot derive/);
    assert.throws(() => imageTagFromLock({ packages: { 'node_modules/playwright': { version: '^1.60.0' } } }), /Cannot derive/);
  });
  test('matches the image pinned in .gitlab-ci.yml (keep CI and local in lockstep)', async () => {
    const { readFileSync } = await import('node:fs');
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    assert.ok(ci.includes(`image: ${imageTagFromLock(lock)}`),
      `.gitlab-ci.yml must pin ${imageTagFromLock(lock)} (locked playwright version) — update the image tag or the dependency together`);
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
