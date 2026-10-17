// Node-integration e2e: a move must never delete a source it has not proven it copied.
// GitLab #74 (R02): resume treated "destination key exists" as proof of a finished copy and
// deleted the source even when an unrelated object sat there. GitLab #75 (R04): a source
// replaced between the copy and the delete was deleted, losing the replacement. Real
// move-queue code against the stateful mock S3; the assertions read back object BYTES.
// Persistence needs IndexedDB, so fake-indexeddb is installed before the lib is imported.
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { startMock, BUCKET } from '../harness.mjs';

const { runMoveOperation, resumeMoveOperation } = await import('../../../src/lib/move-queue.js');
const { loadMoveJob, clearAllMoveJobs } = await import('../../../src/lib/move-jobs.js');

let ctx;
before(async () => {
  ctx = await startMock();
});
after(() => ctx.mock.close());
beforeEach(async () => {
  ctx.mock.reset();
  await clearAllMoveJobs();
});

const put = (Key, Body) => ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));
async function bytes(Key) {
  const r = await ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key })).catch(() => null);
  return r ? r.Body.transformToString() : null;
}
async function run(fn) {
  let done;
  await fn((u) => {
    if (u.phase === 'done') done = u;
  });
  return done;
}
// A client that lets the real one through, with hooks around chosen commands.
function hooked(hooks) {
  return {
    async send(cmd, opts) {
      const name = cmd.constructor.name;
      if (hooks.before?.[name]) await hooks.before[name](cmd);
      const out = await ctx.client.send(cmd, opts);
      if (hooks.after?.[name]) await hooks.after[name](cmd);
      return out;
    },
  };
}
const op = (jobId) => ({
  jobId,
  provider: 'generic',
  endpoint: 'e',
  files: [{ key: 'src/f.txt', size: 18 }],
  dest: 'dst/',
});

describe('move identity (#74, #75)', () => {
  test('#74: resume does not delete the source when an unrelated object now sits at the destination', async () => {
    await put('src/f.txt', 'important original');
    // Interrupt after the job record is saved, before any copy (the 2nd cancel poll).
    let polls = 0;
    await run((cb) => runMoveOperation(ctx.client, BUCKET, op('mv-a'), cb, () => ++polls >= 2));
    const rec = await loadMoveJob('mv-a');
    assert.ok(rec, 'precondition: the interrupted move left a resumable record');
    await put('dst/f.txt', 'UNRELATED file written meanwhile by another writer');

    const done = await run((cb) => resumeMoveOperation(ctx.client, BUCKET, rec, cb));
    assert.equal(await bytes('src/f.txt'), 'important original', 'the source must survive');
    assert.equal(await bytes('dst/f.txt'), 'UNRELATED file written meanwhile by another writer');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1, 'the unverified destination is reported');
  });

  test('#74 (positive): a genuine copied-but-not-deleted item is finished by resume', async () => {
    await put('src/f.txt', 'important original');
    // The copy succeeds; the source delete fails once (non-retryable), leaving the record.
    let deny = true;
    const client = hooked({
      before: {
        DeleteObjectCommand: () => {
          if (!deny) return;
          deny = false;
          const err = new Error('Access Denied');
          err.name = 'AccessDenied';
          err.$metadata = { httpStatusCode: 403 };
          throw err;
        },
      },
    });
    await run((cb) => runMoveOperation(client, BUCKET, op('mv-b'), cb));
    assert.equal(await bytes('src/f.txt'), 'important original', 'precondition: source still there');
    assert.equal(await bytes('dst/f.txt'), 'important original', 'precondition: copy landed');
    const rec = await loadMoveJob('mv-b');
    assert.ok(rec, 'precondition: record kept');

    const done = await run((cb) => resumeMoveOperation(ctx.client, BUCKET, rec, cb));
    assert.equal(await bytes('src/f.txt'), null, 'resume finishes the move by deleting the source');
    assert.equal(await bytes('dst/f.txt'), 'important original');
    assert.equal(done.moved, 1);
    assert.deepEqual(done.errors, []);
  });

  test('#75: a source replaced between copy and delete is kept, not deleted', async () => {
    await put('src/f.txt', 'v1 original bytes!');
    const client = hooked({
      after: {
        // Another writer replaces the source right after the server-side copy returns.
        CopyObjectCommand: () => put('src/f.txt', 'v2 written by a neighbour'),
      },
    });
    const done = await run((cb) => runMoveOperation(client, BUCKET, op('mv-c'), cb));
    assert.equal(await bytes('src/f.txt'), 'v2 written by a neighbour', 'the replacement must survive');
    assert.equal(await bytes('dst/f.txt'), 'v1 original bytes!');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1, 'the changed source is reported');
  });

  test('an ordinary move still copies and deletes (sideways)', async () => {
    await put('src/f.txt', 'important original');
    const done = await run((cb) => runMoveOperation(ctx.client, BUCKET, op('mv-d'), cb));
    assert.equal(await bytes('src/f.txt'), null);
    assert.equal(await bytes('dst/f.txt'), 'important original');
    assert.equal(done.moved, 1);
    assert.equal(await loadMoveJob('mv-d'), null, 'a clean move leaves no record');
  });
});
