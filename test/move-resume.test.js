// Tests for resumable moves — persistence during a run and resumeMoveOperation.
// Requires fake-indexeddb; globals set before importing anything that opens the DB.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runMoveOperation, resumeMoveOperation } from '../src/lib/move-queue.js';
import { loadMoveJob, clearAllMoveJobs, saveMoveJob } from '../src/lib/move-jobs.js';

const GiB = 1024 * 1024 * 1024;

function mockClient({ destKeys = [], existingParts = [] } = {}) {
  const calls = [];
  return {
    calls,
    send(cmd) {
      const name = cmd.constructor?.name ?? '';
      const input = cmd.input;
      calls.push({ name, input });
      switch (name) {
        case 'ListObjectsV2Command':
          return Promise.resolve({ Contents: destKeys.map(k => ({ Key: k, Size: 0 })), IsTruncated: false });
        case 'CopyObjectCommand':      return Promise.resolve({ CopyObjectResult: { ETag: 'e' } });
        case 'DeleteObjectCommand':    return Promise.resolve({});
        case 'HeadObjectCommand':      return Promise.resolve({ ContentType: 'x', Metadata: {} });
        case 'CreateMultipartUploadCommand': return Promise.resolve({ UploadId: 'up-new' });
        case 'ListPartsCommand':       return Promise.resolve({ Parts: existingParts, IsTruncated: false });
        case 'UploadPartCopyCommand':  return Promise.resolve({ CopyPartResult: { ETag: `e-${input.PartNumber}` } });
        case 'CompleteMultipartUploadCommand': return Promise.resolve({});
        case 'AbortMultipartUploadCommand':    return Promise.resolve({});
        default: return Promise.reject(new Error(`unexpected: ${name}`));
      }
    },
  };
}

const collect = async (run) => { const u = []; await run(x => u.push({ ...x })); return u; };

const record = (over = {}) => ({
  id: 'mv-1', provider: 'b2', endpoint: 'e', bucket: 'bk', mode: 'move',
  dest: 'arch/', capturedPrefix: '', createdAt: 0,
  items: [{ sourceKey: 'a.bin', destKey: 'arch/a.bin', size: 100 }],
  inflightUploads: {}, ...over,
});

describe('resumeMoveOperation', () => {
  beforeEach(async () => { await clearAllMoveJobs(); });

  test('skips an item already at the destination and deletes its lingering source', async () => {
    await saveMoveJob(record());
    const client = mockClient({ destKeys: ['arch/a.bin'] });
    const updates = await collect(cb => resumeMoveOperation(client, 'bk', record(), cb));
    assert.ok(!client.calls.some(c => c.name === 'CopyObjectCommand'), 'must not re-copy a finished item');
    assert.ok(client.calls.some(c => c.name === 'DeleteObjectCommand' && c.input.Key === 'a.bin'), 'finishes the move by deleting the source');
    assert.equal(updates.find(u => u.phase === 'done').moved, 1);
  });

  test('copies a not-yet-done item and deletes its source', async () => {
    await saveMoveJob(record());
    const client = mockClient({ destKeys: [] });
    await resumeMoveOperation(client, 'bk', record(), () => {});
    assert.ok(client.calls.some(c => c.name === 'CopyObjectCommand' && c.input.Key === 'arch/a.bin'));
    assert.ok(client.calls.some(c => c.name === 'DeleteObjectCommand' && c.input.Key === 'a.bin'));
  });

  test('resumes an in-flight multipart item via its stored upload id (no Create)', async () => {
    const rec = record({
      items: [{ sourceKey: 'big.bin', destKey: 'arch/big.bin', size: 6 * GiB }],
      inflightUploads: { 'big.bin': { uploadId: 'up-existing', partSize: 1 * GiB } },
    });
    await saveMoveJob(rec);
    const client = mockClient({ destKeys: [], existingParts: [{ PartNumber: 1, ETag: 'd-1' }] });
    await resumeMoveOperation(client, 'bk', rec, () => {});
    assert.ok(!client.calls.some(c => c.name === 'CreateMultipartUploadCommand'), 'resumes, does not create');
    assert.ok(client.calls.some(c => c.name === 'ListPartsCommand' && c.input.UploadId === 'up-existing'));
    assert.ok(client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'));
    assert.ok(client.calls.some(c => c.name === 'DeleteObjectCommand' && c.input.Key === 'big.bin'));
  });

  test('deletes the job record on clean completion', async () => {
    await saveMoveJob(record());
    const client = mockClient({ destKeys: [] });
    await resumeMoveOperation(client, 'bk', record(), () => {});
    assert.equal(await loadMoveJob('mv-1'), null);
  });
});

describe('runMoveOperation — persistence', () => {
  beforeEach(async () => { await clearAllMoveJobs(); });

  test('a clean completion leaves no record behind', async () => {
    const client = mockClient({ destKeys: [] });
    const op = { jobId: 'mv-9', provider: 'b2', endpoint: 'e', files: [{ key: 'a.bin', size: 100 }], dest: 'arch/' };
    await runMoveOperation(client, 'bk', op, () => {});
    assert.equal(await loadMoveJob('mv-9'), null, 'clean completion removes the record');
  });

  test('a cancelled move leaves the record with its work list for later resume', async () => {
    const client = mockClient({ destKeys: [] });
    const op = { jobId: 'mv-8', provider: 'b2', endpoint: 'e',
      files: [{ key: 'a.bin', size: 100 }, { key: 'b.bin', size: 100 }], dest: 'arch/' };
    let n = 0;
    await runMoveOperation(client, 'bk', op, () => {}, () => n++ > 0); // cancel after the first item
    const rec = await loadMoveJob('mv-8');
    assert.ok(rec, 'record survives a cancel');
    assert.equal(rec.items.length, 2);
  });

  test('without a jobId, no record is written (unchanged legacy behaviour)', async () => {
    const client = mockClient({ destKeys: [] });
    await runMoveOperation(client, 'bk', { files: [{ key: 'a.bin', size: 100 }], dest: 'arch/' }, () => {});
    assert.equal(await loadMoveJob('a.bin'), null);
  });
});
