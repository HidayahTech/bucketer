// Browser e2e: files handed to the download manager must actually become downloads.
//
// WHY THIS SPEC EXISTS. The 2026-07-31 postmortem found the download e2e proved only an
// absence ("the page did not navigate") — an assertion the bundle's CSP satisfied by
// blocking the download frame from loading anything at all (BUG-052), so zero downloads
// had ever occurred in this environment. This spec is the presence half: a Playwright
// `download` event per file, plus the mock's request log showing the attachment GETs
// arrived. It runs both transports deliberately — https is the production shape, and
// plain http is a real supported configuration (MinIO on a LAN) and the one BUG-052
// silently broke.
//
// THE LATENCY ARM is the regression gate for BUG-053: reassigning the shared frame's src
// cancelled the previous file's still-pending navigation, so any file whose first
// response byte took longer than the issue pacing was silently lost — measured at 20 of
// 40 files at 400 ms, on Chromium and Firefox alike, while the app reported
// "Sent 40 of 40". The 0 ms run is the matched control that proves the measurement; the
// two arms share one mock boot and differ by one variable (configure({ latencyMs })).
//
// WebKit: Playwright's download event does not fire there, so the WebKit lanes assert the
// server-side attachment-GET count instead — a weaker but still real observable.
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage,
  collectDownloads, e2eTest, e2eEngineName, e2eDeviceName,
} from '../harness.mjs';

let ctx, app, browser, context, page, downloads;

// dl8/: every file is probed (small job), so probe round trips pace every issue.
// dl40/: the racy shape — half the files issue on pacing alone.
const SMALL = 8;
const BIG = 40;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();

  for (let i = 1; i <= SMALL; i++) {
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: `dl8/s${i}.txt`, Body: 'x'.repeat(i * 11) }));
  }
  for (let i = 1; i <= BIG; i++) {
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: `dl40/f${i}.txt`, Body: 'y'.repeat(i * 7) }));
  }
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

// Fresh context per test: download listeners, IndexedDB job state, and panel state must
// not leak between arms.
beforeEach(async () => {
  await context?.close().catch(() => {});
  context = await newE2EContext(browser);
  page = await newE2EPage(context);
  downloads = collectDownloads(page);
  ctx.mock.configure({ latencyMs: 0, faults: [] });
  ctx.mock.requestLog.reset();
});

async function runFolderDownload(endpoint, folder, firstFile, fileCount) {
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, endpoint);
  await page.locator(`[data-testid="folder-row:${folder}"]`).click();
  await page.locator(`[data-testid="file-row:${firstFile}"]`).waitFor({ timeout: 10000 });
  await page.locator('[data-testid="open-download-job"]').dispatchEvent('click');
  await page.locator('[data-testid="scan"]').click();
  await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
  await page.locator('[data-testid="start"]').click();
  await page.getByText(new RegExp(`Sent ${fileCount} of ${fileCount}`)).first().waitFor({ timeout: 180000 });
}

// Distinct object paths, not raw request count: once the download manager takes over a
// navigation it may restart the fetch (measured: 72 GETs for 40 files on Chromium), so
// per-file duplicates are normal. What must hold is that every file was requested at
// least once.
const navGetPaths = () => new Set(ctx.mock.requestLog.list().filter((r) => r.isNavGet).map((r) => r.path)).size;
const isWebKit = () => e2eEngineName() === 'webkit';

async function assertAllDownloaded(fileCount, timeoutMs) {
  if (isWebKit()) {
    await downloads.settle(4000);
    assert.equal(navGetPaths(), fileCount,
      'every file must be requested as an attachment at least once (WebKit lane: server-side observable)');
  } else {
    await downloads.waitForCount(fileCount, timeoutMs);
    assert.equal(navGetPaths(), fileCount,
      'every download event must be matched by that file being requested from the mock');
  }
}

describe('browser e2e — downloads actually happen', () => {
  e2eTest('every issued file becomes a download over https', async () => {
    await runFolderDownload(ctx.httpsBrowserEndpoint, 'dl8', 's1.txt', SMALL);
    await assertAllDownloaded(SMALL, 20000);
  });

  // BUG-052: frame-src https: silently blocked every download on an http endpoint —
  // exactly the MinIO-on-LAN configuration. This arm is the regression gate.
  e2eTest('every issued file becomes a download over plain http', async () => {
    await runFolderDownload(ctx.browserEndpoint, 'dl8', 's1.txt', SMALL);
    await assertAllDownloaded(SMALL, 20000);
  });

  // BUG-053: 40 files at 400 ms first-byte latency. Pre-fix, exactly the files not paced
  // by a probe round trip lost their pending navigation to the next src assignment —
  // 20 of 40 — while the app reported "Sent 40 of 40". Desktop lanes only: the download
  // manager is not device-emulated, and this is the slow arm.
  e2eTest('no file is lost when the response is slower than the issue pacing', async (t) => {
    if (e2eDeviceName()) {
      t.skip('download-manager behavior is not device-emulated; racy arm runs on desktop lanes');
      return;
    }
    ctx.mock.configure({ latencyMs: 400 });

    await runFolderDownload(ctx.httpsBrowserEndpoint, 'dl40', 'f1.txt', BIG);
    await assertAllDownloaded(BIG, 90000);
  });
});
