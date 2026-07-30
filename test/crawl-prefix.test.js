// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/crawl-prefix.js — the streaming prefix crawler.
//
// The point of this module is what it does NOT do: it never accumulates a prefix's keys
// in memory. The existing delete/move/dedup crawlers buffer whole prefixes into arrays
// and Sets, which is the High-severity OOM flagged in docs/review-v1.26.3. Every test
// here that checks "hands each page to onBatch" is really checking that property.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crawlPrefix } from '../src/lib/crawl-prefix.js';

// Mock S3 client dispatching on command constructor name, matching test/delete-queue.test.js.
function mockClient(pages) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      assert.equal(cmd.constructor.name, 'ListObjectsV2Command');
      calls.push({ ...cmd.input });
      const idx = pages.findIndex(p => (p.token ?? undefined) === cmd.input.ContinuationToken);
      const page = pages[idx === -1 ? 0 : idx];
      return {
        Contents: page.contents,
        IsTruncated: !!page.next,
        NextContinuationToken: page.next,
      };
    },
  };
}

const obj = (Key, Size = 10) => ({ Key, Size, ETag: `"${Key}"`, LastModified: new Date(0) });

describe('crawlPrefix', () => {
  test('hands a single page to onBatch and totals it', async () => {
    const client = mockClient([{ token: undefined, contents: [obj('a', 5), obj('b', 7)] }]);
    const batches = [];
    const result = await crawlPrefix(client, 'bkt', 'p/', { onBatch: b => batches.push(b) });

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map(o => o.Key), ['a', 'b']);
    assert.equal(result.objects, 2);
    assert.equal(result.bytes, 12);
    assert.equal(result.cancelled, false);
  });

  test('pages through a truncated listing', async () => {
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')], next: 't2' },
      { token: 't2', contents: [obj('c')] },
    ]);
    const seen = [];
    const result = await crawlPrefix(client, 'bkt', '', { onBatch: b => seen.push(...b.map(o => o.Key)) });

    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(result.objects, 3);
    assert.equal(client.calls.length, 3);
  });

  test('never returns the keys itself — only per-page callbacks and counts', async () => {
    const client = mockClient([{ token: undefined, contents: [obj('a'), obj('b')] }]);
    const result = await crawlPrefix(client, 'bkt', '', { onBatch: () => {} });
    for (const value of Object.values(result)) {
      assert.equal(Array.isArray(value), false, 'crawlPrefix must not accumulate an array of keys');
    }
  });

  test('passes the resume token alongside each batch', async () => {
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')] },
    ]);
    const tokens = [];
    await crawlPrefix(client, 'bkt', '', { onBatch: (_b, meta) => tokens.push(meta.nextToken) });
    assert.deepEqual(tokens, ['t1', undefined]);
  });

  test('resumes from a supplied token', async () => {
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')] },
    ]);
    const seen = [];
    await crawlPrefix(client, 'bkt', '', { onBatch: b => seen.push(...b.map(o => o.Key)), startToken: 't1' });
    assert.deepEqual(seen, ['b']);
  });

  test('stops between pages when cancelled', async () => {
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')], next: 't2' },
      { token: 't2', contents: [obj('c')] },
    ]);
    const seen = [];
    let pages = 0;
    const result = await crawlPrefix(client, 'bkt', '', {
      onBatch: b => { pages += 1; seen.push(...b.map(o => o.Key)); },
      shouldCancel: () => pages >= 1,
    });

    assert.deepEqual(seen, ['a']);
    assert.equal(result.cancelled, true);
    assert.equal(result.nextToken, 't1', 'a cancelled crawl reports where to resume');
  });

  test('awaits onBatch before fetching the next page', async () => {
    const client = mockClient([
      { token: undefined, contents: [obj('a')], next: 't1' },
      { token: 't1', contents: [obj('b')] },
    ]);
    const order = [];
    await crawlPrefix(client, 'bkt', '', {
      onBatch: async (b) => {
        order.push(`start:${b[0].Key}`);
        await new Promise(r => setTimeout(r, 5));
        order.push(`end:${b[0].Key}`);
      },
    });
    assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('does not call onBatch for an empty listing', async () => {
    const client = mockClient([{ token: undefined, contents: [] }]);
    let called = 0;
    const result = await crawlPrefix(client, 'bkt', '', { onBatch: () => { called += 1; } });
    assert.equal(called, 0);
    assert.equal(result.objects, 0);
  });

  test('stops when IsTruncated is false even if a token is echoed back', async () => {
    const client = {
      async send() {
        return { Contents: [obj('a')], IsTruncated: false, NextContinuationToken: 'stale' };
      },
    };
    const result = await crawlPrefix(client, 'bkt', '', { onBatch: () => {} });
    assert.equal(result.objects, 1);
    assert.equal(result.nextToken, undefined);
  });

  test('sends the prefix and page size to S3', async () => {
    const client = mockClient([{ token: undefined, contents: [] }]);
    await crawlPrefix(client, 'bkt', 'videos/', { onBatch: () => {}, maxKeys: 200 });
    assert.equal(client.calls[0].Bucket, 'bkt');
    assert.equal(client.calls[0].Prefix, 'videos/');
    assert.equal(client.calls[0].MaxKeys, 200);
  });
});
