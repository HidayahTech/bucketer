// REPORT A1/A2: the accent #1aa3c0 carried white text on Connect and every primary button
// (2.98:1) and coloured every file/folder name, crumb and active sort header; dark #22b8cf
// was 2.38:1. WCAG AA needs 4.5:1 for this text. The observable is the RENDERED pair —
// computed text colour against the first opaque background behind it — in light and dark,
// not the token values. Look B (v1.65.0) moved the header to its own --header-bg/--header-fg
// pair, so the header buttons and wordmark are measured too, plus the muted size column.
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

// Runs in the page: contrast of each matching element's text against its effective background.
function measure(selectors) {
  function parse(c) {
    let m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
    m = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  }
  const lum = ([r, g, b]) => {
    const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  function background(el) {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.99) return c;
    }
    return [1, 1, 1, 1];
  }
  const out = [];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) {
      out.push({ sel, missing: true });
      continue;
    }
    const fg = parse(getComputedStyle(el).color);
    const bg = background(el);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    out.push({ sel, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  return out;
}

for (const scheme of ['light', 'dark']) {
  describe(`accent text contrast — ${scheme}`, () => {
    e2eTest(
      `Connect, names, crumbs, sort header, size column and header controls reach 4.5:1 (${scheme})`,
      async () => {
        ctx.mock.reset();
        await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/a/inner.txt', Body: 'i' }));
        await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/a/file.txt', Body: 'f' }));
        const context = await newE2EContext(browser, { colorScheme: scheme });
        const page = await newE2EPage(context);
        try {
          await page.goto(app.url, { waitUntil: 'domcontentloaded' });
          await page.locator('button[type="submit"].btn-primary').waitFor({ timeout: scaleTimeout(10000) });
          const splash = await page.evaluate(measure, ['button[type="submit"].btn-primary', '.wordmark']);
          await connectApp(page, ctx.browserEndpoint);
          await page.locator('[data-testid="folder-row:docs"]').waitFor({ timeout: scaleTimeout(10000) });
          await page.locator('[data-testid="folder-row:docs"] .file-dir').click();
          await page
            .locator('[data-testid="folder-row:docs/a"], [data-testid="folder-row:a"]')
            .first()
            .waitFor({ timeout: scaleTimeout(10000) });
          await page.locator('.file-dir').first().click();
          await page
            .locator('.file-name-previewable')
            .first()
            .waitFor({ timeout: scaleTimeout(10000) });
          const connected = await page.evaluate(measure, [
            '.file-name-previewable',
            '.breadcrumb .crumb',
            'th.col-sort-active',
            'header .hdr-btn',
            'td.col-size',
          ]);
          await page.locator('.breadcrumb .crumb').last().click();
          await page
            .locator('.file-dir')
            .first()
            .waitFor({ timeout: scaleTimeout(10000) });
          const folder = await page.evaluate(measure, ['.file-dir']);
          for (const r of [...splash, ...connected, ...folder]) {
            assert.ok(!r.missing, `${r.sel} must be on screen`);
            assert.ok(r.ratio >= 4.5, `${r.sel}: ${r.ratio}:1 is below 4.5:1 (${scheme})`);
          }
        } finally {
          await context.close();
        }
      },
    );
  });
}
