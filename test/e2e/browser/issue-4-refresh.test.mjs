// GitLab issue #4 — "I don't see it until I refresh."
//  Part 2 (BUG-032, same-client): uploading a folder INTO the current view created a sub-prefix that
//  onUploadsDrained never refetched (it matched the current prefix exactly, not descendants), so the
//  new folder stayed invisible until reload. Now the current view refetches when an upload lands in
//  it OR under it.
//  Part 1 (cross-client, by design — backendless): another device's upload isn't pushed; the Refresh
//  button pulls it on demand. This proves the Refresh control re-lists.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function freshSession() {
  ctx.mock.reset();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  return { context, page };
}
// Drop a file (with a folder-bearing relativePath) onto the Browser drop container.
async function dropFile(page, name, content = 'x') {
  await page.evaluate(({ name, content }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'text/plain' }));
    document.querySelector('[data-testid="browser-drop"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name, content });
}

describe('issue #4 part 2 — a sub-folder created by an upload appears without a manual refresh', () => {
  test('dropping a file that creates a sub-folder in the current view shows it immediately', async () => {
    const { context, page } = await freshSession();
    try {
      // At root, drop a file whose relativePath creates a new sub-folder "newdir".
      await dropFile(page, 'newdir/x.txt');
      // The new folder must appear in the listing WITHOUT a page reload (the drained prefix is
      // "newdir/", a descendant of the current view "").
      await page.locator('[data-testid="folder-row:newdir"]').waitFor({ timeout: 15000 });
      assert.equal(await page.locator('[data-testid="folder-row:newdir"]').count(), 1);
    } finally { await context.close(); }
  });
});

describe('issue #4 part 1 — the Refresh button pulls changes made by another client', () => {
  test('an object added out-of-band appears after clicking Refresh', async () => {
    const { context, page } = await freshSession();
    try {
      // Simulate "another device" writing directly to the bucket (no UI involved).
      await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'from-other-device.txt', Body: new TextEncoder().encode('x') }));
      // It isn't visible yet (no live sync)…
      assert.equal(await page.locator('[data-testid="file-row:from-other-device.txt"]').count(), 0);
      // …until the user clicks Refresh.
      await page.locator('[data-testid="refresh-listing"]').click();
      await page.locator('[data-testid="file-row:from-other-device.txt"]').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('[data-testid="file-row:from-other-device.txt"]').count(), 1);
    } finally { await context.close(); }
  });
});
