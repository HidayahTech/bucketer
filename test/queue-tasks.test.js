import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectLabel, createDeleteTask, createTransferTask, createDownloadTask, engineUpdateToPatch,
  createResumableMoveTask,
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

describe('createDownloadTask', () => {
  test('stores jobId and bytesTotal when provided', () => {
    const t = createDownloadTask({
      fileCount: 5, bucket: 'bkt', capturedPrefix: 'x/', delivery: 'zip',
      jobId: 'job-1', bytesTotal: 4096,
    });
    assert.equal(t.jobId, 'job-1');
    assert.equal(t.bytesTotal, 4096);
  });

  test('omitting jobId/bytesTotal yields undefined (additive, legacy tasks unaffected)', () => {
    const t = createDownloadTask({ fileCount: 5, bucket: 'bkt', capturedPrefix: 'x/' });
    assert.equal(t.jobId, undefined);
    assert.equal(t.bytesTotal, undefined);
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
  test('passes byte progress through so the queue can render a bar', () => {
    const p = engineUpdateToPatch({ moved: 1, bytesDone: 300, bytesTotal: 1000 }, 'moved');
    assert.equal(p.bytesDone, 300);
    assert.equal(p.bytesTotal, 1000);
  });
  test('omits byte fields when the engine does not report them (e.g. delete)', () => {
    const p = engineUpdateToPatch({ deleted: 2 }, 'deleted');
    assert.ok(!('bytesDone' in p) && !('bytesTotal' in p));
  });
});

describe('createResumableMoveTask', () => {
  test('builds a paused move task from a persisted job record', () => {
    const t = createResumableMoveTask({
      id: 'mv-1', bucket: 'b', dest: 'arch/', capturedPrefix: 'src/',
      items: [{ sourceKey: 'a', destKey: 'arch/a', size: 100 }, { sourceKey: 'b', destKey: 'arch/b', size: 200 }],
    });
    assert.equal(t.status, 'paused');
    assert.equal(t.kind, 'move');
    assert.equal(t.moveJobId, 'mv-1');
    assert.equal(t.total, 2);
    assert.equal(t.bytesTotal, 300);
    assert.equal(t.subject, '2 files');
    assert.equal(t.capturedPrefix, 'src/');
  });
});

// Origin tagging: every task carries the connection it was launched under, so a
// background transfer's callbacks route to that connection, not the live foreground one.
describe('task factories — origin tagging', () => {
  const origin = { connectionId: 'c1', provider: 'b2', endpoint: 'https://e' };
  const check = (t) => {
    assert.equal(t.connectionId, 'c1');
    assert.equal(t.provider, 'b2');
    assert.equal(t.endpoint, 'https://e');
  };

  test('createDeleteTask carries the origin', () => {
    check(createDeleteTask({ files: ['a'], prefixes: [], capturedPrefix: '', bucket: 'b', ...origin }));
  });
  test('createTransferTask (move) carries the origin', () => {
    check(createTransferTask({ files: ['a'], prefixes: [], dest: 'd/', capturedPrefix: '', bucket: 'b', mode: 'move', ...origin }));
  });
  test('createTransferTask (rename) carries the origin', () => {
    check(createTransferTask({ files: [], prefixes: ['photos/2024/'], renameTo: 'x', capturedPrefix: 'photos/', bucket: 'b', mode: 'rename', ...origin }));
  });
  test('createDownloadTask carries the origin', () => {
    check(createDownloadTask({ fileCount: 2, capturedPrefix: '', bucket: 'b', ...origin }));
  });
  test('createResumableMoveTask reads the origin from the record', () => {
    check(createResumableMoveTask({ id: 'm1', items: [{ size: 1 }], dest: 'd/', capturedPrefix: '', bucket: 'b', provider: 'b2', endpoint: 'https://e', connectionId: 'c1' }));
  });
});
