// Browser e2e — BUG-009: a permission error during a multipart upload must abort the session and
// clear its resume record, so a denied upload never leaves an orphaned multipart session behind
// (which would accrue storage and, on re-add, falsely offer to "resume" an upload that can't succeed).
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

describe('BUG-009 — multipart permission failure aborts the session', () => {
  test('a 403 on UploadPart aborts the multipart upload (no orphaned session, nothing stored)', async () => {
    ctx.mock.reset();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // CreateMultipartUpload succeeds; UploadPart is denied → the app must Abort + clear the record.
      ctx.mock.configure({ faults: [{ op: 'UploadPart', method: 'PUT', status: 403, code: 'AccessDenied', message: 'no write' }] });

      // A 6 MiB file forces the multipart path (>= 5 MiB threshold).
      const big = Buffer.alloc(6 * 1024 * 1024, 7);
      await page.locator('[data-testid="file-input"]').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big });

      // Wait for the failure to surface (the item enters the error state with a Retry button).
      await page.locator('button:has-text("Retry")').first().waitFor({ timeout: 20000 });

      // The orphaned multipart session was aborted — the mock holds no in-flight uploads.
      const deadline = Date.now() + 10000;
      const uploadsLeft = () => ctx.mock.buckets.get(BUCKET)?.uploads.size ?? 0;
      while (uploadsLeft() > 0 && Date.now() < deadline) await page.waitForTimeout(150);
      assert.equal(uploadsLeft(), 0, 'the multipart session was aborted (no orphan)');

      // Nothing was stored.
      const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      assert.equal((r.Contents || []).length, 0, 'a denied multipart upload stores no object');

      ctx.mock.configure({ faults: [] });
    } finally { await context.close(); }
  });
});
