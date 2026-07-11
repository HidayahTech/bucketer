import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectLabel, createDeleteTask, createTransferTask, engineUpdateToPatch,
} from '../src/lib/queue-tasks.js';

describe('subjectLabel', () => {
  test('files only, singular/plural', () => {
    assert.equal(subjectLabel(1, 0), '1 file');
    assert.equal(subjectLabel(3, 0), '3 files');
  });
  test('folders only and mixed', () => {
    assert.equal(subjectLabel(0, 1), '1 folder');
    assert.equal(subjectLabel(2, 2), '2 files and 2 folders');
  });
});

describe('createDeleteTask', () => {
  test('builds a running delete task with counters zeroed', () => {
    const t = createDeleteTask({
      files: ['a.txt', 'b.txt'], prefixes: ['p/'], capturedPrefix: 'x/', bucket: 'bkt',
    });
    assert.equal(t.kind, 'delete');
    assert.equal(t.status, 'running');
    assert.equal(t.subPhase, null);
    assert.equal(t.subject, '2 files and 1 folder');
    assert.equal(t.current, 0);
    assert.equal(t.total, null);
    assert.deepEqual(t.errors, []);
    assert.equal(t.collapsed, false);
    assert.equal(t.cancelRequested, false);
    assert.equal(t.bucket, 'bkt');
    assert.equal(t.capturedPrefix, 'x/');
  });
});

describe('createTransferTask', () => {
  test('mode copy → kind copy; mode move → kind move; starts in checking', () => {
    const base = { files: [{ key: 'a', size: 1 }], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b' };
    assert.equal(createTransferTask({ ...base, mode: 'copy' }).kind, 'copy');
    const mv = createTransferTask({ ...base, mode: 'move' });
    assert.equal(mv.kind, 'move');
    assert.equal(mv.subPhase, 'checking');
    assert.equal(mv.dest, 'd/');
  });
});

describe('createTransferTask — rename', () => {
  test('builds a rename task with a "old → new" subject', () => {
    const t = createTransferTask({ files: [], prefixes: ['photos/2024/'], renameTo: 'memories', capturedPrefix: 'photos/', bucket: 'b', mode: 'rename' });
    assert.equal(t.kind, 'rename');
    assert.equal(t.subject, '2024 → memories');
    assert.equal(t.renameTo, 'memories');
    assert.deepEqual(t.prefixes, ['photos/2024/']);
  });
  test('move/copy tasks are unchanged', () => {
    assert.equal(createTransferTask({ files: ['a'], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b', mode: 'move' }).kind, 'move');
    assert.equal(createTransferTask({ files: ['a'], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b', mode: 'copy' }).kind, 'copy');
  });
});

describe('engineUpdateToPatch', () => {
  test('phase transition maps to subPhase', () => {
    assert.deepEqual(engineUpdateToPatch({ phase: 'discovering' }, 'deleted'), { subPhase: 'discovering' });
  });
  test('deleting phase with total', () => {
    const p = engineUpdateToPatch({ phase: 'deleting', total: 42 }, 'deleted');
    assert.equal(p.subPhase, 'deleting');
    assert.equal(p.total, 42);
  });
  test('incremental count maps countField → current, carries errors', () => {
    const p = engineUpdateToPatch({ deleted: 7, errors: [{ key: 'k', message: 'm' }] }, 'deleted');
    assert.equal(p.current, 7);
    assert.equal(p.errors.length, 1);
    assert.equal(p.subPhase, undefined, 'no phase in update → no subPhase in patch');
  });
  test('moved counts through the moved field', () => {
    assert.equal(engineUpdateToPatch({ moved: 3 }, 'moved').current, 3);
  });
  test('done → status done, subPhase cleared', () => {
    const p = engineUpdateToPatch({ phase: 'done', deleted: 9, errors: [] }, 'deleted');
    assert.equal(p.status, 'done');
    assert.equal(p.subPhase, null);
    assert.equal(p.current, 9);
  });
  test('done with cancelled → status cancelled', () => {
    assert.equal(engineUpdateToPatch({ phase: 'done', cancelled: true }, 'deleted').status, 'cancelled');
  });
});
