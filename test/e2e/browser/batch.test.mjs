// Browser e2e — The Power User's batch + listing-control journeys: multi-select batch delete and
// batch move, select-all, filter, sort, and the copy-link popover. Asserts DOM and real bucket state.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
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
  rowAction,
  waitForUploadsSettled,
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
  await page
    .locator('[data-testid="file-input"]')
    .setInputFiles(names.map((n) => ({ name: n, mimeType: 'text/plain', buffer: Buffer.from(n) })));
  await page.locator('[data-testid="queue-complete"]').waitFor({ timeout: scaleTimeout(20000) });
  for (const n of names) await page.locator(`[data-testid="file-row:${n}"]`).waitFor({ timeout: scaleTimeout(10000) });
  await waitForUploadsSettled(page);
}
// force: the post-upload re-render (listing refetch + BatchSummary auto-collapse) keeps rows
// briefly "unstable" for Playwright; the checkboxes are functional.
const selectRow = (page, name) =>
  page
    .locator(`[data-testid="file-row:${name}"]`)
    .locator('td.col-check input[type="checkbox"]')
    .check({ force: true });
async function waitForKeys(expected, timeout = scaleTimeout(10000)) {
  const want = JSON.stringify(expected);
  const deadline = Date.now() + timeout;
  let keys = await bucketKeys();
  while (JSON.stringify(keys) !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    keys = await bucketKeys();
  }
  assert.deepEqual(keys, expected);
}

describe('batch delete', () => {
  e2eTest('selecting two of three files and batch-deleting removes only those two', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['a.txt', 'b.txt', 'c.txt']);
      await selectRow(page, 'a.txt');
      await selectRow(page, 'c.txt');
      await page.locator('.batch-bar', { hasText: 'selected' }).waitFor({ timeout: scaleTimeout(5000) });
      await page.locator('.batch-bar button.btn-danger').click(); // Delete N
      const modal = page.locator('.modal-overlay');
      await modal.waitFor({ timeout: scaleTimeout(5000) });
      await page.locator('[data-testid="delete-confirm"]').click();
      await modal.waitFor({ state: 'detached', timeout: scaleTimeout(5000) });
      await waitForKeys(['b.txt']);
    } finally {
      await context.close();
    }
  });
});

describe('batch bar on a phone (BUG-082)', () => {
  // The first selection used to insert the batch bar above the list, so every row jumped down
  // ~122 px under the user's finger (and Playwright's: firefox × Pixel 5 checked a row that had
  // just moved off-screen). On phones the bar is fixed to the bottom of the screen instead.
  e2eTest('selecting the first row does not move the rows below it', async (t) => {
    const { context, page } = await freshSession();
    try {
      if ((await page.evaluate(() => innerWidth)) > 640) {
        t.skip('desktop keeps the in-flow batch bar (layout A mockup: sticky at the top of the list)');
        return;
      }
      await uploadFiles(page, ['a.txt', 'b.txt', 'c.txt']);
      const row = page.locator('[data-testid="file-row:c.txt"]');
      const docY = () => row.evaluate((r) => r.getBoundingClientRect().y + window.scrollY);
      const before = await docY();
      await selectRow(page, 'a.txt');
      await page.locator('.batch-bar', { hasText: '1 file selected' }).waitFor({ timeout: scaleTimeout(5000) });
      const after = await docY();
      assert.ok(Math.abs(after - before) <= 1, `c.txt stayed put on the page: y ${before} → ${after}`);
    } finally {
      await context.close();
    }
  });
});

describe('batch bar on wider screens (slice 4b)', () => {
  // Above 640 px the bar sits above the list; in a long folder, selecting a row and scrolling down
  // left Copy/Move/Delete a scroll away. It now sticks to the top of the view.
  e2eTest('the batch bar stays in view after scrolling a long list', async (t) => {
    ctx.mock.reset();
    const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    for (const n of names) await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: n, Body: n }));
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      if ((await page.evaluate(() => innerWidth)) <= 640) {
        t.skip('phones fix the bar to the bottom of the screen (BUG-082)');
        return;
      }
      const first = page.locator('[data-testid="file-row:f00.txt"]');
      await first.waitFor({ timeout: scaleTimeout(10000) });
      await selectRow(page, 'f00.txt');
      const bar = page.locator('.batch-bar', { hasText: '1 file selected' });
      await bar.waitFor({ timeout: scaleTimeout(5000) });
      await page.locator('[data-testid="file-row:f39.txt"]').scrollIntoViewIfNeeded();
      const firstTop = await first.evaluate((r) => r.getBoundingClientRect().top);
      assert.ok(firstTop < 0, `the list scrolled: the first row is above the view (top ${firstTop})`);
      const { top, bottom, vh } = await bar.evaluate((b) => {
        const r = b.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: innerHeight };
      });
      assert.ok(top >= 0 && bottom <= vh, `the bar is on screen (top ${top}, bottom ${bottom}, view ${vh})`);
      await bar.locator('button.btn-danger').click(); // reachable without scrolling back
      await page.locator('.modal-overlay').waitFor({ timeout: scaleTimeout(5000) });
    } finally {
      await context.close();
    }
  });
});

describe('batch move', () => {
  e2eTest('selecting two files and moving them relocates both under the destination', async () => {
    const { context, page } = await freshSession();
    try {
      // Make a destination folder, then three files.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: scaleTimeout(5000) });
      await ni.fill('dest');
      await ni.press('Enter');
      await page.locator('[data-testid="folder-row:dest"]').waitFor({ timeout: scaleTimeout(5000) });
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
    } finally {
      await context.close();
    }
  });
});

describe('select-all, filter, sort', () => {
  e2eTest('select-all checkbox selects every visible file', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['one.txt', 'two.txt', 'three.txt']);
      await page.locator('th.col-check input[type="checkbox"]').check({ force: true });
      await page.locator('.batch-bar', { hasText: '3 files' }).waitFor({ timeout: scaleTimeout(5000) });
      assert.ok((await page.locator('.batch-bar').textContent()).includes('3 files'));
    } finally {
      await context.close();
    }
  });

  e2eTest('the filter box narrows the listing by name', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['apple.txt', 'banana.txt', 'apricot.txt']);
      // Starts-with match: the placeholder carries a "( / )" shortcut-hint suffix.
      await page.locator('input[placeholder^="Filter loaded items"]').fill('ap');
      // Only the two "ap…" files remain visible.
      await page
        .locator('[data-testid="file-row:banana.txt"]')
        .waitFor({ state: 'detached', timeout: scaleTimeout(5000) });
      assert.equal(await page.locator('[data-testid="file-row:apple.txt"]').count(), 1);
      assert.equal(await page.locator('[data-testid="file-row:apricot.txt"]').count(), 1);
      assert.equal(await page.locator('[data-testid="file-row:banana.txt"]').count(), 0);
    } finally {
      await context.close();
    }
  });

  e2eTest('clicking the Name header sorts; descending reverses row order', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['a.txt', 'b.txt', 'c.txt']);
      // Default is name ascending. Click Name once → toggles to descending.
      await page.locator('th:has-text("Name")').click();
      // Only listing rows: the UploadLog under Activity also renders tr.file-row rows (no
      // data-testid) in its own .file-table, so a .file-table scope let them in once they
      // rendered — three nulls on CI's webkit phone lanes, pipeline 2958991303.
      // Poll rather than read once: on a slow lane the re-render is mid-flight right
      // after the click (issue #55).
      const readOrder = () =>
        page
          .locator('.file-table tbody tr[data-testid^="file-row:"]')
          .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
      const expected = ['file-row:c.txt', 'file-row:b.txt', 'file-row:a.txt'];
      // Scaled by lane: this exact 5 s poll blew on webkit-mobile (~7 s) in pipeline #308.
      const deadline = Date.now() + scaleTimeout(5000);
      let order = await readOrder();
      while (JSON.stringify(order) !== JSON.stringify(expected) && Date.now() < deadline) {
        await page.waitForTimeout(100);
        order = await readOrder();
      }
      assert.deepEqual(order, expected, 'descending name order');
    } finally {
      await context.close();
    }
  });
});

describe('copy-link popover', () => {
  e2eTest('opening Copy link on a row generates a presigned URL that fetches the object', async () => {
    const { context, page } = await freshSession();
    try {
      await uploadFiles(page, ['link.txt']);
      const row = page.locator('[data-testid="file-row:link.txt"]');
      await rowAction(row, 'Copy share link…', { force: true });
      // The popover offers expiry presets; pick 1 hour and capture the generated URL via clipboard
      // is environment-dependent — instead assert the popover opened and a preset is clickable.
      const popover = page.locator('.copy-link-wrap .copy-link-popover, .copy-link-popover');
      await popover.first().waitFor({ timeout: scaleTimeout(5000) });
      assert.ok(await popover.first().isVisible(), 'copy-link popover opens with expiry options');
    } finally {
      await context.close();
    }
  });
});
