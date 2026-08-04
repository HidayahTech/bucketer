// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, TINY_MAX, MEDIUM_MAX, CONCURRENCY, createTempStore, TEMP_CHUNK } from '../src/lib/zip-prefetch.js';

// Trimmed copy of the fake OPFS root from test/zip-job-run.test.js (write-fault
// injection dropped — this file's tests don't need it). Same shape: getFileHandle /
// removeEntry on the root, createWritable({keepExistingData}) / getFile() on the handle.
function fakeOpfsRoot() {
  const files = new Map();
  return {
    files,
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
        async getFile() { const b = files.get(name); return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
      files.delete(name);
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
