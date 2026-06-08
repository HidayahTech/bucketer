import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isActive, isFailed, isSettled, isPaused, isDone, isAborted } from '../src/lib/upload-status.js';

const ALL_STATUSES = ['queued', 'uploading', 'resuming', 'paused', 'done', 'error', 'aborted'];
const make = s => ({ status: s });

describe('isActive', () => {
  test('true for uploading, resuming, queued', () => {
    assert.ok(isActive(make('uploading')));
    assert.ok(isActive(make('resuming')));
    assert.ok(isActive(make('queued')));
  });

  test('false for all other statuses', () => {
    for (const s of ['paused', 'done', 'error', 'aborted']) {
      assert.ok(!isActive(make(s)), `isActive should be false for '${s}'`);
    }
  });
});

describe('isFailed', () => {
  test('true only for error', () => {
    assert.ok(isFailed(make('error')));
  });

  test('false for all non-error statuses', () => {
    for (const s of ALL_STATUSES.filter(s => s !== 'error')) {
      assert.ok(!isFailed(make(s)), `isFailed should be false for '${s}'`);
    }
  });
});

describe('isSettled', () => {
  test('false for active statuses (uploading, resuming, queued)', () => {
    assert.ok(!isSettled(make('uploading')));
    assert.ok(!isSettled(make('resuming')));
    assert.ok(!isSettled(make('queued')));
  });

  test('true for all non-active statuses', () => {
    for (const s of ['paused', 'done', 'error', 'aborted']) {
      assert.ok(isSettled(make(s)), `isSettled should be true for '${s}'`);
    }
  });
});

describe('isPaused', () => {
  test('true only for paused', () => {
    assert.ok(isPaused(make('paused')));
  });

  test('false for all other statuses', () => {
    for (const s of ALL_STATUSES.filter(s => s !== 'paused')) {
      assert.ok(!isPaused(make(s)), `isPaused should be false for '${s}'`);
    }
  });
});

describe('isDone', () => {
  test('true only for done', () => {
    assert.ok(isDone(make('done')));
  });

  test('false for all other statuses', () => {
    for (const s of ALL_STATUSES.filter(s => s !== 'done')) {
      assert.ok(!isDone(make(s)), `isDone should be false for '${s}'`);
    }
  });
});

describe('isAborted', () => {
  test('true only for aborted', () => {
    assert.ok(isAborted(make('aborted')));
  });

  test('false for all other statuses', () => {
    for (const s of ALL_STATUSES.filter(s => s !== 'aborted')) {
      assert.ok(!isAborted(make(s)), `isAborted should be false for '${s}'`);
    }
  });
});
