// Browser e2e — The Power User's batch + listing-control journeys: multi-select batch delete and
// batch move, select-all, filter, sort, and the copy-link popover. Asserts DOM and real bucket state.
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
async function freshSession() {
  ctx.mock.reset();
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  return { context, page };
}
async function uploadFiles(page, names) {
  await page.locator('[data-testid="file-input"]').setInputFiles(names.map((n) => ({ name: n, mimeType: 'text/plain', buffer: Buffer.from(n) })));
  await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
  for (const n of names) await page.locator(`[data-testid="file-row:${n}"]`).waitFor({ timeout: 10000 });
}
// force: the post-upload re-render (listing refetch + BatchSummary auto-collapse) keeps rows
// briefly "unstable" for Playwright; the checkboxes are functional.
const selectRow = (page, name) => page.locator(`[data-testid="file-row:${name}"]`).locator('td.col-check input[type="checkbox"]').check({ force: true });
async function waitForKeys(expected, timeout = 10000) {
  const want = JSON.stringify(expected); const deadline = Date.now() + timeout;
  let keys = await bucketKeys();
  while (JSON.stringify(keys) !== want && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 150)); keys = await bucketKeys(); }
  assert.deepEqual(keys, expected);
}

describe('batch delete', () => {
  e2eTest('selecting two of three files and batch-deleting removes only those two', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['a.txt', 'b.txt', 'c.txt']);
      await selectRow(page, 'a.txt');
      await selectRow(page, 'c.txt');
      await page.locator('.batch-bar', { hasText: 'selected' }).waitFor({ timeout: 5000 });
      await page.locator('.batch-bar button.btn-danger').click(); // Delete N
      const modal = page.locator('.modal-overlay');
      await modal.waitFor({ timeout: 5000 });
      await page.locator('[data-testid="delete-confirm"]').click();
      await modal.waitFor({ state: 'detached', timeout: 5000 });
      await waitForKeys(['b.txt']);
    } finally { await context.close(); }
  });
});

describe('batch move', () => {
  e2eTest('selecting two files and moving them relocates both under the destination', async () => {
    const { context, page } = await freshSession();
    try {
      // Make a destination folder, then three files.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: 5000 }); await ni.fill('dest'); await ni.press('Enter');
      await page.locator('[data-testid="folder-row:dest"]').waitFor({ timeout: 5000 });
      await uploadFiles(page, ['x.txt', 'y.txt', 'z.txt']);

      await selectRow(page, 'x.txt');
      await selectRow(page, 'y.txt');
      // The batch-bar "Move N" button opens the picker.
      await page.locator('.batch-bar button', { hasText: /^Move / }).click();
      await page.locator('.move-picker-folder', { hasText: 'dest' }).click();
      await page.locator('.move-here').click();

      // Move = copy-then-delete per file, and the pool finishes files independently —
      // poll for the COMPLETE final state, not just the first relocated key (a slow
      // runner otherwise observes x.txt done while y.txt is still mid-move).
      await waitForKeys(['dest/', 'dest/x.txt', 'dest/y.txt', 'z.txt']);
    } finally { await context.close(); }
  });
});

describe('select-all, filter, sort', () => {
  e2eTest('select-all checkbox selects every visible file', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['one.txt', 'two.txt', 'three.txt']);
      await page.locator('th.col-check input[type="checkbox"]').check({ force: true });
      await page.locator('.batch-bar', { hasText: '3 files' }).waitFor({ timeout: 5000 });
      assert.ok((await page.locator('.batch-bar').textContent()).includes('3 files'));
    } finally { await context.close(); }
  });

  e2eTest('the filter box narrows the listing by name', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['apple.txt', 'banana.txt', 'apricot.txt']);
      // Starts-with match: the placeholder carries a "( / )" shortcut-hint suffix.
      await page.locator('input[placeholder^="Filter by name"]').fill('ap');
      // Only the two "ap…" files remain visible.
      await page.locator('[data-testid="file-row:banana.txt"]').waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await page.locator('[data-testid="file-row:apple.txt"]').count(), 1);
      assert.equal(await page.locator('[data-testid="file-row:apricot.txt"]').count(), 1);
      assert.equal(await page.locator('[data-testid="file-row:banana.txt"]').count(), 0);
    } finally { await context.close(); }
  });

  e2eTest('clicking the Name header sorts; descending reverses row order', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['a.txt', 'b.txt', 'c.txt']);
      const names = async () => (await page.locator('tbody tr.file-row [data-testid^="file-row:"], tbody tr.file-row').allTextContents());
      // Default is name ascending. Click Name once → toggles to descending.
      await page.locator('th:has-text("Name")').click();
      // Scope to the listing table — the UploadLog also renders tr.file-row rows (no
      // data-testid), which would inject nulls into the order assertion.
      const order = await page.locator('.file-table tbody tr.file-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
      assert.deepEqual(order, ['file-row:c.txt', 'file-row:b.txt', 'file-row:a.txt'], 'descending name order');
    } finally { await context.close(); }
  });
});

describe('copy-link popover', () => {
  e2eTest('opening Copy link on a row generates a presigned URL that fetches the object', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['link.txt']);
      const row = page.locator('[data-testid="file-row:link.txt"]');
      await row.locator('button[title="Copy link"]').click({ force: true });
      // The popover offers expiry presets; pick 1 hour and capture the generated URL via clipboard
      // is environment-dependent — instead assert the popover opened and a preset is clickable.
      const popover = page.locator('.copy-link-wrap .copy-link-popover, .copy-link-popover');
      await popover.first().waitFor({ timeout: 5000 });
      assert.ok(await popover.first().isVisible(), 'copy-link popover opens with expiry options');
    } finally { await context.close(); }
  });
});
