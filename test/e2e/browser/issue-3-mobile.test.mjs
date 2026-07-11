// GitLab issue #3 — "On mobile (Android), you are still redirected to the root directory after
// uploading." The desktop BUG-029 fix (App.onUploadsComplete delegates to onUploadsDrained instead
// of remounting Browser) is intact. This test emulates an Android device (viewport + touch + UA) and
// confirms the desktop fix HOLDS under mobile emulation: uploading via the file input while viewing a
// nested folder leaves the user in that folder.
//
// IMPORTANT (documented limitation): Playwright emulation reproduces viewport/touch/UA but NOT
// Android's *native* file-picker focus / popstate / bfcache behavior, which is the leading suspect
// for the reporter's residual mobile teleport. So a PASS here does not disprove the report — it
// proves no regression in the emulable layer and pins the boundary to native mobile behavior, which
// the issue comment asks the reporter to characterize (exact browser, repro steps).
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest, applyEngineQuirks, e2eEngineName } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

describe('issue #3 — mobile (Android-emulated): upload does not teleport to root', () => {
  e2eTest('uploading into a nested folder on an emulated Android device keeps the user in that folder', async () => {
    ctx.mock.reset();
    // Pixel 5 = Android viewport + touch + mobile Chrome UA.
    const context = await browser.newContext(applyEngineQuirks(e2eEngineName(), devices['Pixel 5']));
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Navigate into a nested folder.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: 5000 }); await ni.fill('mob'); await ni.press('Enter');
      await page.locator('[data-testid="folder-row:mob"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'mob' }).waitFor({ timeout: 5000 });
      // Let the upload target propagate to the folder.
      const dest = page.locator('input[placeholder="(root of bucket)"]');
      for (let i = 0; i < 50 && (await dest.inputValue().catch(() => '')) !== 'mob/'; i++) await page.waitForTimeout(100);

      // Upload via the file input (the path mobile uses — "Choose files" / share-sheet).
      await page.locator('[data-testid="file-input"]').setInputFiles({ name: 'phone.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('img') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });

      // The object landed in the folder…
      const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      assert.ok((r.Contents || []).some(o => o.Key === 'mob/phone.jpg'), 'upload targets the nested folder');
      // …and the user is STILL in the folder — not teleported to root (the desktop BUG-029 fix holds).
      assert.equal(await page.locator('.breadcrumb .current', { hasText: 'mob' }).count(), 1, 'still in mob/ after upload');
      assert.match(await page.evaluate(() => location.hash), /mob/, 'URL hash still reflects the folder');
    } finally { await context.close(); }
  });
});
