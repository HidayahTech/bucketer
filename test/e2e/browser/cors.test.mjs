// Browser e2e — The Protocol & Boundary Auditor's CORS regressions. These can ONLY be caught in
// a real browser: CORS is enforced by the browser, never by the Node SDK (which is why BUG-012 and
// BUG-028 shipped — they were "never tested in a real browser against a cross-origin bucket").
// Each test narrows the mock's CORS contract and proves the operation breaks, then restores it and
// proves the operation works — so the test has teeth, not a tautology.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function freshPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}
async function bucketKeys() {
  const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  return (r.Contents || []).map((o) => o.Key).sort();
}
async function uploadOne(page, name, content = 'data') {
  await page.locator('[data-testid="file-input"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: 20000 });
  await page.locator(`[data-testid="file-row:${name}"]`).waitFor({ timeout: 10000 });
}

// ── B1 — BUG-028: ExposeHeaders must include x-amz-meta-* or custom metadata is invisible ──
describe('B1 — BUG-028: custom metadata visibility depends on CORS ExposeHeaders', () => {
  async function openProps(page, name) {
    await page.locator(`[data-testid="file-row:${name}"]`).locator('button[title="Properties"]').click({ force: true });
    await page.locator('[data-testid="properties-modal"]').waitFor({ timeout: 5000 });
  }

  test('NEGATIVE — narrowed ExposeHeaders (no x-amz-meta-*) hides File Modified', async () => {
    ctx.mock.reset();
    ctx.mock.configure({ cors: { exposeHeaders: ['ETag', 'Content-Length', 'Content-Type'] } });
    const { context, page } = await freshPage();
    try {
      await connectApp(page, ctx.browserEndpoint);
      await uploadOne(page, 'meta.txt'); // the app stamps x-amz-meta-file-mtime automatically
      // The metadata IS stored server-side (proving the negative is a CORS-hiding effect, not absence).
      const head = await ctx.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'meta.txt' }));
      assert.ok(head.Metadata['file-mtime'], 'file-mtime is stored on the object server-side');
      // …but the browser cannot read it: no File Modified row.
      await openProps(page, 'meta.txt');
      assert.equal(await page.locator('[data-testid="meta-file-modified"]').count(), 0,
        'with x-amz-meta-* missing from ExposeHeaders, custom metadata must be invisible (BUG-028)');
    } finally { await context.close(); }
  });

  test('POSITIVE — correct ExposeHeaders reveals File Modified', async () => {
    ctx.mock.reset(); // default CORS exposes x-amz-meta-*
    const { context, page } = await freshPage();
    try {
      await connectApp(page, ctx.browserEndpoint);
      await uploadOne(page, 'meta.txt');
      await openProps(page, 'meta.txt');
      await page.locator('[data-testid="meta-file-modified"]').waitFor({ timeout: 5000 });
      assert.ok(await page.locator('[data-testid="meta-file-modified"]').count() >= 1,
        'with the correct ExposeHeaders, File Modified must be visible');
    } finally { await context.close(); }
  });
});

// ── B2 — BUG-012: an operation that issues HTTP DELETE (rename) breaks if DELETE not in CORS ──
describe('B2 — BUG-012: HTTP DELETE must be in CORS AllowedMethods', () => {
  test('rename (Copy+Delete) leaves the source when DELETE is absent; completes when present', async () => {
    // Negative: AllowedMethods without DELETE. Rename copies (PUT, allowed) then deletes the source
    // (HTTP DELETE, blocked by preflight) → the original survives.
    ctx.mock.reset();
    ctx.mock.configure({ cors: { allowedMethods: ['GET', 'PUT', 'HEAD', 'POST'] } });
    let { context, page } = await freshPage();
    try {
      await connectApp(page, ctx.browserEndpoint);
      await uploadOne(page, 'orig.txt');
      await renameRow(page, 'orig.txt', 'renamed.txt');
      // The DELETE was blocked, so the original is still present (the operation did not complete).
      assert.ok((await bucketKeys()).includes('orig.txt'), 'source must remain when DELETE is not allowed (BUG-012)');
    } finally { await context.close(); }

    // Positive: a fresh run with DELETE allowed → rename completes, the source is gone.
    ctx.mock.reset();
    ({ context, page } = await freshPage());
    try {
      await connectApp(page, ctx.browserEndpoint);
      await uploadOne(page, 'orig.txt');
      await renameRow(page, 'orig.txt', 'renamed.txt');
      await page.locator('[data-testid="file-row:renamed.txt"]').waitFor({ timeout: 10000 });
      const keys = await bucketKeys();
      assert.ok(!keys.includes('orig.txt') && keys.includes('renamed.txt'), 'with DELETE allowed the rename completes');
    } finally { await context.close(); }
  });
});

async function renameRow(page, name, newName) {
  const row = page.locator(`[data-testid="file-row:${name}"]`);
  await row.locator('button[title="Rename"]').click();
  const input = row.locator('input.rename-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill(newName);
  await input.press('Enter');
  // Let the copy+delete round-trip settle (success or blocked).
  await page.waitForTimeout(800);
}
