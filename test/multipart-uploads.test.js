// Tests for src/lib/multipart-uploads.js — discovery + classification of incomplete
// (in-progress) multipart uploads, for the cleanup panel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listIncompleteUploads, classifyIncompleteUploads } from '../src/lib/multipart-uploads.js';

function mockClient(pages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    send(cmd) {
      calls.push({ name: cmd.constructor?.name, input: cmd.input });
      return Promise.resolve(pages[i++]);
    },
  };
}

describe('listIncompleteUploads', () => {
  test('returns key/uploadId/initiated for a single page', async () => {
    const client = mockClient([{ Uploads: [{ Key: 'a.bin', UploadId: 'u1', Initiated: 't1' }], IsTruncated: false }]);
    assert.deepEqual(await listIncompleteUploads(client, 'bk', ''), [{ key: 'a.bin', uploadId: 'u1', initiated: 't1' }]);
  });

  test('paginates via KeyMarker/UploadIdMarker and passes the prefix', async () => {
    const client = mockClient([
      { Uploads: [{ Key: 'a', UploadId: 'u1', Initiated: 't1' }], IsTruncated: true, NextKeyMarker: 'a', NextUploadIdMarker: 'u1' },
      { Uploads: [{ Key: 'b', UploadId: 'u2', Initiated: 't2' }], IsTruncated: false },
    ]);
    const out = await listIncompleteUploads(client, 'bk', 'p/');
    assert.deepEqual(out.map((u) => u.uploadId), ['u1', 'u2']);
    assert.equal(client.calls[0].input.Prefix, 'p/');
    assert.equal(client.calls[1].input.KeyMarker, 'a');
    assert.equal(client.calls[1].input.UploadIdMarker, 'u1');
  });

  test('tolerates a page with no Uploads array', async () => {
    const client = mockClient([{ IsTruncated: false }]);
    assert.deepEqual(await listIncompleteUploads(client, 'bk', ''), []);
  });
});

describe('classifyIncompleteUploads', () => {
  const jobs = [
    { id: 'mv-1', inflightUploads: { 'src/a.bin': { uploadId: 'u1', partSize: 1 } } },
    { id: 'mv-2', inflightUploads: {} },
  ];

  test('an upload referenced by a move record is resumable, tagged with its jobId', () => {
    const out = classifyIncompleteUploads([{ key: 'arch/a.bin', uploadId: 'u1', initiated: 't' }], jobs);
    assert.equal(out[0].resumable, true);
    assert.equal(out[0].moveJobId, 'mv-1');
  });

  test('an unreferenced upload is a discard-only orphan', () => {
    const out = classifyIncompleteUploads([{ key: 'x', uploadId: 'u9', initiated: 't' }], jobs);
    assert.equal(out[0].resumable, false);
    assert.equal(out[0].moveJobId, null);
  });

  test('tolerates jobs without inflightUploads', () => {
    const out = classifyIncompleteUploads([{ key: 'x', uploadId: 'u9', initiated: 't' }], [{ id: 'mv-x' }]);
    assert.equal(out[0].resumable, false);
  });
});
