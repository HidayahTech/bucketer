// Must be set before any module that uses IndexedDB is imported.
import { IDBFactory } from 'fake-indexeddb';
global.indexedDB = new IDBFactory();

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { abortMultipartSession } from '../src/lib/upload-cleanup.js';
import { saveResumeRecord, loadResumeRecord } from '../src/lib/resume-records.js';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

function makeMockClient({ shouldThrow = false } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push(cmd);
      if (shouldThrow) throw new Error('Simulated abort failure');
    },
  };
}

const BASE_PARAMS = {
  provider: 'r2',
  endpoint: 'https://example.r2.dev',
  bucket: 'my-bucket',
  key: 'path/to/file.bin',
  uploadId: 'test-upload-id-123',
};

describe('abortMultipartSession', () => {
  test('sends AbortMultipartUploadCommand with correct bucket, key, uploadId', async () => {
    const client = makeMockClient();
    await abortMultipartSession(client, BASE_PARAMS);

    assert.equal(client.calls.length, 1);
    assert.ok(client.calls[0] instanceof AbortMultipartUploadCommand);
    assert.equal(client.calls[0].input.Bucket, 'my-bucket');
    assert.equal(client.calls[0].input.Key, 'path/to/file.bin');
    assert.equal(client.calls[0].input.UploadId, 'test-upload-id-123');
  });

  test('deletes the resume record from IndexedDB after aborting', async () => {
    const params = {
      provider: 'b2',
      endpoint: 'https://s3.us-west-002.backblazeb2.com',
      bucket: 'test-bucket',
      key: 'test/file.bin',
      uploadId: 'upload-abc',
    };

    // Pre-condition: save a resume record
    await saveResumeRecord({
      provider: params.provider, endpoint: params.endpoint,
      bucket: params.bucket, destinationKey: params.key,
      uploadId: params.uploadId,
      partSize: 5 * 1024 * 1024,
      fileIdentity: { name: 'file.bin', size: 1000, lastModified: 0 },
      startedAt: Date.now(),
    });
    const before = await loadResumeRecord({
      provider: params.provider, endpoint: params.endpoint,
      bucket: params.bucket, destinationKey: params.key,
    });
    assert.ok(before !== null, 'resume record should exist before cleanup');

    // Call the function
    const client = makeMockClient();
    await abortMultipartSession(client, params);

    // Post-condition: resume record should be gone
    const after = await loadResumeRecord({
      provider: params.provider, endpoint: params.endpoint,
      bucket: params.bucket, destinationKey: params.key,
    });
    assert.equal(after, null, 'resume record should be deleted after cleanup');
  });

  test('swallows abort errors (does not throw)', async () => {
    const client = makeMockClient({ shouldThrow: true });
    await assert.doesNotReject(() => abortMultipartSession(client, BASE_PARAMS));
  });

  test('still deletes resume record even when abort throws', async () => {
    const params = {
      provider: 'wasabi',
      endpoint: 'https://s3.us-east-1.wasabisys.com',
      bucket: 'wb',
      key: 'crash.bin',
      uploadId: 'failing-upload',
    };
    await saveResumeRecord({
      provider: params.provider, endpoint: params.endpoint,
      bucket: params.bucket, destinationKey: params.key,
      uploadId: params.uploadId,
      partSize: 5 * 1024 * 1024,
      fileIdentity: { name: 'crash.bin', size: 500, lastModified: 0 },
      startedAt: Date.now(),
    });

    const client = makeMockClient({ shouldThrow: true });
    await abortMultipartSession(client, params); // must not throw

    const after = await loadResumeRecord({
      provider: params.provider, endpoint: params.endpoint,
      bucket: params.bucket, destinationKey: params.key,
    });
    assert.equal(after, null, 'resume record must be deleted even when abort fails');
  });
});
