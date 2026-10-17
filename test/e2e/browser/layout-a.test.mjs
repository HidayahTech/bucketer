// Layout A, page structure (v1.67.0). One observable per piece:
//  - title: the page's h1 names the bucket and the folder in view;
//  - Upload ▾: "Files…" opens the browser's file chooser and the chosen file lands in the folder
//    in view (an object on the mock), with no always-open destination form on the page;
//  - Activity: with the panel at its real default (closed), the file list does not move when an
//    upload finishes (REPORT W1: it moved from y=326 to y=549), and the panel survives a Browser
//    remount (reconnect), attached under the toolbar again;
//  - Bucket tools ▾: its Incomplete uploads item opens that dialog.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  scaleTimeout,
  startMock,
  startAppServer,
  connectApp,
  BUCKET,
  launchBrowser,
  newE2EContext,
  newE2EPage,
  e2eTest,
} from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

async function connectedPage({ activityOpen = false } = {}) {
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context, { activityOpen });
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  await page.locator('[data-testid="folder-row:docs"]').waitFor({ timeout: scaleTimeout(15000) });
  return { context, page };
}

async function waitForObject(key) {
  const deadline = Date.now() + scaleTimeout(15000);
  while (Date.now() < deadline) {
    const r = await ctx.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => null);
    if (r) return r.Body.transformToString();
    await new Promise((res) => setTimeout(res, 150));
  }
  return null;
}

describe('layout A — page structure', () => {
  before(async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/readme.md', Body: 'r' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'notes.txt', Body: 'n' }));
  });

  e2eTest('the page title names the bucket, then the folder in view', async () => {
    const { context, page } = await connectedPage();
    try {
      const title = page.locator('h1.breadcrumb-title');
      assert.equal((await title.textContent()).trim(), BUCKET);
      await page.locator('[data-testid="folder-row:docs"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'docs' }).waitFor({ timeout: scaleTimeout(10000) });
      assert.equal((await title.textContent()).replace(/\s+/g, ''), `${BUCKET}/docs`);
      assert.equal(await page.locator('input[placeholder="(root of bucket)"]').count(), 0, 'no destination form');
    } finally {
      await context.close();
    }
  });

  e2eTest('Upload ▾ → Files… opens the file chooser; the file lands in the folder in view', async () => {
    const { context, page } = await connectedPage();
    try {
      await page.locator('[data-testid="folder-row:docs"]').click();
      await page.locator('.upload-target[data-upload-target="docs/"]').waitFor({ timeout: scaleTimeout(10000) });
      await page.locator('.upload-menu-btn').click();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: scaleTimeout(10000) }),
        page.locator('.upload-menu button', { hasText: 'Upload files…' }).click(),
      ]);
      await chooser.setFiles({ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked bytes') });
      assert.equal(await waitForObject('docs/picked.txt'), 'picked bytes', 'the chosen file is in docs/ on the mock');
    } finally {
      await context.close();
    }
  });

  e2eTest('with Activity at its default (closed), the file list does not move when an upload finishes', async () => {
    const { context, page } = await connectedPage();
    try {
      // Document y, not viewport y: on a short page scrolled to the bottom (iPhone 13), the new row
      // makes the browser's scroll anchoring scroll the window by a row height, which moves the
      // table in the viewport without anything pushing it down the page.
      const table = page.locator('.file-table').first();
      const docY = () => table.evaluate((t) => t.getBoundingClientRect().y + window.scrollY);
      const before = await docY();
      assert.equal(await page.locator('details.activity').evaluate((d) => d.open), false, 'closed by default');
      await page
        .locator('input[data-testid="file-input"]')
        .setInputFiles({ name: 'w1.txt', mimeType: 'text/plain', buffer: Buffer.from('w1') });
      assert.equal(await waitForObject('w1.txt'), 'w1', 'presence: the upload reached the mock');
      await page.locator('.activity-line', { hasText: 'finished' }).waitFor({ timeout: scaleTimeout(10000) });
      await page.locator('[data-testid="file-row:w1.txt"]').waitFor({ timeout: scaleTimeout(10000) });
      const after = await docY();
      assert.ok(Math.abs(after - before) <= 1, `the list stayed put: y ${before} → ${after}`);
    } finally {
      await context.close();
    }
  });

  e2eTest('Activity survives a reconnect (Browser remount) and is attached under the toolbar again', async () => {
    const { context, page } = await connectedPage();
    try {
      await page
        .locator('input[data-testid="file-input"]')
        .setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('k') });
      await page.locator('.activity-line', { hasText: 'finished' }).waitFor({ timeout: scaleTimeout(15000) });
      // Sidebar reconnect to the same bucket remounts Browser (key={browserKey}).
      await page.locator('.hamburger').click();
      await page.locator('.sidebar .cred-panel button[type="submit"]').click();
      await page.locator('[data-testid="file-row:kept.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      const attached = page.locator('.browser-toolbar ~ .below-toolbar details.activity');
      await attached.waitFor({ timeout: scaleTimeout(5000) });
      assert.ok(
        (await page.locator('.activity-line').textContent()).includes('finished'),
        'the finished upload is still counted after the remount',
      );
    } finally {
      await context.close();
    }
  });

  e2eTest('Bucket tools ▾ → Incomplete uploads… opens that dialog', async () => {
    const { context, page } = await connectedPage();
    try {
      await page.locator('.bucket-tools-btn').click();
      await page.locator('[data-testid="open-incomplete-uploads"]').click();
      await page.locator('[role="dialog"]').waitFor({ timeout: scaleTimeout(10000) });
    } finally {
      await context.close();
    }
  });
});
