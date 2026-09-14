// Unit tests for the pure per-lane e2e timeout scaling (test/e2e/lane-timeout.mjs). The
// module is deliberately playwright-free so this runs under `npm test`. The scaling is applied
// in the harness (page.setDefaultTimeout) and in the specs' poll deadlines; here we pin the
// factor per lane and that scaleTimeout multiplies + rounds accordingly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { laneTimeoutFactor, scaleTimeout } from './e2e/lane-timeout.mjs';

describe('laneTimeoutFactor', () => {
  test('desktop chromium/firefox = 1x (no profile)', () => {
    assert.equal(laneTimeoutFactor('chromium', ''), 1);
    assert.equal(laneTimeoutFactor('firefox', undefined), 1);
    assert.equal(laneTimeoutFactor('chromium', undefined), 1);
  });
  test('webkit desktop = 2x', () => {
    assert.equal(laneTimeoutFactor('webkit', ''), 2);
    assert.equal(laneTimeoutFactor('webkit', undefined), 2);
  });
  test('mobile device profile adds x1.5', () => {
    assert.equal(laneTimeoutFactor('chromium', 'Pixel 5'), 1.5);
    assert.equal(laneTimeoutFactor('firefox', 'iPhone 13'), 1.5);
  });
  test('webkit + mobile = 3x (the slowest, flakiest lane)', () => {
    assert.equal(laneTimeoutFactor('webkit', 'Pixel 5'), 3);
    assert.equal(laneTimeoutFactor('webkit', 'iPhone 13'), 3);
  });
  test('unknown engine is treated as non-webkit (1x baseline)', () => {
    assert.equal(laneTimeoutFactor(undefined, ''), 1);
  });
});

describe('scaleTimeout', () => {
  test('scales by the lane factor and rounds', () => {
    assert.equal(scaleTimeout(5000, { engine: 'chromium', device: '' }), 5000);
    assert.equal(scaleTimeout(5000, { engine: 'webkit', device: '' }), 10000);
    assert.equal(scaleTimeout(5000, { engine: 'webkit', device: 'iPhone 13' }), 15000);
    assert.equal(scaleTimeout(10000, { engine: 'firefox', device: 'Pixel 5' }), 15000);
  });
  test('the sort poll that blew on webkit-mobile (5000ms) becomes 15000ms there', () => {
    // Regression anchor: pipeline #308 webkit × iPhone 13 exceeded the fixed 5 s poll (~7 s).
    assert.ok(scaleTimeout(5000, { engine: 'webkit', device: 'iPhone 13' }) >= 7000);
  });
});
