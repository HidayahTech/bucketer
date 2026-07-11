// Browser e2e: rename a folder through the real UI against the mock S3, asserting BOTH
// the DOM (old row gone) and the mock bucket state (keys moved to the new prefix).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET } from '../harness.mjs';

let ctx, app, browser, context, page;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function keys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map(o => o.Key).sort();
}

describe('browser e2e — folder rename', () => {
  test('renames a folder: keys move to the new prefix, old prefix is gone', async () => {
    // Seed two objects under docs/.
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/a.txt', Body: 'a' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/sub/b.txt', Body: 'b' }));

    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.browserEndpoint);

    // Open rename on the docs/ folder row and commit a new name.
    await page.locator('[data-testid="folder-row:docs"] button', { hasText: '✎' }).click();
    await page.locator('.rename-input').fill('guides');
    await page.locator('.rename-inline button', { hasText: '✓' }).click();

    // Poll the real bucket until the rename has fully applied.
    const deadline = Date.now() + 15000;
    let k = await keys();
    while (JSON.stringify(k) !== JSON.stringify(['guides/a.txt', 'guides/sub/b.txt']) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200)); k = await keys();
    }
    assert.deepEqual(k, ['guides/a.txt', 'guides/sub/b.txt']);
    // DOM: the old folder row is gone.
    assert.equal(await page.locator('[data-testid="folder-row:docs"]').count(), 0);
  });
});
