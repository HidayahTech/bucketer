// Browser e2e — the incomplete-uploads cleanup panel. Seed an orphaned incomplete multipart
// upload (Create, never Complete), then in the browser: open the panel, see it listed, Discard
// it, and confirm the server no longer lists it. Real observable: the mock's multipart-upload
// listing goes from one to none after Discard.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CreateMultipartUploadCommand, ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

describe('incomplete uploads — discover and discard', () => {
  e2eTest('an orphaned multipart upload is listed and Discard aborts it', async () => {
    ctx.mock.reset();
    // Seed an orphan: a multipart upload that was started and never completed.
    const create = await ctx.client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'orphan/big.bin' }));
    const uploadId = create.UploadId;

    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      await page.locator('[data-testid="open-incomplete-uploads"]').click();

      // The orphan is discovered and listed.
      const row = page.locator(`[data-testid="incomplete-row:${uploadId}"]`);
      await row.waitFor({ timeout: 10000 });
      assert.ok((await row.textContent()).includes('orphan/big.bin'));

      // Discard it: the row goes away and the server stops listing it.
      await page.locator(`[data-testid="discard:${uploadId}"]`).click();
      await row.waitFor({ state: 'detached', timeout: 10000 });

      const after = await ctx.client.send(new ListMultipartUploadsCommand({ Bucket: BUCKET }));
      assert.deepEqual(after.Uploads ?? [], [], 'the incomplete upload is gone server-side');
    } finally { await context.close(); }
  });
});
