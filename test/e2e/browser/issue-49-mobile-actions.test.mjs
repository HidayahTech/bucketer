// GitLab issue #49 — mobile file-table actions reflow. On a phone viewport the per-row action
// buttons ran past the right edge, so a mobile user could not reach them (batch actions worked,
// per slice 1 / BUG-039). The fix hides the two date columns at ≤640px and lets the action
// buttons wrap inside their cell.
//
// These tests emulate a Pixel 5 and deliberately click WITHOUT { force: true }: force bypasses
// Playwright's actionability checks, which is exactly how the pre-fix matrix stayed green while
// the buttons were off-screen. A plain click proves the button is genuinely hit-testable.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EPage, e2eTest, applyEngineQuirks, e2eEngineName } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function newMobilePage() {
  const context = await browser.newContext(applyEngineQuirks(e2eEngineName(), devices['Pixel 5']));
  const page = await newE2EPage(context);
  return { context, page };
}

// Every button inside the locator must sit fully inside the visual viewport.
async function assertButtonsInViewport(page, rowLocator, label) {
  const vw = await page.evaluate(() => window.innerWidth);
  const buttons = await rowLocator.locator('.col-actions button').all();
  assert.ok(buttons.length > 0, `${label}: action buttons must exist`);
  for (const btn of buttons) {
    const box = await btn.boundingBox();
    assert.ok(box, `${label}: action button must be visible (have a bounding box)`);
    assert.ok(box.x >= 0 && box.x + box.width <= vw + 1,
      `${label}: button at x=${box.x} w=${box.width} must fit inside viewport width ${vw}`);
  }
}

describe('issue #49 — mobile (Pixel-5-emulated): per-row actions are reachable', () => {
  e2eTest('no horizontal overflow, and file + folder action buttons sit inside the viewport', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'reflow.txt', Body: 'x' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/inner.txt', Body: 'y' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      await page.locator('[data-testid="file-row:reflow.txt"]').waitFor({ timeout: 10000 });

      // The page itself must not scroll sideways (the pre-fix symptom).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `page must not overflow horizontally (scrollWidth exceeds viewport by ${overflow}px)`);

      await assertButtonsInViewport(page, page.locator('[data-testid="file-row:reflow.txt"]'), 'file row');
      await assertButtonsInViewport(page, page.locator('[data-testid="folder-row:docs"]'), 'folder row');
    } finally { await context.close(); }
  });

  e2eTest('per-row delete works end-to-end on mobile (no force-click)', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'doomed.txt', Body: 'z' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:doomed.txt"]');
      await row.waitFor({ timeout: 10000 });

      await row.locator('button[title="Delete"]').click(); // actionability-checked: must be reachable
      const modal = page.locator('.modal-overlay');
      await modal.waitFor({ timeout: 5000 });
      await page.locator('[data-testid="delete-confirm"]').click();
      await modal.waitFor({ state: 'detached', timeout: 5000 });

      await row.waitFor({ state: 'detached', timeout: 10000 });
      const deadline = Date.now() + 10000;
      let keys;
      do {
        const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
        keys = (r.Contents || []).map(o => o.Key);
        if (keys.length === 0) break;
        await new Promise(r2 => setTimeout(r2, 150));
      } while (Date.now() < deadline);
      assert.deepEqual(keys, [], 'the object is deleted from the bucket');
    } finally { await context.close(); }
  });

  e2eTest('copy-link popover opens fully inside the mobile viewport', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'linked.txt', Body: 'l' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:linked.txt"]');
      await row.waitFor({ timeout: 10000 });

      await row.locator('button[title="Copy link"]').click();
      const popover = page.locator('.copy-link-popover');
      await popover.waitFor({ timeout: 5000 });
      const vw = await page.evaluate(() => window.innerWidth);
      const box = await popover.boundingBox();
      assert.ok(box, 'popover must be visible');
      assert.ok(box.x >= 0 && box.x + box.width <= vw + 1,
        `popover (x=${box.x}, w=${box.width}) must fit inside viewport width ${vw}`);
    } finally { await context.close(); }
  });
});
