import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runMoveOperation, runCopyOperation, runRenameOperation } from '../src/lib/move-queue.js';

// A move is per-object: server-side copy, then — only after that copy is confirmed —
// delete the source. These tests pin the safety-critical behavior: ordering, collisions
// (never overwrite), multipart routing, and the dangerous delete-denied-after-copy case.
//
// Mock S3 client dispatches on command constructor name and records a call log so tests
// can assert ordering and which commands fired (mirrors test/delete-queue.test.js style).

function mockClient(opts = {}) {
  const {
    listPages = new Map(),     // Map<Prefix, [{ objects:[{Key,Size}], isTruncated, nextToken }]>
    copyReject,                // (input) => Error | undefined
    deleteReject,              // (input) => Error | undefined
    multipart = false,         // if true, handle Head/Create/PartCopy/Complete/Abort
  } = opts;
  const calls = [];
  return {
    calls,
    send(cmd) {
      const name = cmd.constructor?.name ?? '';
      const input = cmd.input;
      calls.push({ name, input });

      if (name === 'ListObjectsV2Command') {
        const { Prefix, ContinuationToken } = input;
        const pages = listPages.get(Prefix);
        if (!pages) return Promise.reject(new Error(`unexpected prefix: ${Prefix}`));
        const page = ContinuationToken
          ? pages.find((p, i) => p.nextToken === ContinuationToken && i > 0)
          : pages[0];
        if (!page) return Promise.reject(new Error(`no page for token ${ContinuationToken}`));
        return Promise.resolve({
          Contents: (page.objects || []).map(o => ({ Key: o.Key, Size: o.Size ?? 0 })),
          IsTruncated: page.isTruncated ?? false,
          NextContinuationToken: page.nextToken,
        });
      }
      if (name === 'CopyObjectCommand') {
        const err = copyReject?.(input);
        return err ? Promise.reject(err) : Promise.resolve({ CopyObjectResult: { ETag: 'e' } });
      }
      if (name === 'DeleteObjectCommand') {
        const err = deleteReject?.(input);
        return err ? Promise.reject(err) : Promise.resolve({});
      }
      if (multipart) {
        if (name === 'HeadObjectCommand') return Promise.resolve({ ContentType: 'application/octet-stream', Metadata: {} });
        if (name === 'CreateMultipartUploadCommand') return Promise.resolve({ UploadId: 'up' });
        if (name === 'UploadPartCopyCommand') return Promise.resolve({ CopyPartResult: { ETag: `e-${input.PartNumber}` } });
        if (name === 'CompleteMultipartUploadCommand') return Promise.resolve({});
        if (name === 'AbortMultipartUploadCommand') return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected command: ${name}`));
    },
  };
}

const emptyDest = (prefix) => new Map([[prefix, [{ objects: [], isTruncated: false }]]]);

async function runAndCollect(client, bucket, op) {
  const updates = [];
  await runMoveOperation(client, bucket, op, u => updates.push({ ...u }));
  return updates;
}

function callIndex(calls, predicate) {
  return calls.findIndex(predicate);
}

// ── Files-only ────────────────────────────────────────────────────────────────

describe('runMoveOperation — files only', () => {
  test('skips discovery, emits checking → moving → done', async () => {
    const client = mockClient({ listPages: emptyDest('archive/') });
    const op = { files: [{ key: 'a.txt', size: 10 }, { key: 'b.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    const phases = updates.filter(u => u.phase).map(u => u.phase);
    assert.ok(!phases.includes('discovering'), 'no discovery for files-only');
    assert.ok(phases.includes('checking'));
    assert.ok(phases.includes('moving'));
    assert.ok(phases.includes('done'));
  });

  test('reports total and moved count, emits movedKeys', async () => {
    const client = mockClient({ listPages: emptyDest('archive/') });
    const op = { files: [{ key: 'a.txt', size: 10 }, { key: 'b.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    assert.equal(updates.find(u => u.phase === 'moving').total, 2);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 2);
    assert.equal(done.errors.length, 0);

    const allMovedKeys = updates.flatMap(u => u.movedKeys || []);
    assert.deepEqual(allMovedKeys.sort(), ['a.txt', 'b.txt']);
  });

  test('copies each object to its remapped key before deleting the source', async () => {
    const client = mockClient({ listPages: emptyDest('archive/') });
    const op = { files: [{ key: 'a.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    await runAndCollect(client, 'bk', op);

    const copyIdx = callIndex(client.calls, c => c.name === 'CopyObjectCommand' && c.input.Key === 'archive/a.txt');
    const delIdx = callIndex(client.calls, c => c.name === 'DeleteObjectCommand' && c.input.Key === 'a.txt');
    assert.ok(copyIdx >= 0 && delIdx >= 0, 'both copy and delete must happen');
    assert.ok(copyIdx < delIdx, 'copy must precede delete for the same object');
    const copy = client.calls.find(c => c.name === 'CopyObjectCommand');
    assert.equal(copy.input.CopySource, 'bk/a.txt');
    assert.equal(copy.input.MetadataDirective, 'COPY');
  });

  test('empty op completes immediately with 0 moved and no dest crawl', async () => {
    const client = mockClient(); // no listPages — a dest crawl would throw
    const updates = await runAndCollect(client, 'bk', { files: [], prefixes: [], dest: 'archive/' });
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 0);
    assert.ok(!client.calls.some(c => c.name === 'ListObjectsV2Command'), 'must not crawl on an empty op');
  });
});

// ── Folder discovery + remap ────────────────────────────────────────────────────

describe('runMoveOperation — folder moves', () => {
  test('discovers, remaps keys under the moved folder, and reports movedPrefixes', async () => {
    const listPages = new Map([
      ['photos/2024/', [{ objects: [
        { Key: 'photos/2024/a.jpg', Size: 10 },
        { Key: 'photos/2024/jan/b.jpg', Size: 10 },
      ], isTruncated: false }]],
      ['archive/', [{ objects: [], isTruncated: false }]],
    ]);
    const client = mockClient({ listPages });
    const op = { files: [], prefixes: ['photos/2024/'], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    const copyKeys = client.calls.filter(c => c.name === 'CopyObjectCommand').map(c => c.input.Key).sort();
    assert.deepEqual(copyKeys, ['archive/2024/a.jpg', 'archive/2024/jan/b.jpg']);

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 2);
    assert.deepEqual(done.movedPrefixes, ['photos/2024/']);
  });

  test('moves the 0-byte folder-marker object with a single copy (no multipart)', async () => {
    const listPages = new Map([
      ['photos/2024/', [{ objects: [{ Key: 'photos/2024/', Size: 0 }], isTruncated: false }]],
      ['archive/', [{ objects: [], isTruncated: false }]],
    ]);
    const client = mockClient({ listPages });
    await runAndCollect(client, 'bk', { files: [], prefixes: ['photos/2024/'], dest: 'archive/' });

    const copy = client.calls.find(c => c.name === 'CopyObjectCommand');
    assert.equal(copy.input.Key, 'archive/2024/');
    assert.ok(!client.calls.some(c => c.name === 'CreateMultipartUploadCommand'));
  });

  test('a folder with one failed key is excluded from movedPrefixes', async () => {
    const listPages = new Map([
      ['f/', [{ objects: [{ Key: 'f/ok.txt', Size: 10 }, { Key: 'f/bad.txt', Size: 10 }], isTruncated: false }]],
      ['dest/', [{ objects: [], isTruncated: false }]],
    ]);
    const client = mockClient({
      listPages,
      copyReject: (input) => input.CopySource.endsWith('f/bad.txt') ? new Error('AccessDenied') : undefined,
    });
    const updates = await runAndCollect(client, 'bk', { files: [], prefixes: ['f/'], dest: 'dest/' });
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 1);
    assert.equal(done.movedPrefixes.length, 0, 'folder with a failed key must not be in movedPrefixes');
  });
});

// ── Collisions (never overwrite) ────────────────────────────────────────────────

describe('runMoveOperation — collisions', () => {
  test('skips an object whose destination key already exists; leaves both sides untouched', async () => {
    const listPages = new Map([['archive/', [{ objects: [{ Key: 'archive/q1.pdf', Size: 5 }], isTruncated: false }]]]);
    const client = mockClient({ listPages });
    const op = { files: [{ key: 'reports/q1.pdf', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    assert.ok(!client.calls.some(c => c.name === 'CopyObjectCommand'), 'must not copy a colliding object');
    assert.ok(!client.calls.some(c => c.name === 'DeleteObjectCommand'), 'must not delete the source of a colliding object');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].key, 'reports/q1.pdf');
    assert.ok(done.errors[0].skipped, 'collision errors are flagged skipped so the UI can distinguish them');
  });

  test('detects intra-batch collisions (two sources mapping to the same destination key)', async () => {
    const listPages = new Map([['archive/', [{ objects: [], isTruncated: false }]]]);
    const client = mockClient({ listPages });
    // Both 'x/dup.txt' and 'y/dup.txt' remap to 'archive/dup.txt'.
    const op = { files: [{ key: 'x/dup.txt', size: 10 }, { key: 'y/dup.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    const copies = client.calls.filter(c => c.name === 'CopyObjectCommand');
    assert.equal(copies.length, 1, 'only the first claimant of a destination key is moved');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 1);
    assert.equal(done.errors.filter(e => e.skipped).length, 1);
  });
});

// ── Multipart routing ───────────────────────────────────────────────────────────

describe('runMoveOperation — large objects', () => {
  test('routes objects over 5 GiB through multipart UploadPartCopy, not single copy', async () => {
    const big = 5 * 1024 * 1024 * 1024 + 1; // just over the threshold
    const client = mockClient({ listPages: emptyDest('archive/'), multipart: true });
    const op = { files: [{ key: 'huge.bin', size: big }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    assert.ok(client.calls.some(c => c.name === 'CreateMultipartUploadCommand'), 'must start a multipart copy');
    assert.ok(client.calls.some(c => c.name === 'CompleteMultipartUploadCommand'), 'must complete it');
    assert.ok(!client.calls.some(c => c.name === 'CopyObjectCommand'), 'must not use single-request copy');

    const createIdx = callIndex(client.calls, c => c.name === 'CompleteMultipartUploadCommand');
    const delIdx = callIndex(client.calls, c => c.name === 'DeleteObjectCommand' && c.input.Key === 'huge.bin');
    assert.ok(delIdx > createIdx, 'source delete must follow multipart completion');

    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 1);
  });
});

// ── Failure handling ────────────────────────────────────────────────────────────

describe('runMoveOperation — failures leave data intact', () => {
  test('when the copy fails, the source is not deleted and is not reported moved', async () => {
    const client = mockClient({
      listPages: emptyDest('archive/'),
      copyReject: () => new Error('AccessDenied'),
    });
    const op = { files: [{ key: 'a.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    assert.ok(!client.calls.some(c => c.name === 'DeleteObjectCommand'), 'must not delete after a failed copy');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1);
    assert.ok(!(updates.flatMap(u => u.movedKeys || []).includes('a.txt')));
  });

  test('delete-denied-after-copy reports a distinct "exists in both places" error and does not count as moved', async () => {
    const client = mockClient({
      listPages: emptyDest('archive/'),
      deleteReject: () => Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }),
    });
    const op = { files: [{ key: 'a.txt', size: 10 }], prefixes: [], dest: 'archive/' };
    const updates = await runAndCollect(client, 'bk', op);

    assert.ok(client.calls.some(c => c.name === 'CopyObjectCommand'), 'copy still happens');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 0, 'a copy-without-delete is not a completed move');
    assert.equal(done.errors.length, 1);
    assert.match(done.errors[0].message, /both places/i);
    assert.ok(!(updates.flatMap(u => u.movedKeys || []).includes('a.txt')), 'source row must stay (it still exists)');
  });

  test('discovery listing failure ends with a single (listing) error', async () => {
    const client = { send: () => Promise.reject(new Error('AccessDenied')) };
    const updates = await runAndCollect(client, 'bk', { files: [], prefixes: ['secret/'], dest: 'archive/' });
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].key, '(listing)');
  });

  test('destination collision-crawl failure ends with a single (listing) error', async () => {
    // Source discovery succeeds (empty would short-circuit), so move a loose file and
    // make the dest crawl the only ListObjectsV2 — reject it.
    const client = {
      send(cmd) {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') return Promise.reject(new Error('ListDenied'));
        return Promise.reject(new Error(`unexpected ${name}`));
      },
    };
    const updates = await runAndCollect(client, 'bk', { files: [{ key: 'a.txt', size: 10 }], prefixes: [], dest: 'archive/' });
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.errors.length, 1);
    assert.equal(done.errors[0].key, '(listing)');
    assert.ok(!client.calls?.some?.(c => c.name === 'CopyObjectCommand'));
  });
});

// ── Throttling retry ────────────────────────────────────────────────────────────

function withFastRetry(fn) {
  const real = global.setTimeout;
  global.setTimeout = (cb) => real(cb, 0);
  return fn().finally(() => { global.setTimeout = real; });
}

describe('runMoveOperation — throttling retry', () => {
  test('retries a throttled copy then succeeds', () => withFastRetry(async () => {
    let copyCalls = 0;
    const client = {
      calls: [],
      send(cmd) {
        const name = cmd.constructor?.name ?? '';
        this.calls.push({ name, input: cmd.input });
        if (name === 'ListObjectsV2Command') return Promise.resolve({ Contents: [], IsTruncated: false });
        if (name === 'CopyObjectCommand') {
          copyCalls++;
          if (copyCalls === 1) return Promise.reject(Object.assign(new Error('SlowDown'), { code: 'SlowDown' }));
          return Promise.resolve({});
        }
        if (name === 'DeleteObjectCommand') return Promise.resolve({});
        return Promise.reject(new Error(`unexpected ${name}`));
      },
    };
    const updates = await runAndCollect(client, 'bk', { files: [{ key: 'a.txt', size: 10 }], prefixes: [], dest: 'archive/' });
    assert.equal(copyCalls, 2, 'must retry the throttled copy exactly once');
    assert.equal(updates.find(u => u.phase === 'done').moved, 1);
  }));
});

// ── Copy-and-keep (#17) ──────────────────────────────────────────────────────────
// A copy is a move minus the source delete, and collisions are renamed (never skipped,
// never overwritten). Source rows must stay, so no movedKeys/movedPrefixes are emitted.

async function copyAndCollect(client, bucket, op) {
  const updates = [];
  await runCopyOperation(client, bucket, op, u => updates.push({ ...u }));
  return updates;
}

describe('runCopyOperation — copy-and-keep', () => {
  test('copies a loose file and never deletes the source', async () => {
    const client = mockClient({ listPages: emptyDest('archive/') });
    const updates = await copyAndCollect(client, 'bk', { files: [{ key: 'docs/a.txt', size: 10 }], prefixes: [], dest: 'archive/' });
    const copies = client.calls.filter(c => c.name === 'CopyObjectCommand');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].input.Key, 'archive/a.txt');
    assert.equal(client.calls.filter(c => c.name === 'DeleteObjectCommand').length, 0, 'copy must not delete the source');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 1);
  });

  test('renames on collision instead of skipping (never overwrites)', async () => {
    const client = mockClient({ listPages: new Map([['archive/', [{ objects: [{ Key: 'archive/a.txt' }, { Key: 'archive/a (1).txt' }], isTruncated: false }]]]) });
    const updates = await copyAndCollect(client, 'bk', { files: [{ key: 'docs/a.txt', size: 5 }], prefixes: [], dest: 'archive/' });
    const copies = client.calls.filter(c => c.name === 'CopyObjectCommand');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].input.Key, 'archive/a (2).txt', 'collision suffixed to a free name');
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.moved, 1);
    assert.equal(done.errors.length, 0, 'a collision is not an error for copy');
  });

  test('leaves source rows in place (no movedKeys / movedPrefixes)', async () => {
    const client = mockClient({ listPages: emptyDest('archive/') });
    const updates = await copyAndCollect(client, 'bk', { files: [{ key: 'a.txt', size: 1 }], prefixes: [], dest: 'archive/' });
    assert.deepEqual(updates.flatMap(u => u.movedKeys || []), [], 'copy must not signal source-row removal');
    assert.deepEqual(updates.find(u => u.phase === 'done').movedPrefixes, []);
  });

  test('routes large objects through multipart copy, still without deleting', async () => {
    const big = 5 * 1024 * 1024 * 1024 + 1;
    const client = mockClient({ listPages: emptyDest('archive/'), multipart: true });
    const updates = await copyAndCollect(client, 'bk', { files: [{ key: 'big.bin', size: big }], prefixes: [], dest: 'archive/' });
    assert.ok(client.calls.some(c => c.name === 'UploadPartCopyCommand'), 'large copy uses multipart');
    assert.equal(client.calls.filter(c => c.name === 'DeleteObjectCommand').length, 0);
    assert.equal(updates.find(u => u.phase === 'done').moved, 1);
  });
});

// ── Cooperative cancellation ──────────────────────────────────────────────────

describe('runMoveOperation — cooperative cancel', () => {
  test('cancel after the first moved object stops the remaining work', async () => {
    // 20 loose files; the cancel flag flips when the first movedKeys update
    // arrives. Workers stop claiming; done reports cancelled with moved < 20.
    const files = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}.txt`, size: 1 }));
    const listPages = new Map([['d/', [{ objects: [], isTruncated: false }]]]);
    const client = mockClient({ listPages });
    let cancelled = false;
    const updates = [];
    await runMoveOperation(client, 'b', { files, prefixes: [], dest: 'd/' }, (u) => {
      updates.push({ ...u });
      if (u.movedKeys?.length) cancelled = true;
    }, () => cancelled);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.ok(done.moved < 20, `moved ${done.moved}, expected fewer than 20`);
  });

  test('cancelled run never lists a partially-moved prefix in movedPrefixes', async () => {
    // Prefix with 20 objects; cancel after first movedKeys update → some
    // objects unmoved → prefix must not be reported complete.
    const objects = Array.from({ length: 20 }, (_, i) => ({ Key: `p/f${i}.txt`, Size: 1 }));
    const listPages = new Map([
      ['p/', [{ objects, isTruncated: false }]],
      ['d/', [{ objects: [], isTruncated: false }]],
    ]);
    const client = mockClient({ listPages });
    let cancelled = false;
    const updates = [];
    await runMoveOperation(client, 'b', { files: [], prefixes: ['p/'], dest: 'd/' }, (u) => {
      updates.push({ ...u });
      if (u.movedKeys?.length) cancelled = true;
    }, () => cancelled);
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, true);
    assert.deepEqual(done.movedPrefixes, []);
  });

  test('uncancelled runs report cancelled=false with behavior unchanged', async () => {
    const listPages = new Map([['d/', [{ objects: [], isTruncated: false }]]]);
    const client = mockClient({ listPages });
    const updates = [];
    await runMoveOperation(client, 'b', { files: [{ key: 'a.txt', size: 1 }], prefixes: [], dest: 'd/' }, (u) => {
      updates.push({ ...u });
    });
    const done = updates.find(u => u.phase === 'done');
    assert.equal(done.cancelled, false);
    assert.equal(done.moved, 1);
  });
});

// ── Folder rename (#18) ─────────────────────────────────────────────────────────

describe('runRenameOperation — folder rename', () => {
  function runRename(client, bucket, op) {
    const updates = [];
    return runRenameOperation(client, bucket, op, u => updates.push({ ...u })).then(() => updates);
  }

  test('remaps every key onto the new prefix and deletes the sources', async () => {
    const client = mockClient({ listPages: new Map([
      ['photos/2024/', [{ objects: [
        { Key: 'photos/2024/', Size: 0 },
        { Key: 'photos/2024/a.jpg', Size: 10 },
        { Key: 'photos/2024/jan/b.jpg', Size: 20 },
      ], isTruncated: false }]],
      ['photos/memories/', [{ objects: [], isTruncated: false }]], // target empty → no collision
    ]) });
    const updates = await runRename(client, 'b', { prefixes: ['photos/2024/'], renameTo: 'memories', capturedPrefix: 'photos/' });

    const copied = client.calls.filter(c => c.name === 'CopyObjectCommand').map(c => c.input.Key).sort();
    assert.deepEqual(copied, ['photos/memories/', 'photos/memories/a.jpg', 'photos/memories/jan/b.jpg']);
    const deleted = client.calls.filter(c => c.name === 'DeleteObjectCommand').map(c => c.input.Key).sort();
    assert.deepEqual(deleted, ['photos/2024/', 'photos/2024/a.jpg', 'photos/2024/jan/b.jpg']);
    const done = updates.at(-1);
    assert.equal(done.phase, 'done');
    assert.equal(done.moved, 3);
    assert.deepEqual(done.movedPrefixes, ['photos/2024/']);
  });

  test('blocks wholesale when the target folder already exists — copies nothing', async () => {
    const client = mockClient({ listPages: new Map([
      ['photos/2024/', [{ objects: [{ Key: 'photos/2024/a.jpg', Size: 10 }], isTruncated: false }]],
      ['photos/archive/', [{ objects: [{ Key: 'photos/archive/old.txt', Size: 5 }], isTruncated: false }]],
    ]) });
    const updates = await runRename(client, 'b', { prefixes: ['photos/2024/'], renameTo: 'archive', capturedPrefix: 'photos/' });

    assert.equal(client.calls.some(c => c.name === 'CopyObjectCommand'), false, 'no copies');
    assert.equal(client.calls.some(c => c.name === 'DeleteObjectCommand'), false, 'no deletes');
    const done = updates.at(-1);
    assert.equal(done.moved, 0);
    assert.equal(done.errors.length, 1);
    assert.match(done.errors[0].message, /already exists/i);
  });
});
