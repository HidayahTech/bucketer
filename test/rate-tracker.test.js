// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateTracker } from '../src/lib/rate-tracker.js';

const MB = 1024 * 1024;

describe('rate-tracker', () => {
  test('null until two samples spanning minSpanMs', () => {
    const r = createRateTracker();
    assert.equal(r.rate(0), null);            // no samples
    r.sample(0, 0);
    assert.equal(r.rate(0), null);            // one sample
    r.sample(200, MB);
    assert.equal(r.rate(200), null);          // span 200 < 500
  });

  test('reports bytes/second across the window', () => {
    const r = createRateTracker();
    r.sample(0, 0);
    r.sample(1000, 10 * MB);                  // 10 MiB in 1 s
    assert.equal(Math.round(r.rate(1000) / MB), 10);
  });

  test('evicts samples older than windowMs', () => {
    const r = createRateTracker({ windowMs: 6000 });
    r.sample(0, 0);                           // will age out
    r.sample(7000, 70 * MB);
    r.sample(8000, 80 * MB);                  // last 1 s: 10 MiB
    // The 0-sample is older than 8000-6000=2000, so it's gone; rate is from the recent pair.
    assert.equal(Math.round(r.rate(8000) / MB), 10);
  });

  test('a decreasing byte count yields null (never negative)', () => {
    const r = createRateTracker();
    r.sample(0, 100 * MB);
    r.sample(1000, 50 * MB);
    assert.equal(r.rate(1000), null);
  });

  test('an idle gap decays the rate rather than reporting stale throughput', () => {
    const r = createRateTracker({ windowMs: 6000 });
    r.sample(0, 0);
    r.sample(1000, 10 * MB);                  // 10 MiB/s burst
    // Long idle: bytes unchanged across a wide span.
    r.sample(7000, 10 * MB);
    r.sample(8000, 10 * MB);
    assert.equal(r.rate(8000), 0);            // 0 gained across the retained window
  });
});
