// Browser e2e — the versioning journey: on a versioned bucket, deleting a file creates a delete
// marker (the object is hidden but retained), the Hidden Versions panel surfaces it, and removing
// the marker via the panel undeletes the file. Asserts real ListObjectVersions / ListObjectsV2 state.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function liveKeys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}
async function markerCount() {
  const r = await ctx.client.send(new ListObjectVersionsCommand({ Bucket: BUCKET }));
  return (r.DeleteMarkers || []).length;
}

describe('versioning — delete marker then undelete', () => {
  e2eTest('deleting hides the file via a marker; undeleting from Hidden Versions brings it back', async () => {
    ctx.mock.reset();
    ctx.mock.configure({ bucket: BUCKET, versioning: true });
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Upload, then delete via the row → a versioned delete creates a delete marker.
      await page.locator('[data-testid="file-input"]').setInputFiles({ name: 'v.txt', mimeType: 'text/plain', buffer: Buffer.from('keepme') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:v.txt"]').waitFor({ timeout: 10000 });

      await page.locator('[data-testid="file-row:v.txt"]').locator('button[title="Delete"]').click({ force: true });
      await page.locator('[data-testid="delete-confirm"]').click();
      await page.locator('[data-testid="file-row:v.txt"]').waitFor({ state: 'detached', timeout: 10000 });

      // Server state: object hidden by a marker, but the version is retained.
      let deadline = Date.now() + 10000;
      while ((await liveKeys()).includes('v.txt') && Date.now() < deadline) await page.waitForTimeout(150);
      assert.ok(!(await liveKeys()).includes('v.txt'), 'a versioned delete hides the file');
      assert.equal(await markerCount(), 1, 'a delete marker exists');

      // Open the Hidden Versions panel and undelete (remove the delete marker).
      await page.locator('button:has-text("Show hidden versions")').click();
      const undeleteBtn = page.locator('.hidden-versions button[title*="Undelete"]');
      await undeleteBtn.first().waitFor({ timeout: 10000 });
      await undeleteBtn.first().click();
      // Confirm dialog → the action button reads "Undelete".
      await page.locator('.hidden-versions button:has-text("Undelete")').last().click();

      // Server state: the marker is gone and the file is current (visible) again.
      deadline = Date.now() + 10000;
      while (!(await liveKeys()).includes('v.txt') && Date.now() < deadline) await page.waitForTimeout(150);
      assert.ok((await liveKeys()).includes('v.txt'), 'removing the delete marker undeletes the file');
      assert.equal(await markerCount(), 0, 'the delete marker was removed');
    } finally { await context.close(); }
  });
});
