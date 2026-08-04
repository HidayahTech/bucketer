// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, TINY_MAX, MEDIUM_MAX, CONCURRENCY, createTempStore, TEMP_CHUNK, sweepOrphanTemps } from '../src/lib/zip-prefetch.js';

// Trimmed copy of the fake OPFS root from test/zip-job-run.test.js (write-fault
// injection dropped — this file's tests don't need it). Same shape: getFileHandle /
// removeEntry on the root, createWritable({keepExistingData}) / getFile() on the handle.
function fakeOpfsRoot() {
  const files = new Map();
  const wholeFileReads = new Map(); // name -> count of getFile().arrayBuffer() (unsliced) calls
  return {
    files,
    wholeFileReads,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
        files.set(name, new Uint8Array(0));
      }
      return {
        async createWritable({ keepExistingData = false } = {}) {
          let buf = keepExistingData ? Uint8Array.from(files.get(name)) : new Uint8Array(0);
          let pos = buf.length;
          return {
            async write(u8) {
              const grown = new Uint8Array(Math.max(buf.length, pos + u8.length));
              grown.set(buf); grown.set(u8, pos); buf = grown; pos += u8.length;
            },
            async truncate(n) { buf = buf.slice(0, n); pos = Math.min(pos, n); },
            async seek(n) { pos = n; },
            async close() { files.set(name, buf); },
          };
        },
        async getFile() {
          const b = files.get(name);
          return {
            size: b.length,
            // Whole-file read — instrumented so a test can assert a chunked reader
            // never falls back to this (see the "does not materialize the whole file"
            // assertion below).
            async arrayBuffer() {
              wholeFileReads.set(name, (wholeFileReads.get(name) || 0) + 1);
              return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
            },
            // Blob.slice()-alike: a real chunked reader takes bounded-size slices of
            // this instead of the whole-file arrayBuffer() above.
            slice(start, end) {
              const s = b.slice(start, end);
              return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.length) };
            },
          };
        },
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
      files.delete(name);
    },
    // Real FileSystemDirectoryHandle.keys() returns an async iterable of entry names —
    // mirrored here (sync generator; `for await` accepts a sync iterable just as well)
    // for sweepOrphanTemps, which is the only caller in this file that needs directory
    // enumeration rather than a single named lookup.
    *keys() {
      yield* files.keys();
    },
  };
}

describe('classifyTier', () => {
  test('tiny/medium/solo boundaries', () => {
    assert.equal(classifyTier(0), 'memory');
    assert.equal(classifyTier(TINY_MAX), 'memory');
    assert.equal(classifyTier(TINY_MAX + 1), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX), 'temp');
    assert.equal(classifyTier(MEDIUM_MAX + 1), 'solo');
  });
  test('missing size is bufferable', () => {
    assert.equal(classifyTier(undefined), 'memory');
    assert.equal(classifyTier(null), 'memory');
  });
  test('default concurrency is 4', () => { assert.equal(CONCURRENCY, 4); });
});

describe('createTempStore', () => {
  test('put streams a sync iterable of chunks into a bucketer-tmp-<name> OPFS file and reports the total size', async () => {
    const root = fakeOpfsRoot();
    const store = createTempStore(root);
    const chunks = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];

    const result = await store.put('a.txt', chunks);

    assert.deepEqual(result, { size: 11 });
    assert.ok(root.files.has('bucketer-tmp-a.txt'));
    assert.equal(new TextDecoder().decode(root.files.get('bucketer-tmp-a.txt')), 'hello world');
  });

  test('put also accepts an async iterable of chunks', async () => {
    const root = fakeOpfsRoot();
    const store = createTempStore(root);
    async function* gen() {
      yield new TextEncoder().encode('a');
      yield new TextEncoder().encode('bc');
    }

    const result = await store.put('b.txt', gen());

    assert.equal(result.size, 3);
    assert.equal(new TextDecoder().decode(root.files.get('bucketer-tmp-b.txt')), 'abc');
  });

  test('open(name).stream() yields back exactly the bytes written, chunked at TEMP_CHUNK', async () => {
    const root = fakeOpfsRoot();
    const store = createTempStore(root);
    // Bigger than one TEMP_CHUNK so the read-back must span multiple yields.
    const size = TEMP_CHUNK + 1024;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = i % 256;

    await store.put('big.bin', [original]);
    const handle = await store.open('big.bin');
    const chunks = [];
    for await (const chunk of handle.stream()) chunks.push(chunk);

    assert.ok(chunks.length >= 2, 'a file larger than TEMP_CHUNK must be read back in more than one chunk');
    for (const c of chunks.slice(0, -1)) assert.equal(c.length, TEMP_CHUNK);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    assert.equal(total, size);
    const rebuilt = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { rebuilt.set(c, pos); pos += c.length; }
    assert.deepEqual(rebuilt, original);

    assert.equal(root.wholeFileReads.get('bucketer-tmp-big.bin') || 0, 0,
      'stream() must read via chunked slice() calls only — a whole-file arrayBuffer() ' +
      'read would defeat the point of the OPFS temp tier (keeping medium-file bytes off ' +
      'the in-memory budget)');
  });

  test('remove deletes the temp file', async () => {
    const root = fakeOpfsRoot();
    const store = createTempStore(root);
    await store.put('gone.txt', [new TextEncoder().encode('x')]);
    assert.ok(root.files.has('bucketer-tmp-gone.txt'));

    await store.remove('gone.txt');

    assert.equal(root.files.has('bucketer-tmp-gone.txt'), false);
  });

  test('remove is best-effort: it does not throw for a name that was never created', async () => {
    const root = fakeOpfsRoot();
    const store = createTempStore(root);
    await assert.doesNotReject(store.remove('never-existed.txt'));
  });

  test('removeAll deletes every temp file this store created, leaving other files untouched', async () => {
    const root = fakeOpfsRoot();
    // A non-temp file already present, and a bucketer-tmp-* file NOT created by this
    // store instance (e.g. left over from an earlier store/session) — removeAll must
    // only target names it tracked itself, not every bucketer-tmp-* file in the root.
    root.files.set('unrelated.zip', new TextEncoder().encode('keep-me'));
    root.files.set('bucketer-tmp-stale.bin', new TextEncoder().encode('not-mine'));

    const store = createTempStore(root);
    await store.put('one.txt', [new TextEncoder().encode('1')]);
    await store.put('two.txt', [new TextEncoder().encode('2')]);

    await store.removeAll();

    assert.equal(root.files.has('bucketer-tmp-one.txt'), false);
    assert.equal(root.files.has('bucketer-tmp-two.txt'), false);
    assert.equal(new TextDecoder().decode(root.files.get('unrelated.zip')), 'keep-me');
    assert.equal(new TextDecoder().decode(root.files.get('bucketer-tmp-stale.bin')), 'not-mine');
  });
});

describe('sweepOrphanTemps', () => {
  test('deletes every bucketer-tmp-* entry, leaves staging zips and unrelated files alone', async () => {
    const root = fakeOpfsRoot();
    // Two orphaned prefetch temps (e.g. left behind by a crashed tab, from two different
    // runs — tempSeq restarts at 0 each run, so colliding names across runs are expected
    // and exactly what this sweep exists to clean up).
    root.files.set('bucketer-tmp-p0', new Uint8Array(0));
    root.files.set('bucketer-tmp-p1', new Uint8Array(0));
    // A staging zip tied to a live job record — must survive; it is cleaned up via
    // discardZipStaging/job lifecycle, never by this sweep.
    root.files.set('bucketer-zip-job1.zip', new Uint8Array(0));
    // Something this feature never wrote at all.
    root.files.set('unrelated-file.txt', new Uint8Array(0));

    await sweepOrphanTemps(root);

    assert.deepEqual(
      [...root.files.keys()].sort(),
      ['bucketer-zip-job1.zip', 'unrelated-file.txt'],
    );
  });

  test('best-effort: a single removeEntry failure does not abort the rest of the sweep', async () => {
    const root = fakeOpfsRoot();
    root.files.set('bucketer-tmp-a', new Uint8Array(0));
    root.files.set('bucketer-tmp-b', new Uint8Array(0));
    const realRemove = root.removeEntry.bind(root);
    root.removeEntry = async (name) => {
      if (name === 'bucketer-tmp-a') throw new Error('simulated OPFS failure');
      return realRemove(name);
    };

    await assert.doesNotReject(sweepOrphanTemps(root));

    // The failing entry is left behind (best-effort, not retried), but the sweep still
    // reached and removed the other one rather than aborting on the first error.
    assert.equal(root.files.has('bucketer-tmp-a'), true);
    assert.equal(root.files.has('bucketer-tmp-b'), false);
  });

  test('best-effort: a root with no keys() (OPFS directory enumeration unsupported) does not throw', async () => {
    const root = { async removeEntry() {} }; // no keys() at all
    await assert.doesNotReject(sweepOrphanTemps(root));
  });
});
