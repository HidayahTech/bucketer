// Browser e2e — P2 interaction edges: the full drag-and-drop move matrix (beyond the single P0
// path) and BUG-004 (the folder picker must request directory mode). Real-browser only: HTML5 DnD
// and the webkitdirectory DOM property cannot be exercised under jsdom.
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
const fileInput = (page) => page.locator('[data-testid="file-input"]');
async function newFolder(page, name) {
  await page.locator('button[title="Create a new folder"]').click();
  const ni = page.locator('.modal-overlay input.form-input');
  await ni.waitFor({ timeout: 5000 }); await ni.fill(name); await ni.press('Enter');
  await page.locator(`[data-testid="folder-row:${name}"]`).waitFor({ timeout: 5000 });
}
async function waitForUploadTarget(page, prefix) {
  const input = page.locator('input[placeholder="(root of bucket)"]');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if ((await input.inputValue().catch(() => '')) === prefix) return; await page.waitForTimeout(100); }
  throw new Error(`upload target never became ${prefix}`);
}
// HTML5 drag: Playwright's mouse dragTo doesn't drive native draggable handlers; dispatch the
// drag events directly with a shared DataTransfer (the same approach as the P0 DnD test).
async function dragDrop(page, srcSel, tgtSel) {
  await page.evaluate(({ srcSel, tgtSel }) => {
    const src = document.querySelector(srcSel);
    const tgt = document.querySelector(tgtSel);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { srcSel, tgtSel });
}
async function waitUntil(pred, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await pred()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
}

describe('drag-and-drop matrix', () => {
  e2eTest('dragging a file onto the root breadcrumb crumb moves it up a level', async () => {
    const { context, page } = await freshSession();
    try {
      await newFolder(page, 'sub');
      await page.locator('[data-testid="folder-row:sub"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'sub' }).waitFor({ timeout: 5000 });
      await waitForUploadTarget(page, 'sub/');
      await fileInput(page).setInputFiles({ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="file-row:up.txt"]').waitFor({ timeout: 10000 });
      assert.ok((await bucketKeys()).includes('sub/up.txt'));

      // Drag the file onto the "root" crumb → it moves to the bucket root.
      await dragDrop(page, '[data-testid="file-row:up.txt"]', '.breadcrumb .crumb');
      await waitUntil(async () => (await bucketKeys()).includes('up.txt'));
      const keys = await bucketKeys();
      assert.ok(keys.includes('up.txt'), 'moved to root');
      assert.ok(!keys.includes('sub/up.txt'), 'no longer under sub/');
    } finally { await context.close(); }
  });

  e2eTest('dropping a folder onto itself is rejected — nothing moves', async () => {
    const { context, page } = await freshSession();
    try {
      await newFolder(page, 'box');
      // A folder-into-itself drop is structurally invalid (validateMove blocks it).
      await dragDrop(page, '[data-testid="folder-row:box"]', '[data-testid="folder-row:box"]');
      await page.waitForTimeout(500); // give any (erroneous) move a chance to start
      assert.deepEqual(await bucketKeys(), ['box/'], 'only the folder marker exists; no self-move occurred');
    } finally { await context.close(); }
  });

  e2eTest('dragging one of several selected files moves the whole selection', async () => {
    const { context, page } = await freshSession();
    try {
      await newFolder(page, 'dest');
      await fileInput(page).setInputFiles([
        { name: 'm1.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
        { name: 'm2.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
        { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('k') },
      ]);
      await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
      for (const n of ['m1.txt', 'm2.txt', 'keep.txt']) await page.locator(`[data-testid="file-row:${n}"]`).waitFor({ timeout: 10000 });

      // Select m1 and m2, then drag m1 onto dest/ — the whole selection should move.
      await page.locator('[data-testid="file-row:m1.txt"]').locator('input[type=checkbox]').check({ force: true });
      await page.locator('[data-testid="file-row:m2.txt"]').locator('input[type=checkbox]').check({ force: true });
      await page.locator('.batch-bar', { hasText: '2 files' }).waitFor({ timeout: 5000 });
      await dragDrop(page, '[data-testid="file-row:m1.txt"]', '[data-testid="folder-row:dest"]');

      await waitUntil(async () => (await bucketKeys()).includes('dest/m1.txt'));
      const keys = await bucketKeys();
      assert.ok(keys.includes('dest/m1.txt') && keys.includes('dest/m2.txt'), 'both selected files moved');
      assert.ok(keys.includes('keep.txt') && !keys.includes('m1.txt') && !keys.includes('m2.txt'), 'unselected file stays');
    } finally { await context.close(); }
  });
});

describe('BUG-004 — folder picker requests directory mode', () => {
  e2eTest('the folder-picker input has webkitdirectory=true; the file input does not', async () => {
    const { context, page } = await freshSession();
    try {
      // Two hidden file inputs: [0] = Choose files (multiple), [1] = Choose folder (webkitdirectory).
      const flags = await page.locator('input[type=file]').evaluateAll((els) => els.map((e) => !!e.webkitdirectory));
      assert.equal(flags.length, 2, 'both the file and folder inputs are present');
      assert.equal(flags[0], false, 'the Choose files input is not a directory picker');
      assert.equal(flags[1], true, 'the Choose folder input has webkitdirectory=true (BUG-004)');
    } finally { await context.close(); }
  });
});
