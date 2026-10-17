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
import {
  scaleTimeout,
  startMock,
  startAppServer,
  connectApp,
  BUCKET,
  launchBrowser,
  newE2EPage,
  e2eTest,
  applyEngineQuirks,
  e2eEngineName,
  rowAction,
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
    assert.ok(
      box.x >= 0 && box.x + box.width <= vw + 1,
      `${label}: button at x=${box.x} w=${box.width} must fit inside viewport width ${vw}`,
    );
  }
}

// Long enough that its nowrap width alone exceeds a phone viewport — BUG-042: the name
// column cannot shrink below a nowrap name's width (max-width:100% is circular during
// table intrinsic sizing), so without mobile name-wrapping this pushes the actions
// column off-screen. NOTE: only the bounding-box assertions catch this — the page
// scrollWidth stays put because an inner wrapper scrolls, not the document.
const LONG_NAME = 'vacation-photos-2026-family-reunion-beach-day-final-edit-v3.jpg';

describe('issue #49 — mobile (Pixel-5-emulated): per-row actions are reachable', () => {
  e2eTest('no horizontal overflow, and file + folder action buttons sit inside the viewport', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'reflow.txt', Body: 'x' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: LONG_NAME, Body: 'l' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/inner.txt', Body: 'y' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      await page.locator('[data-testid="file-row:reflow.txt"]').waitFor({ timeout: scaleTimeout(10000) });

      // The page itself must not scroll sideways (the pre-fix symptom).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `page must not overflow horizontally (scrollWidth exceeds viewport by ${overflow}px)`);

      await assertButtonsInViewport(page, page.locator('[data-testid="file-row:reflow.txt"]'), 'file row');
      await assertButtonsInViewport(
        page,
        page.locator(`[data-testid="file-row:${LONG_NAME}"]`),
        'long-name file row (BUG-042)',
      );
      await assertButtonsInViewport(page, page.locator('[data-testid="folder-row:docs"]'), 'folder row');
    } finally {
      await context.close();
    }
  });

  e2eTest('per-row delete works end-to-end on mobile (no force-click)', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'doomed.txt', Body: 'z' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:doomed.txt"]');
      await row.waitFor({ timeout: scaleTimeout(10000) });

      await rowAction(row, 'Delete…'); // actionability-checked: ⋯ and the item must be reachable
      const modal = page.locator('.modal-overlay');
      await modal.waitFor({ timeout: scaleTimeout(5000) });
      await page.locator('[data-testid="delete-confirm"]').click();
      await modal.waitFor({ state: 'detached', timeout: scaleTimeout(5000) });

      await row.waitFor({ state: 'detached', timeout: scaleTimeout(10000) });
      const deadline = Date.now() + scaleTimeout(10000);
      let keys;
      do {
        const r = await ctx.client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
        keys = (r.Contents || []).map((o) => o.Key);
        if (keys.length === 0) break;
        await new Promise((r2) => setTimeout(r2, 150));
      } while (Date.now() < deadline);
      assert.deepEqual(keys, [], 'the object is deleted from the bucket');
    } finally {
      await context.close();
    }
  });

  // REPORT M1/P1: the batch bar did not wrap, so "Copy N"/"Delete N" sat at x 371–500 on a
  // ~390 px phone — reachable only by an unmarked sideways pan — and the overflow also froze
  // the page for seconds after selecting a row. Select a row by tapping (no force), then the
  // batch actions must be inside the viewport and Delete must open its confirmation.
  e2eTest('batch bar actions are reachable after selecting a row', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'pick-a.txt', Body: 'a' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'pick-b.txt', Body: 'b' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:pick-a.txt"]');
      await row.waitFor({ timeout: scaleTimeout(10000) });
      await row.locator('input[type="checkbox"]').check();
      const bar = page.locator('.batch-bar');
      await bar.waitFor({ timeout: scaleTimeout(5000) });
      const vw = await page.evaluate(() => window.innerWidth);
      const buttons = await bar.locator('button').all();
      assert.ok(buttons.length >= 2, 'batch bar must offer actions');
      for (const btn of buttons) {
        const box = await btn.boundingBox();
        const label = (await btn.textContent()).trim();
        assert.ok(box, `batch button "${label}" must be visible`);
        assert.ok(
          box.x >= 0 && box.x + box.width <= vw + 1,
          `batch button "${label}" at x=${box.x} w=${box.width} must fit ${vw}`,
        );
      }
      await bar.locator('button', { hasText: 'Delete' }).click(); // no force: must be hit-testable
      await page.locator('.modal-overlay').waitFor({ timeout: scaleTimeout(5000) });
    } finally {
      await context.close();
    }
  });

  // REPORT M3: every control was under 44 px in at least one dimension (WCAG 2.5.5 / Apple HIG).
  e2eTest('header, row, breadcrumb and batch controls are at least 44 × 44 px on a phone', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'sub/t.txt', Body: 't' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'target.txt', Body: 't' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:target.txt"]');
      await row.waitFor({ timeout: scaleTimeout(10000) });
      await row.locator('input[type="checkbox"]').check();
      await page.locator('.batch-bar').waitFor({ timeout: scaleTimeout(5000) });
      const small = await page.evaluate(() => {
        const sel = [
          '.app-header button',
          '.file-table .col-actions button',
          '.file-table td.col-check',
          '.batch-bar button',
          '.breadcrumb button',
        ].join(',');
        return [...document.querySelectorAll(sel)]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
          .map(
            ({ el, r }) =>
              `${el.className || el.tagName} "${(el.textContent || el.title || '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
          );
      });
      assert.deepEqual(small, [], `controls under 44 px:\n${small.join('\n')}`);
    } finally {
      await context.close();
    }
  });

  // Slice 4b: rows carried 4–6 icon buttons that wrapped to 2–3 lines below 1024 px (REPORT M2);
  // now Download + ⋯ sit on one line, and the ⋯ menu (a bottom sheet on phones) fits on screen.
  e2eTest('row actions fit on one line and the ⋯ menu opens inside the viewport (phone + tablet)', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: LONG_NAME, Body: 'l' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/inner.txt', Body: 'y' }));
    for (const device of ['Pixel 5', 'iPad Mini']) {
      const context = await browser.newContext(applyEngineQuirks(e2eEngineName(), devices[device]));
      const page = await newE2EPage(context);
      try {
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await connectApp(page, ctx.browserEndpoint);
        for (const testid of [`file-row:${LONG_NAME}`, 'folder-row:docs']) {
          const row = page.locator(`[data-testid="${testid}"]`);
          await row.waitFor({ timeout: scaleTimeout(10000) });
          const tops = await row
            .locator('.row-actions > button, .row-actions .row-menu-btn')
            .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
          assert.equal(tops.length, 2, `${device} ${testid}: Download + ⋯`);
          assert.equal(tops[0], tops[1], `${device} ${testid}: both on one line (tops ${tops})`);
          await row.locator('.row-menu-btn').click(); // no force: must be hit-testable
          const menu = row.locator('.row-menu');
          await menu.waitFor({ timeout: scaleTimeout(5000) });
          const vw = await page.evaluate(() => window.innerWidth);
          const vh = await page.evaluate(() => window.innerHeight);
          const box = await menu.boundingBox();
          assert.ok(
            box.x >= 0 && box.x + box.width <= vw + 1 && box.y >= 0 && box.y + box.height <= vh + 1,
            `${device} ${testid}: menu (${box.x},${box.y} ${box.width}×${box.height}) inside ${vw}×${vh}`,
          );
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'detached', timeout: scaleTimeout(5000) });
        }
      } finally {
        await context.close();
      }
    }
  });

  e2eTest('copy-link popover opens fully inside the mobile viewport', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'linked.txt', Body: 'l' }));
    const { context, page } = await newMobilePage();
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator('[data-testid="file-row:linked.txt"]');
      await row.waitFor({ timeout: scaleTimeout(10000) });

      await rowAction(row, 'Copy share link…');
      const popover = page.locator('.copy-link-popover');
      await popover.waitFor({ timeout: scaleTimeout(5000) });
      const vw = await page.evaluate(() => window.innerWidth);
      const box = await popover.boundingBox();
      assert.ok(box, 'popover must be visible');
      assert.ok(
        box.x >= 0 && box.x + box.width <= vw + 1,
        `popover (x=${box.x}, w=${box.width}) must fit inside viewport width ${vw}`,
      );
    } finally {
      await context.close();
    }
  });
});

// REPORT M2: between 641 and ~975 px (phone landscape, iPad Mini portrait) the BUG-042
// name-wrap did not apply, so a long filename pushed every row action off-screen.
describe('issue #49 — mid-width band (800 px): long names do not push actions off-screen', () => {
  e2eTest('row actions sit inside an 800 px viewport next to a long filename', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: LONG_NAME + '-' + LONG_NAME, Body: 'l' }));
    const context = await browser.newContext({ viewport: { width: 800, height: 1000 } });
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      const row = page.locator(`[data-testid="file-row:${LONG_NAME}-${LONG_NAME}"]`);
      await row.waitFor({ timeout: scaleTimeout(10000) });
      await assertButtonsInViewport(page, row, 'long-name row at 800 px');
    } finally {
      await context.close();
    }
  });
});
