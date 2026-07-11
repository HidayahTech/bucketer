// Browser e2e: drive the BUILT app (dist/index.html) through Playwright against the stateful
// mock S3 server, exercising the full stack — credential connect, SigV4 + CORS over the wire,
// upload, listing, and delete — and asserting BOTH the DOM and the actual mock bucket state.
// node --test + the `playwright` library (no @playwright/test framework). Requires a prior build.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext } from '../harness.mjs';

let ctx, app, browser, context, page;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  context = await newE2EContext(browser);
  page = await context.newPage();
  page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

async function bucketKeys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}
// Poll bucket state until it matches (avoids racing the async S3 op behind a UI action).
async function waitForKeys(expected, timeout = 10000) {
  const want = JSON.stringify(expected);
  const deadline = Date.now() + timeout;
  let keys = await bucketKeys();
  while (JSON.stringify(keys) !== want && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 150)); keys = await bucketKeys(); }
  assert.deepEqual(keys, expected);
}

describe('browser e2e — connect, upload, list, delete', () => {
  test('connects to the mock through the real credential flow (CORS + SigV4)', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.browserEndpoint);
    // Reaching the connected UI means the ListObjectsV2 probe succeeded over CORS.
    assert.ok(await page.locator('[data-testid="file-input"]').count() > 0, 'connected UI is shown');
  });

  test('uploading a file stores it in the bucket and shows it in the listing', async () => {
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'e2e-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from e2e'),
    });
    await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });

    // Real bucket state: the object actually landed.
    await waitForKeys(['e2e-upload.txt']);
    // DOM: the file appears in the browser listing (auto-refresh after upload drain).
    await page.getByText('e2e-upload.txt').first().waitFor({ timeout: 10000 });
  });

  test('deleting the file removes it from the bucket and the listing', async () => {
    const row = page.locator('tr.file-row', { hasText: 'e2e-upload.txt' });
    await row.locator('button[title="Delete"]').click({ force: true });
    // DeleteConfirmModal → confirm, then wait for the modal to close (confirm fired).
    const modal = page.locator('.modal-overlay');
    await modal.waitFor({ timeout: 5000 });
    await page.locator('[data-testid="delete-confirm"]').click();
    await modal.waitFor({ state: 'detached', timeout: 5000 });

    // DOM: the row is removed (auto-retries until the optimistic re-render flushes).
    await page.locator('tr.file-row', { hasText: 'e2e-upload.txt' }).waitFor({ state: 'detached', timeout: 10000 });
    // Real bucket state: poll until the delete lands server-side.
    await waitForKeys([]);
  });
});
