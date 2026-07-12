import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync as writeFileSyncStub } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEngineQuirks, skipReasonFor } from './e2e/engine-quirks.mjs';
import { captureFailure } from './e2e/harness.mjs';

describe('applyEngineQuirks', () => {
  const mobile = { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, userAgent: 'ua' };
  test('firefox: strips isMobile (unsupported), keeps viewport/touch/ua', () => {
    const o = applyEngineQuirks('firefox', mobile);
    assert.equal('isMobile' in o, false);
    assert.equal(o.hasTouch, true);
    assert.deepEqual(o.viewport, { width: 393, height: 851 });
  });
  test('chromium/webkit: keep isMobile', () => {
    assert.equal(applyEngineQuirks('chromium', mobile).isMobile, true);
    assert.equal(applyEngineQuirks('webkit', mobile).isMobile, true);
  });
  test('null profile → just the extra overrides', () => {
    assert.deepEqual(applyEngineQuirks('firefox', null, { locale: 'en' }), { locale: 'en' });
  });
  test('extra overrides win', () => {
    assert.equal(applyEngineQuirks('chromium', mobile, { isMobile: false }).isMobile, false);
  });
});

describe('skipReasonFor', () => {
  test('returns the reason when the engine is listed', () => {
    assert.equal(skipReasonFor('webkit', { webkit: 'DataTransfer gap' }), 'DataTransfer gap');
  });
  test('returns null when the engine is not listed', () => {
    assert.equal(skipReasonFor('chromium', { webkit: 'DataTransfer gap' }), null);
    assert.equal(skipReasonFor('firefox', { webkit: 'DataTransfer gap' }), null);
  });
  test('returns null without a skipOn map', () => {
    assert.equal(skipReasonFor('webkit', undefined), null);
    assert.equal(skipReasonFor('webkit', null), null);
  });
  test('throws on a listed engine with a missing/empty reason (skips must be documented)', () => {
    assert.throws(() => skipReasonFor('webkit', { webkit: '' }), /non-empty reason/);
    assert.throws(() => skipReasonFor('webkit', { webkit: true }), /non-empty reason/);
  });
});

describe('captureFailure', () => {
  test('writes a .log always and a .png when the page screenshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cap-'));
    try {
      const shots = [];
      const page = { async screenshot({ path }) { shots.push(path); writeFileSyncStub(path, ''); } };
      await captureFailure('mytest-chromium', page, ['[console] hi', '[pageerror] boom'], dir);
      assert.ok(existsSync(join(dir, 'mytest-chromium.log')), 'log written');
      assert.match(readFileSync(join(dir, 'mytest-chromium.log'), 'utf8'), /boom/);
      assert.ok(existsSync(join(dir, 'mytest-chromium.png')), 'screenshot written');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a screenshot failure (closed page) does not throw — log still written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cap-'));
    try {
      const page = { async screenshot() { throw new Error('page closed'); } };
      await captureFailure('closed-firefox', page, ['x'], dir);
      assert.ok(existsSync(join(dir, 'closed-firefox.log')), 'log still written');
      assert.equal(existsSync(join(dir, 'closed-firefox.png')), false, 'no screenshot');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
