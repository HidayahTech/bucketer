import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateBytes } from '../src/hooks/useInterpolatedProgress.js';

describe('interpolateBytes', () => {
  test('advances by speed * dt when not hidden', () => {
    const result = interpolateBytes(100, 50, 1.0, 0, Infinity, false);
    assert.equal(result, 150);
  });

  test('floors at the confirmed floor value', () => {
    // prev is below floor — should snap up
    const result = interpolateBytes(10, 0, 1.0, 100, Infinity, false);
    assert.equal(result, 100);
  });

  test('prev + speed * dt is still floored if it would be below floor', () => {
    // prev=90, speed=0, floor=100 → result should be 100 (floor wins)
    const result = interpolateBytes(90, 0, 1.0, 100, Infinity, false);
    assert.equal(result, 100);
  });

  test('caps at max (file size ceiling)', () => {
    const result = interpolateBytes(490, 100, 1.0, 0, 500, false);
    assert.equal(result, 500);
  });

  test('returns prev unchanged when visibilityHidden is true', () => {
    const result = interpolateBytes(200, 50, 1.0, 0, Infinity, true);
    assert.equal(result, 200);
  });

  test('zero speed does not advance (but still floors at confirmed bytes)', () => {
    const result = interpolateBytes(50, 0, 1.0, 50, 1000, false);
    assert.equal(result, 50);
  });

  test('fractional dt produces proportional advance', () => {
    // speed=100 B/s, dt=0.5s → delta = 50
    const result = interpolateBytes(100, 100, 0.5, 0, Infinity, false);
    assert.equal(result, 150);
  });
});
