// Node-integration: archived-object flagging against the real mock protocol.
//
// WHY THIS LAYER AND NOT THE BROWSER LAYER. The archived check is deliberately AWS-only
// (storage-class.js), and the app derives the provider from the endpoint — a localhost
// mock can never detect as AWS, so the browser UI path cannot exercise flagging without
// a provider override the app does not have. No e2e coverage of the browser path exists,
// and this header says so rather than letting a green lane imply it (harness-fidelity
// rule, CLAUDE.md). What IS covered here: the mock speaks real StorageClass in listings
// (accepted from PutObject's x-amz-storage-class, exactly as the SDK sends it), the real
// enumeration pipeline marks archived objects SKIPPED with honest counters, and a GET
// against an archived object fails with 403 InvalidObjectState like real S3 — the
// failure shape the per-file probe classifies as that file's own denial.
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { startMock, BUCKET, e2eTest } from '../harness.mjs';
import { enumerateJob } from '../../../src/lib/download-manifest.js';
import {
  saveJob, loadJob, deleteJob, loadAllJobs, countItemsByStatus, ITEM_STATUS, JOB_STATUS,
} from '../../../src/lib/download-records.js';

import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

let ctx;

before(async () => {
  ctx = await startMock();
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'ar/cold.bin', Body: 'c'.repeat(100), StorageClass: 'GLACIER' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'ar/frozen.bin', Body: 'f'.repeat(50), StorageClass: 'DEEP_ARCHIVE' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'ar/instant.bin', Body: 'i'.repeat(20), StorageClass: 'GLACIER_IR' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'ar/warm.bin', Body: 'w'.repeat(7) }));
});
after(async () => { await ctx?.mock.close(); });
beforeEach(async () => { for (const j of await loadAllJobs()) await deleteJob(j.id); });

const job = (provider) => ({
  id: 'job-ar', bucket: BUCKET, prefix: 'ar/', mode: 'leaf', provider,
  status: JOB_STATUS.ENUMERATING, enumeration: {},
  counters: { total: 0, bytesTotal: 0, sendable: 0, bytesSendable: 0 },
});

describe('node e2e — archived objects through the real listing protocol', () => {
  e2eTest('an AWS job marks GLACIER and DEEP_ARCHIVE skipped, with honest counters', async () => {
    await saveJob(job('aws'));

    const result = await enumerateJob(ctx.client, await loadJob('job-ar'), {});

    assert.equal(result.objects, 4);
    assert.equal(result.archived, 2, 'GLACIER + DEEP_ARCHIVE; GLACIER_IR downloads normally');
    assert.equal(result.archivedBytes, 150);
    assert.equal(await countItemsByStatus('job-ar', ITEM_STATUS.SKIPPED), 2);
    assert.equal(await countItemsByStatus('job-ar', ITEM_STATUS.PENDING), 2);

    const j = await loadJob('job-ar');
    assert.equal(j.counters.total, 4);
    assert.equal(j.counters.sendable, 2, 'the task row promises only what can be issued');
    assert.equal(j.counters.bytesSendable, 27, 'instant (20) + warm (7)');
  });

  e2eTest('a non-AWS job flags nothing, even when the listing carries archive classes', async () => {
    await saveJob(job('minio'));

    const result = await enumerateJob(ctx.client, await loadJob('job-ar'), {});

    assert.equal(result.archived, 0);
    assert.equal(await countItemsByStatus('job-ar', ITEM_STATUS.SKIPPED), 0);
  });

  e2eTest('a GET against an archived object fails like real S3', async () => {
    await assert.rejects(
      ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'ar/cold.bin' })),
      (err) => err.Code === 'InvalidObjectState' || /InvalidObjectState/.test(String(err)),
      'archived reads must fail with InvalidObjectState until a restore completes',
    );
  });

  e2eTest('a GET against GLACIER_IR serves normally', async () => {
    const resp = await ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'ar/instant.bin' }));
    const body = await resp.Body.transformToString();
    assert.equal(body.length, 20);
  });
});
