// Browser e2e — resumable moves. A move interrupted by a page reload must survive: it
// reappears in the operations queue as a paused row with Resume, and resuming finishes it.
// Real observable: the bucket ends with the objects under the destination and the sources
// gone, after a genuine page.reload() drops the in-memory move mid-flight.
//
// Part-level resume of a single >5 GiB multipart copy cannot be exercised here (an e2e can't
// create a 5 GiB object); it is covered at the unit level (move-multipart.test.js resume +
// move-resume.test.js). This spec proves the reload→resume flow at object granularity.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function bucketKeys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}
async function waitForKeys(expected, timeout = 12000) {
  const want = JSON.stringify(expected); const deadline = Date.now() + timeout;
  let keys = await bucketKeys();
  while (JSON.stringify(keys) !== want && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 150)); keys = await bucketKeys(); }
  assert.deepEqual(keys, expected);
}

describe('move — resume after reload', () => {
  e2eTest('an interrupted move reappears as a paused row and resuming finishes it', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Destination folder + two files.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: 5000 }); await ni.fill('dest'); await ni.press('Enter');
      await page.locator('[data-testid="folder-row:dest"]').waitFor({ timeout: 5000 });
      await page.locator('[data-testid="file-input"]').setInputFiles([
        { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('aaa') },
        { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('bbb') },
      ]);
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });

      // Interrupt deterministically: fail the source deletes so the move copies each object to
      // the destination but never completes cleanly — the resumable record persists.
      ctx.mock.configure({ faults: [{ op: 'DeleteObject', method: 'DELETE', status: 403, code: 'AccessDenied', message: 'denied' }] });

      await page.locator('[data-testid="file-row:a.txt"]').locator('td.col-check input[type="checkbox"]').check({ force: true });
      await page.locator('[data-testid="file-row:b.txt"]').locator('td.col-check input[type="checkbox"]').check({ force: true });
      await page.locator('.batch-bar button', { hasText: /^Move / }).click();
      await page.locator('.move-picker-folder', { hasText: 'dest' }).click();
      await page.locator('.move-here').click();

      // Copies land at the destination even though the source deletes are failing.
      await waitForKeys(['a.txt', 'b.txt', 'dest/', 'dest/a.txt', 'dest/b.txt']);

      // Reload: the in-memory move is gone, but the persisted job survives in IndexedDB.
      // Clear localStorage first (the saved connection) so the reloaded page boots to a clean
      // connect form — the resumable job lives in IndexedDB, which localStorage.clear leaves
      // untouched, so this does not affect what we are testing.
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      ctx.mock.configure({ faults: [] }); // let the resumed deletes succeed
      await connectApp(page, ctx.browserEndpoint);

      // The interrupted move surfaces as a paused row offering Resume.
      const resume = page.locator('[data-testid="move-resume"]');
      await resume.waitFor({ timeout: 10000 });
      await resume.click();

      // Resume finishes the move: the sources are gone, only the destination copies remain.
      await waitForKeys(['dest/', 'dest/a.txt', 'dest/b.txt']);
    } finally { await context.close(); }
  });
});
