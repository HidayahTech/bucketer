// Look B (v1.65.0). Two observables:
// 1. The inlined Hanken Grotesk face actually loads and renders the UI. It ships as a data:
//    URL under CSP `font-src data:`; a missing directive or a broken placeholder swap falls back
//    to the system font silently (REPORT A8), so the check is the FontFace status in the page,
//    not the bundle bytes.
// 2. No control carries an emoji/Unicode glyph as its icon (REPORT A3): they render differently
//    per OS and ✕ meant Delete, Cancel and Close. Controls show inline SVG (`svg.icon`) instead.
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

// Runs in the page.
async function fontState() {
  await document.fonts.ready;
  const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Hanken Grotesk');
  return {
    faces: faces.map((f) => f.status),
    body: getComputedStyle(document.body).fontFamily,
    check: document.fonts.check('16px "Hanken Grotesk"'),
  };
}

// Runs in the page: control text containing a pictograph or one of the glyphs look B replaced.
function glyphControls() {
  const glyph = /[\p{Extended_Pictographic}ℹ✎↓⤓⎘↪✕☰✓✗]/u;
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], a, summary')) {
    const text = el.textContent || '';
    if (glyph.test(text)) out.push(`${el.tagName.toLowerCase()}: ${text.trim().slice(0, 40)}`);
  }
  return { offenders: out, icons: document.querySelectorAll('button svg.icon').length };
}

describe('look B', () => {
  e2eTest('Hanken Grotesk loads and no control uses an emoji glyph as its icon', async () => {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'docs/photo.jpg', Body: 'p' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'notes.txt', Body: 'n' }));
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await page.locator('button[type="submit"].btn-primary').waitFor({ timeout: scaleTimeout(10000) });
      const font = await page.evaluate(fontState);
      assert.ok(font.body.startsWith('"Hanken Grotesk"'), `body font-family: ${font.body}`);
      assert.ok(font.faces.length > 0, 'a Hanken Grotesk FontFace must be registered');
      assert.ok(
        font.faces.includes('loaded') && font.check,
        `Hanken Grotesk must load (statuses ${font.faces.join(',')}, check ${font.check})`,
      );

      await connectApp(page, ctx.browserEndpoint);
      await page.locator('[data-testid="folder-row:docs"]').waitFor({ timeout: scaleTimeout(10000) });
      const controls = await page.evaluate(glyphControls);
      assert.deepEqual(controls.offenders, [], 'controls must not use emoji/Unicode glyph icons');
      assert.ok(controls.icons > 0, 'connected-screen buttons must carry SVG icons');
    } finally {
      await context.close();
    }
  });
});
