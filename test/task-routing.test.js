// Tests for src/lib/task-routing.js — deciding whether a task's side effects (view
// refresh, capability write) belong to the connection currently in the foreground.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isForegroundTask } from '../src/lib/task-routing.js';

describe('task-routing — isForegroundTask', () => {
  test('true when the task connection matches the foreground', () => {
    assert.equal(isForegroundTask({ connectionId: 'c1' }, 'c1'), true);
  });

  test('false when the task belongs to a different connection', () => {
    assert.equal(isForegroundTask({ connectionId: 'c2' }, 'c1'), false);
  });

  test('an ad-hoc task (null connectionId) is foreground only when nothing is selected', () => {
    assert.equal(isForegroundTask({ connectionId: null }, null), true);
    assert.equal(isForegroundTask({ connectionId: null }, 'c1'), false);
  });

  test('false for a null task', () => {
    assert.equal(isForegroundTask(null, 'c1'), false);
  });
});
