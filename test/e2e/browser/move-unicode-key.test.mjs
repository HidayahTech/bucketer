// Browser e2e — BUG-060: moving an object whose key contains a non-Latin-1 character
// (e.g. yt-dlp's U+FF5C "｜", value 65372) must succeed. A move is a server-side copy, whose
// x-amz-copy-source header is a ByteString (Latin-1, <=255); a raw >255 character makes the
// real browser's Headers constructor throw before the request is even sent, so the object
// silently never relocates. This can only be observed in a real browser — the unit-level
// mock records the command before header serialization. Observable: the real bucket ends
// with the object under the destination and the source key gone.
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

describe('move — non-Latin-1 key (BUG-060)', () => {
  // "｜" (U+FF5C, 65372) is the exact character from the field report; "ö" (a Latin-1-range
  // byte) and "日" (a CJK code point) are added so the encoding is exercised across the range.
  const NAME = 'Anwar ｜ Wörk 日 [x].opus';

  e2eTest('a file whose name has weird characters can be moved into a folder', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Destination folder.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: 5000 }); await ni.fill('dest'); await ni.press('Enter');
      await page.locator('[data-testid="folder-row:dest"]').waitFor({ timeout: 5000 });

      // Seed the weird-named object via upload — upload puts the name in the URL path, which
      // the SDK encodes, so it succeeds where the copy-source *header* previously did not.
      await page.locator('[data-testid="file-input"]').setInputFiles([{ name: NAME, mimeType: 'audio/ogg', buffer: Buffer.from('opus-bytes') }]);
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator(`[data-testid="file-row:${NAME}"]`).waitFor({ timeout: 10000 });
      await waitForKeys([NAME, 'dest/'].sort());

      // Move it into dest: select the row, open the picker, drop it in.
      await page.locator(`[data-testid="file-row:${NAME}"]`).locator('td.col-check input[type="checkbox"]').check({ force: true });
      await page.locator('.batch-bar button', { hasText: /^Move / }).click();
      await page.locator('.move-picker-folder', { hasText: 'dest' }).click();
      await page.locator('.move-here').click();

      // The move must complete: the object is now under dest and the source key is gone.
      await waitForKeys([`dest/${NAME}`, 'dest/'].sort());
    } finally { await context.close(); }
  });
});
