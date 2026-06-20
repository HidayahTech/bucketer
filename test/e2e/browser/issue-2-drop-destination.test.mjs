// GitLab issue #2 — "Files/folders that are drag-and-dropped to nested folders/directories are
// uploaded to the root directory." Root cause (BUG-031): UploadQueue exposes addFiles via onMount
// with [] deps, so addFilesRef captures a stale closure over the mount-time destinationPrefix ('' =
// root); every drag-drop path goes through it and uploads to root regardless of the current folder.
//
// This test drives the table drop handler with a synthetic DataTransfer (the e.dataTransfer.files
// fallback path, which the real OS drag uses when FileSystemEntry isn't available) while viewing a
// nested folder, and asserts the object lands UNDER that folder — not at root.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function bucketKeys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}
// Dispatch a real file drop onto the Browser drop container, the way the OS does when
// FileSystemEntry isn't exposed (handleTableDrop falls back to e.dataTransfer.files).
async function dropFile(page, name, content = 'x') {
  await page.evaluate(({ name, content }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'text/plain' }));
    const el = document.querySelector('[data-testid="browser-drop"]');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name, content });
}

describe('issue #2 — drag-dropped uploads target the current folder, not root', () => {
  test('dropping a file while viewing a nested folder uploads it INTO that folder', async () => {
    ctx.mock.reset();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Create and enter a nested folder.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: 5000 }); await ni.fill('sub'); await ni.press('Enter');
      await page.locator('[data-testid="folder-row:sub"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'sub' }).waitFor({ timeout: 5000 });
      // Wait for the upload destination to reflect the folder (a real user takes far longer than this
      // to start a drag). The bug is the STALE CLOSURE: even fully settled, the captured addFiles read
      // the mount-time root prefix — waiting proves the fix, not the unrelated propagation lag.
      const dest = page.locator('input[placeholder="(root of bucket)"]');
      for (let i = 0; i < 50 && (await dest.inputValue().catch(() => '')) !== 'sub/'; i++) await page.waitForTimeout(100);

      // Drag-drop a file onto the browser (the path that used the stale closure).
      await dropFile(page, 'dropped.txt');

      // It must land under sub/, never at the bucket root.
      const deadline = Date.now() + 15000;
      let keys = await bucketKeys();
      while (!keys.includes('sub/dropped.txt') && !keys.includes('dropped.txt') && Date.now() < deadline) {
        await page.waitForTimeout(150); keys = await bucketKeys();
      }
      assert.ok(keys.includes('sub/dropped.txt'), `expected sub/dropped.txt, got ${JSON.stringify(keys)}`);
      assert.ok(!keys.includes('dropped.txt'), 'must NOT land at the bucket root (issue #2)');
    } finally { await context.close(); }
  });
});
