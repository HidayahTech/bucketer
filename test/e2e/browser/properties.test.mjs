// Browser e2e — the properties modal's full metadata matrix. Proves the cross-origin HeadObject
// round-trip surfaces Content-Type, Size, ETag, the original File Modified time, and the custom
// content-hash stamp — all of which depend on the correct CORS ExposeHeaders (the BUG-028 surface).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMock, startAppServer, connectApp } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

describe('properties modal — full metadata matrix', () => {
  test('shows Content-Type, Size, ETag, File Modified, and the bucketer content-hash', async () => {
    ctx.mock.reset();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      // A file large enough that the app computes + stamps a content hash (the head/tail sampler
      // runs for any size; the stamp is always written).
      await page.locator('[data-testid="file-input"]').setInputFiles({ name: 'props.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('property-matrix-bytes') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:props.bin"]').waitFor({ timeout: 10000 });

      await page.locator('[data-testid="file-row:props.bin"]').locator('button[title="Properties"]').click({ force: true });
      await page.locator('[data-testid="properties-modal"]').waitFor({ timeout: 5000 });
      // Wait for the async HeadObject to populate the metadata table (the modal opens on "Loading…").
      await page.locator('[data-testid="meta-file-modified"]').waitFor({ timeout: 5000 });
      const body = await page.locator('.meta-dialog .modal-body').textContent();

      assert.match(body, /Content-Type/, 'Content-Type row present');
      assert.match(body, /Size/, 'Size row present');
      assert.match(body, /ETag/, 'ETag row present');
      // File Modified (x-amz-meta-file-mtime) — visible because default CORS exposes x-amz-meta-*.
      assert.equal(await page.locator('[data-testid="meta-file-modified"]').count(), 1, 'File Modified row present');
      // The content-hash stamp is shown as a custom x-amz-meta row.
      assert.match(body, /bucketer-content-hash/, 'content-hash stamp surfaced as custom metadata');
    } finally { await context.close(); }
  });
});
