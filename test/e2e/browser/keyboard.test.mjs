// Keyboard-only browsing (REPORT K1/K2/K3, Codex R07). Before v1.64.0 folders, breadcrumb
// crumbs, file previews and sort headers were click-only, modals took no focus, and the
// closed sidebar held 22 invisible Tab stops. Every step here reaches its target with Tab
// (proving it is in the Tab order) and activates it with a key — never a mouse click.
//
// Observables: the breadcrumb's current segment (navigation happened), the preview dialog
// appearing with focus inside and focus returning on Escape, and aria-sort flipping.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock,
  startAppServer,
  connectApp,
  BUCKET,
  launchBrowser,
  newE2EContext,
  newE2EPage,
  e2eTest,
  scaleTimeout,
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

// Press Tab until document.activeElement matches `selector`; fail after `max` presses.
// Walks start from the header's menu button, not body: after the focused folder name is
// removed by navigation, Firefox keeps the sequential-focus start point where it was, so a
// body.focus() start would begin below the breadcrumb.
async function tabTo(page, selector, max = 120) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return i + 1;
  }
  assert.fail(`"${selector}" was not reached within ${max} Tab presses`);
}

async function currentCrumb(page) {
  return (await page.locator('.breadcrumb .current').textContent()).trim();
}

async function freshConnectedPage() {
  ctx.mock.reset();
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/inner.txt', Body: 'inner' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'alpha.txt', Body: 'alpha' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'beta.txt', Body: 'beta-longer' }));
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  await page.locator('[data-testid="file-row:alpha.txt"]').waitFor({ timeout: scaleTimeout(10000) });
  return { context, page };
}

describe('keyboard-only browsing', () => {
  e2eTest('open a folder and go back up with Tab + Enter', async () => {
    const { context, page } = await freshConnectedPage();
    try {
      await page.locator('.hamburger').focus();
      await tabTo(page, '[data-testid="folder-row:docs"] .file-dir');
      await page.keyboard.press('Enter');
      await page
        .locator('[data-testid="file-row:docs/inner.txt"], [data-testid="file-row:inner.txt"]')
        .first()
        .waitFor({ timeout: scaleTimeout(10000) });
      assert.equal(await currentCrumb(page), 'docs', 'Enter on the folder name opens the folder');

      await page.locator('.hamburger').focus();
      await tabTo(page, '.breadcrumb button.crumb');
      await page.keyboard.press('Enter');
      await page.locator('[data-testid="file-row:alpha.txt"]').waitFor({ timeout: scaleTimeout(10000) });
      assert.equal(await currentCrumb(page), BUCKET, 'Enter on the root crumb (the bucket) goes back up');
    } finally {
      await context.close();
    }
  });

  e2eTest('preview a file with Enter; the dialog takes focus and Escape returns it', async () => {
    const { context, page } = await freshConnectedPage();
    try {
      await page.locator('.hamburger').focus();
      const nameSel = '[data-testid="file-row:alpha.txt"] .file-name-previewable';
      await tabTo(page, nameSel);
      await page.keyboard.press('Enter');
      const dialog = page.locator('[role="dialog"].preview-dialog');
      await dialog.waitFor({ timeout: scaleTimeout(10000) });
      assert.ok(
        await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
        'focus moves into the preview dialog',
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: scaleTimeout(5000) });
      assert.ok(
        await page.evaluate((s) => document.activeElement?.matches(s) ?? false, nameSel),
        'focus returns to the file name that opened the preview',
      );
    } finally {
      await context.close();
    }
  });

  e2eTest('sort by size with the keyboard', async () => {
    const { context, page } = await freshConnectedPage();
    try {
      const sizeTh = page.locator('th.col-sortable', { hasText: 'Size' });
      assert.equal(await sizeTh.getAttribute('aria-sort'), null, 'size is not the sort column yet');
      await page.locator('.hamburger').focus();
      await tabTo(page, 'th.col-sortable[title="Sort by Size"] button.sort-btn');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('th.col-sortable')].some(
            (th) => th.textContent.includes('Size') && th.getAttribute('aria-sort'),
          ),
        null,
        { timeout: scaleTimeout(5000) },
      );
    } finally {
      await context.close();
    }
  });

  e2eTest('the closed sidebar holds no Tab stops', async () => {
    const { context, page } = await freshConnectedPage();
    try {
      await page.locator('body').focus();
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab');
        const inSidebar = await page.evaluate(() => !!document.activeElement?.closest('aside.sidebar'));
        assert.equal(inSidebar, false, `Tab stop ${i + 1} landed inside the closed sidebar`);
      }
      // Presence next to the absence: once opened, its controls are reachable.
      await page.locator('.hamburger').click();
      await tabTo(page, 'aside.sidebar button');
    } finally {
      await context.close();
    }
  });
});
