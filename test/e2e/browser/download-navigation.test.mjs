// Browser e2e: a queued download must never be able to navigate the application away, and a
// job-wide fault must stop the job instead of issuing thousands of silent failures.
//
// WHY THIS EXISTS AS AN E2E AND NOT A UNIT TEST. The defect is top-frame navigation. jsdom does
// not navigate, so no unit or component test can reproduce it — test/components/download-issue
// asserts only that one hidden frame is reused. This spec drives the BUILT bundle in a real
// engine against a mock that returns real error responses, which is the only place the
// behaviour is observable. Every one of the four bugs found in this feature's development got
// past a fully green suite; this is the layer that would have caught one of them.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser, context, page;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  context = await newE2EContext(browser);
  page = await newE2EPage(context);

  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dl/a.txt', Body: 'a' }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dl/b.txt', Body: 'b' }));
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

// Open the folder-download panel, enumerate, and start. Leaves the run in flight.
// dispatchEvent, not click(): the entry point lives at the foot of a scrolling sidebar and is
// genuinely outside the viewport, which `force` does not help with — it skips the actionability
// checks, not the geometry. Nothing here is testing whether that button is reachable by mouse.
async function startFolderDownload() {
  await page.locator('[data-testid="open-download-job"]').dispatchEvent('click');
  await page.locator('[data-testid="scan"]').click();
  await page.locator('[data-testid="start"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="start"]').click();
}

describe('browser e2e — a failing download cannot navigate the app away', () => {
  e2eTest('connects and enters the folder to be downloaded', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.browserEndpoint);
    await page.locator('[data-testid="folder-row:dl"]').click();
    // Row testids are relative to the current prefix, not the full key.
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
  });

  // A 404 is NOT job-wide, so the engine proceeds and hands the URL over — which is exactly the
  // case that used to navigate: an error response carries no Content-Disposition, so the browser
  // renders it, and an anchor renders it in the top frame.
  e2eTest('an error response renders into the hidden frame, not the top frame', async () => {
    ctx.mock.configure({ faults: [{ op: 'GetObject', method: 'GET', status: 404, code: 'NoSuchKey', message: 'gone' }] });
    const before = page.url();

    await startFolderDownload();
    await page.locator('#bucketer-download-frame').waitFor({ state: 'attached', timeout: 15000 });

    assert.equal(page.url(), before, 'the application must still be the document in the top frame');
    assert.ok(await page.locator('#app').count() > 0, 'the app root must still be mounted');
    assert.equal(await page.locator('iframe#bucketer-download-frame').count(), 1,
      'one frame is reused; an element per file would be an unbounded DOM leak');
  });

  // The probe is a raw fetch carrying Range, which is CORS-safelisted. Asserting on the DENIED
  // wording rather than merely "the job stopped" is deliberate: if CORS had rejected the probe
  // it would surface as the NETWORK message instead, and the job would stop for the wrong reason
  // while the test still passed.
  e2eTest('a denial stops the job before issuing, and says why', async () => {
    // The previous run issued every item, so its manifest is gone and this scans a fresh job.
    // No reload: reconnecting would have to disambiguate three submit buttons in the connected UI.
    ctx.mock.configure({ faults: [{ op: 'GetObject', method: 'GET', status: 403, code: 'AccessDenied', message: 'denied' }] });

    await startFolderDownload();

    await page.getByText(/refused the download/i).first().waitFor({ timeout: 15000 });
    assert.equal(page.url().startsWith(app.url), true, 'a blocked job must not navigate either');
  });
});
