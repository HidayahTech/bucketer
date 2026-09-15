// Browser e2e: rename a FILE through the real UI against the mock S3. The key carries
// U+FF5C ("｜", as yt-dlp emits), which is the whole point (BUG-062): a raw
// `${bucket}/${key}` CopySource header is a Latin-1 ByteString the browser rejects for any
// char > U+00FF, so the pre-fix rename threw at fetch time and left the bucket untouched.
// copySource() (move-key.js) percent-encodes each segment; the mock URL-decodes it back.
// Asserts BOTH the mock bucket state (key renamed, old key gone) and the DOM (new row).
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { scaleTimeout,
  startMock,
  startAppServer,
  connectApp,
  BUCKET,
  launchBrowser,
  newE2EContext,
  newE2EPage,
  e2eTest,
} from '../harness.mjs';

let ctx, app, browser, context, page;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  context = await newE2EContext(browser);
  page = await newE2EPage(context);
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

async function keys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}

describe('browser e2e — file rename', () => {
  e2eTest('renames a file whose key has a char above U+00FF (BUG-062)', async () => {
    const oldKey = 'Anwar ｜ track.opus';
    const newKey = 'Anwar track.opus';
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: oldKey, Body: 'x' }));

    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.browserEndpoint);

    // Open rename on the file row (its Rename button), fill the new name, commit.
    await page.locator(`[data-testid="file-row:${oldKey}"] button[title="Rename"]`).click();
    await page.locator('.rename-input').fill(newKey);
    await page.locator('.rename-inline button', { hasText: '✓' }).click();

    // Poll the real bucket until the rename has fully applied (copy + delete).
    const deadline = Date.now() + scaleTimeout(15000);
    let k = await keys();
    while (JSON.stringify(k) !== JSON.stringify([newKey]) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      k = await keys();
    }
    assert.deepEqual(k, [newKey], 'the bucket has the renamed key and the old high-codepoint key is gone');
    // DOM: the old row is gone, the new one is present.
    assert.equal(await page.locator(`[data-testid="file-row:${oldKey}"]`).count(), 0);
    assert.equal(await page.locator(`[data-testid="file-row:${newKey}"]`).count(), 1);
  });
});
