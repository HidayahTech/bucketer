// Browser e2e: rename a FILE through the real UI against the mock S3. The key carries
// U+FF5C ("｜", as yt-dlp emits), which is the whole point (BUG-062): a raw
// `${bucket}/${key}` CopySource header is a Latin-1 ByteString the browser rejects for any
// char > U+00FF, so the pre-fix rename threw at fetch time and left the bucket untouched.
// copySource() (move-key.js) percent-encodes each segment; the mock URL-decodes it back.
// Asserts BOTH the mock bucket state (key renamed, old key gone) and the DOM (new row).
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  scaleTimeout,
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

  // GitLab #73 (R03): the collision guard only checked LOADED rows, so renaming onto a key
  // that sits on an unloaded listing page copied over it and deleted the source. Observable:
  // both objects' bytes after the attempt, plus the refusal shown to the user.
  e2eTest('renaming onto an existing key that is not on the loaded page is refused; both files survive', async () => {
    ctx.mock.reset();
    const put = (Key, Body) => ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));
    await put('a.txt', 'A: the file being renamed');
    await put('b.txt', 'B');
    await put('z.txt', 'IMPORTANT existing file on page 2');
    const ctx2 = await newE2EContext(browser);
    const p = await newE2EPage(ctx2);
    try {
      await p.addInitScript(() => localStorage.setItem('s3b_max_keys', '2'));
      await p.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(p, ctx.browserEndpoint);
      await p.locator('[data-testid="file-row:b.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(await p.locator('[data-testid="file-row:z.txt"]').count(), 0, 'z.txt must be on an unloaded page');

      await p.locator('[data-testid="file-row:a.txt"] button[title="Rename"]').click();
      await p.locator('.rename-input').fill('z.txt');
      await p.locator('.rename-inline button', { hasText: '✓' }).click();
      const body = async (Key) => {
        const r = await ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key })).catch(() => null);
        return r ? r.Body.transformToString() : null;
      };
      // Settle on either outcome: the refusal, or the (pre-fix) rename removing a.txt.
      const deadline = Date.now() + scaleTimeout(10000);
      while (
        (await p.locator('.rename-error').count()) === 0 &&
        (await body('a.txt')) !== null &&
        Date.now() < deadline
      )
        await p.waitForTimeout(150);
      assert.equal(await body('z.txt'), 'IMPORTANT existing file on page 2', 'the existing z.txt is not overwritten');
      assert.equal(await body('a.txt'), 'A: the file being renamed', 'the source is not deleted');
      assert.equal(await p.locator('.rename-error').count(), 1, 'the refusal is shown');
    } finally {
      await ctx2.close();
    }
  });
});
