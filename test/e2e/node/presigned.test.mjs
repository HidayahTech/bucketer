// Node-integration e2e — presigned GET behaviours the app relies on for download/preview/dedup:
// a presigned URL is a plain browser fetch, and a Range request must return 206 with the slice
// (text preview truncation + dedup byte-range verify both depend on this).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { startMock, BUCKET } from '../harness.mjs';

let ctx;
before(async () => { ctx = await startMock(); });
after(() => ctx.mock.close());
beforeEach(() => ctx.mock.reset());

const seed = (key, content) => ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: new TextEncoder().encode(content) }));

describe('presigned GET', () => {
  test('a presigned URL fetches the full object', async () => {
    await seed('p/full.txt', 'the-whole-payload');
    const url = await getSignedUrl(ctx.client, new GetObjectCommand({ Bucket: BUCKET, Key: 'p/full.txt' }), { expiresIn: 3600 });
    const resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'the-whole-payload');
  });

  test('a presigned URL with a Range returns 206 and only the slice (text preview / dedup verify)', async () => {
    await seed('p/range.txt', '0123456789ABCDEF');
    const url = await getSignedUrl(ctx.client, new GetObjectCommand({ Bucket: BUCKET, Key: 'p/range.txt' }), { expiresIn: 3600 });
    const resp = await fetch(url, { headers: { Range: 'bytes=4-9' } });
    assert.equal(resp.status, 206, 'a ranged GET is a partial response');
    assert.equal(resp.headers.get('content-range'), 'bytes 4-9/16');
    assert.equal(await resp.text(), '456789');
  });

  test('a presigned URL with a response-content-disposition override sets the header (download)', async () => {
    await seed('p/dl.txt', 'data');
    const url = await getSignedUrl(ctx.client, new GetObjectCommand({
      Bucket: BUCKET, Key: 'p/dl.txt', ResponseContentDisposition: 'attachment; filename="dl.txt"',
    }), { expiresIn: 3600 });
    const resp = await fetch(url);
    assert.match(resp.headers.get('content-disposition') || '', /attachment/);
  });
});
