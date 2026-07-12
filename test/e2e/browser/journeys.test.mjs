// Browser e2e — The Power User's journeys: realistic multi-step sessions through the built UI,
// asserting BOTH the DOM and the real mock bucket state. Each test connects fresh against a reset
// bucket. node --test + the playwright library (no @playwright/test framework).
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
// Poll for the COMPLETE final bucket state. Move = copy-then-delete (per file, pool of
// workers) — waiting for a single relocated key and then asserting the rest races a slow
// runner that observes the copy before the delete (or a sibling file mid-move).
async function waitForKeys(expected, timeout = 10000) {
  const want = JSON.stringify(expected); const deadline = Date.now() + timeout;
  let keys = await bucketKeys();
  while (JSON.stringify(keys) !== want && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 150)); keys = await bucketKeys(); }
  assert.deepEqual(keys, expected);
}
async function freshSession() {
  ctx.mock.reset();
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  return { context, page };
}
function fileInput(page) { return page.locator('[data-testid="file-input"]'); }
// The upload target prefix propagates Browser→App→UploadQueue across a few async renders; wait for
// the Destination folder input to reflect it before uploading, so the object lands in the folder.
async function waitForUploadTarget(page, prefix) {
  const input = page.locator('input[placeholder="(root of bucket)"]');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if ((await input.inputValue().catch(() => '')) === prefix) return; await page.waitForTimeout(100); }
  throw new Error(`upload target never became ${prefix}`);
}

// ── B3 — batch upload lands all files and refreshes the listing once (BUG-010/011) ──
describe('B3 — batch upload', () => {
  e2eTest('three files upload, all land in the bucket and appear in the listing', async () => {
    const { context, page } = await freshSession();
    try {
      await fileInput(page).setInputFiles([
        { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
        { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
        { name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('c') },
      ]);
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      assert.deepEqual(await bucketKeys(), ['a.txt', 'b.txt', 'c.txt']);
      for (const n of ['a.txt', 'b.txt', 'c.txt']) await page.locator(`[data-testid="file-row:${n}"]`).waitFor({ timeout: 10000 });
    } finally { await context.close(); }
  });
});

// ── B4 — new folder → upload into it → stay in the folder (BUG-029) ──────────────
describe('B4 — folder journey + stay-put', () => {
  e2eTest('upload into a subfolder keeps the user in that folder (no teleport to root)', async () => {
    const { context, page } = await freshSession();
    try {
      // Create folder via the New folder dialog.
      await page.locator('button[title="Create a new folder"]').click();
      const nameInput = page.locator('.modal-overlay input.form-input');
      await nameInput.waitFor({ timeout: 5000 });
      await nameInput.fill('docs');
      await nameInput.press('Enter');
      // Navigate into it.
      await page.locator('[data-testid="folder-row:docs"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'docs' }).waitFor({ timeout: 5000 });
      // Upload into the folder (wait for the target prefix to propagate to the upload queue first).
      await waitForUploadTarget(page, 'docs/');
      await fileInput(page).setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      // Object landed under the prefix.
      assert.ok((await bucketKeys()).includes('docs/note.txt'));
      // STILL in the folder — breadcrumb shows docs, URL hash retains the prefix (BUG-029).
      await page.locator('[data-testid="file-row:note.txt"]').waitFor({ timeout: 10000 });
      assert.ok(await page.locator('.breadcrumb .current', { hasText: 'docs' }).count() >= 1, 'still in docs/ after upload');
      assert.match(await page.evaluate(() => location.hash), /docs/, 'URL hash retains the prefix');
    } finally { await context.close(); }
  });
});

// ── B6 — move via the picker, and one drag-and-drop move ─────────────────────────
describe('B6 — move (picker + drag-and-drop)', () => {
  e2eTest('moving a file into a folder via the picker relocates it', async () => {
    const { context, page } = await freshSession();
    try {
      // Seed a folder and a file at root.
      await page.locator('button[title="Create a new folder"]').click();
      const nameInput = page.locator('.modal-overlay input.form-input');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('dest'); await nameInput.press('Enter');
      await page.locator('[data-testid="folder-row:dest"]').waitFor({ timeout: 5000 });
      await fileInput(page).setInputFiles({ name: 'm.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:m.txt"]').waitFor({ timeout: 10000 });

      // Open the move picker from the file row, drill into dest/, Move here.
      await page.locator('[data-testid="file-row:m.txt"]').locator('button[title="Move to another folder"]').click({ force: true });
      await page.locator('.move-picker-folder', { hasText: 'dest' }).click();
      await page.locator('.move-here').click();

      // Relocated in the bucket (alongside the dest/ folder-marker) and out of the root listing.
      await waitForKeys(['dest/', 'dest/m.txt']);
    } finally { await context.close(); }
  });

  e2eTest('drag-and-drop a file row onto a folder row moves it (one HTML5 DnD path)', async () => {
    const { context, page } = await freshSession();
    try {
      await page.locator('button[title="Create a new folder"]').click();
      const nameInput = page.locator('.modal-overlay input.form-input');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('box'); await nameInput.press('Enter');
      await page.locator('[data-testid="folder-row:box"]').waitFor({ timeout: 5000 });
      await fileInput(page).setInputFiles({ name: 'drag.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:drag.txt"]').waitFor({ timeout: 10000 });

      // HTML5 DnD: dispatch dragstart on the source row, dragover + drop on the folder row, sharing a
      // DataTransfer. (Playwright's mouse-based dragTo doesn't drive native draggable handlers reliably.)
      await page.evaluate(() => {
        const src = document.querySelector('[data-testid="file-row:drag.txt"]');
        const tgt = document.querySelector('[data-testid="folder-row:box"]');
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      });

      await waitForKeys(['box/', 'box/drag.txt']);
    } finally { await context.close(); }
  });
});

// ── B7 — presigned download fetches the bytes through the mock (Auditor) ──────────
// Asserted at the NETWORK level (the presigned GET and its response), not via Playwright's
// "download" event: whether the browser chrome converts the <a download> navigation into a
// download is engine- and state-dependent (WebKit ignores the cross-origin download
// attribute and, right after an upload, navigates instead of converting the
// Content-Disposition: attachment response — no event fires). The app's contract is the
// correctly signed GET with an attachment disposition returning the stored bytes; that is
// identical on all engines.
describe('B7 — presigned download', () => {
  e2eTest('clicking Download fetches the presigned URL and returns the file bytes', async () => {
    const { context, page } = await freshSession();
    try {
      await fileInput(page).setInputFiles({ name: 'dl.txt', mimeType: 'text/plain', buffer: Buffer.from('download-me') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      const row = page.locator('[data-testid="file-row:dl.txt"]');
      await row.waitFor({ timeout: 10000 });
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('X-Amz-Signature') && r.url().includes('dl.txt'), { timeout: 10000 }),
        row.locator('button[title="Download"]').click(),
      ]);
      assert.equal(response.status(), 200, 'the presigned GET is accepted (SigV4 verified by the mock)');
      assert.match(response.headers()['content-disposition'] || '', /attachment/, 'response carries the attachment disposition');
      // response.body() is unreadable when the engine converts the response into a download
      // (chromium/firefox), so verify the bytes by re-fetching the same presigned URL —
      // reusable until expiry. Constraints: the fetch must run IN A PAGE (browsers resolve
      // the virtual-hosted *.localhost endpoint themselves; node-side page.request uses the
      // OS resolver, which lacks *.localhost on CI runners → ENOTFOUND), and in a page that
      // will not navigate (WebKit navigates the clicked page to the presigned URL,
      // destroying its execution context). A fresh page on the app origin satisfies both;
      // the mock serves CORS headers.
      const fetcher = await context.newPage();
      await fetcher.goto(app.url, { waitUntil: 'domcontentloaded' });
      const refetch = await fetcher.evaluate(async (u) => {
        const r = await fetch(u);
        return { status: r.status, text: await r.text() };
      }, response.url());
      await fetcher.close();
      assert.equal(refetch.status, 200);
      assert.equal(refetch.text, 'download-me', 'the presigned URL returns the stored bytes');
    } finally { await context.close(); }
  });
});

// ── B8 — a denied write flips capability state and surfaces an error (Auditor) ────
describe('B8 — capability denied', () => {
  e2eTest('a 403 on PutObject surfaces an error and marks upload denied', async () => {
    const { context, page } = await freshSession();
    try {
      ctx.mock.configure({ faults: [{ op: 'PutObject', method: 'PUT', status: 403, code: 'AccessDenied', message: 'no write' }] });
      await fileInput(page).setInputFiles({ name: 'denied.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      // The upload fails; the object never lands.
      await page.waitForTimeout(2000);
      assert.deepEqual(await bucketKeys(), [], 'a denied upload stores nothing');
      // The capability panel reflects the denial (upload no longer permitted).
      const denied = await page.locator('text=/denied/i').count();
      assert.ok(denied >= 1 || (await page.locator('.cap-denied').count()) >= 1, 'upload denial is surfaced in the UI');
      ctx.mock.configure({ faults: [] });
    } finally { await context.close(); }
  });
});
