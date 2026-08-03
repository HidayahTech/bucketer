// Browser e2e: a batch-bar selection downloads exactly the ticked files — no more, no
// fewer. Presence observable: a Playwright `download` event (or, on WebKit, the mock's
// attachment GETs) per ticked file. The untouched sibling file is the "no others" half.
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage,
  collectDownloads, e2eTest, e2eEngineName,
} from '../harness.mjs';

let ctx, app, browser, context, page, downloads;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  // Two loose files + a folder of two, plus one file that must NOT download.
  for (const [key, body] of [
    ['sel/a.txt', 'aaa'], ['sel/b.txt', 'bbb'],
    ['sel/sub/c.txt', 'ccc'], ['sel/sub/d.txt', 'ddd'],
    ['sel/untouched.txt', 'nope'],
  ]) {
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
  }
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

beforeEach(async () => {
  await context?.close().catch(() => {});
  context = await newE2EContext(browser);
  page = await newE2EPage(context);
  downloads = collectDownloads(page);
  ctx.mock.configure({ latencyMs: 0, faults: [] });
  ctx.mock.requestLog.reset();
});

const navGetPaths = () => new Set(ctx.mock.requestLog.list().filter(r => r.isNavGet).map(r => r.path));
const isWebKit = () => e2eEngineName() === 'webkit';

describe('browser e2e — selection download', () => {
  e2eTest('ticked files and folders download; unticked files do not', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:sel"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });

    // Tick a.txt, b.txt and the sub/ folder — leave untouched.txt alone.
    for (const row of ['file-row:a.txt', 'file-row:b.txt', 'folder-row:sub']) {
      await page.locator(`[data-testid="${row}"] .col-check input`).click();
    }
    await page.getByRole('button', { name: /^Download 3$/ }).click();
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 4 of 4/).first().waitFor({ timeout: 60000 });

    if (isWebKit()) {
      await downloads.settle(4000);
    } else {
      await downloads.waitForCount(4, 30000);
    }
    const paths = navGetPaths();
    assert.equal(paths.size, 4, 'exactly the four selected files must be requested');
    assert.ok(![...paths].some(p => p.includes('untouched')), 'the unticked file must never be requested');
  });

  e2eTest('the folder-row entry downloads that subfolder without navigating into it', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:sel"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
    await page.locator('[data-testid="download-folder:sel/sub/"]').click();
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 2 of 2/).first().waitFor({ timeout: 60000 });

    if (isWebKit()) { await downloads.settle(4000); } else { await downloads.waitForCount(2, 30000); }
    assert.equal(navGetPaths().size, 2);
  });
});
