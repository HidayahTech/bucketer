import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyClickSafety } from '../src/hooks/useDoubleClickSafety.js';

describe('applyClickSafety', () => {
  function makeSpy() {
    const log = [];
    return {
      log,
      setPrimed: (v) => log.push(['set', v]),
      clearFn: () => log.push(['clear']),
      scheduleFn: (cb) => { log.push(['schedule']); return cb; },
      onConfirm: () => log.push(['confirm']),
    };
  }

  test('first click: sets primed, clears previous timer, then schedules reset', () => {
    const spy = makeSpy();
    applyClickSafety(false, spy.onConfirm, spy.setPrimed, spy.clearFn, spy.scheduleFn);
    assert.deepEqual(spy.log, [['set', true], ['clear'], ['schedule']]);
    assert.equal(spy.log.filter(e => e[0] === 'confirm').length, 0);
  });

  test('second click (primed): clears timer, resets primed, fires confirm — no schedule', () => {
    const spy = makeSpy();
    applyClickSafety(true, spy.onConfirm, spy.setPrimed, spy.clearFn, spy.scheduleFn);
    assert.deepEqual(spy.log, [['clear'], ['set', false], ['confirm']]);
    assert.equal(spy.log.filter(e => e[0] === 'schedule').length, 0);
  });

  test('reset callback (from timer) sets primed to false when called', () => {
    let captured = null;
    const scheduleFn = (cb) => { captured = cb; };
    const setPrimedValues = [];
    const setPrimed = (v) => setPrimedValues.push(v);

    applyClickSafety(false, () => {}, setPrimed, () => {}, scheduleFn);
    // Initial call set primed to true
    assert.deepEqual(setPrimedValues, [true]);

    // Simulate the timer firing
    captured();
    assert.deepEqual(setPrimedValues, [true, false]);
  });

  test('onConfirm is called exactly once on the second click, not on the first', () => {
    let count = 0;
    const onConfirm = () => { count++; };

    // First click — should not call onConfirm
    applyClickSafety(false, onConfirm, () => {}, () => {}, () => {});
    assert.equal(count, 0);

    // Second click (primed=true) — should call onConfirm
    applyClickSafety(true, onConfirm, () => {}, () => {}, () => {});
    assert.equal(count, 1);
  });
});
