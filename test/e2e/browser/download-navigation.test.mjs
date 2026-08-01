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
  // Three files: the wholesale-deny test needs a streak of three consecutive denials.
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dl/c.txt', Body: 'c' }));
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

  // Every file is probed before it is issued, so a plain 404 never reaches a frame any
  // more — the file fails at the probe. The case BUG-050's containment still has to
  // handle is the object vanishing BETWEEN probe and issue: the probe (a Range GET)
  // succeeds, the download GET then returns an error body with no Content-Disposition,
  // and the browser renders it — into the hidden frame, never the top frame. `skipRange`
  // makes the fault hit only the download GET.
  e2eTest('an error response renders into the hidden frame, not the top frame', async () => {
    ctx.mock.configure({ faults: [{ op: 'GetObject', method: 'GET', status: 404, code: 'NoSuchKey', message: 'gone', skipRange: true }] });
    ctx.mock.requestLog.reset();
    const before = page.url();

    await startFolderDownload();
    await page.locator('#bucketer-download-frames iframe').first().waitFor({ state: 'attached', timeout: 15000 });
    // Let the run finish issuing all three before asserting on its traffic.
    await page.getByText(/Sent 3 of 3/).first().waitFor({ timeout: 15000 });

    assert.equal(page.url(), before, 'the application must still be the document in the top frame');
    assert.ok(await page.locator('#app').count() > 0, 'the app root must still be mounted');
    // BUG-053 replaced the single reused frame with a bounded pool: consecutive issues
    // must not share a frame (a src reassignment cancels a pending navigation), and the
    // pool cap is what prevents an element-per-file DOM leak.
    const frameCount = await page.locator('#bucketer-download-frames iframe').count();
    assert.ok(frameCount >= 1 && frameCount <= 8,
      `frame pool must hold between 1 and 8 frames, saw ${frameCount}`);

    // Presence assertions: absence claims above are only trustworthy if the run genuinely
    // reached the mock (the postmortem's lesson: an inert feature satisfies every absence
    // assertion). Both files' download GETs must have arrived — which also finally asserts
    // the other half of this fix's original definition of done: the job CONTINUES past the
    // first file's error and issues b.txt (missteps item 47 recorded that this was written
    // down as the bar and never asserted).
    // The last nav GET may still be in flight when the "Sent" text lands; poll briefly.
    const navPaths = () => new Set(ctx.mock.requestLog.list().filter((r) => r.isNavGet).map((r) => r.path));
    const deadline = Date.now() + 5000;
    while (navPaths().size < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(navPaths().size, 3,
      `every file must be requested as a download despite the first erroring — saw ${[...navPaths()].join(', ')}`);
  });

  // The probe is a raw fetch carrying Range, which is CORS-safelisted. Asserting on the DENIED
  // wording rather than merely "the job stopped" is deliberate: if CORS had rejected the probe
  // it would surface as the NETWORK message instead, and the job would stop for the wrong reason
  // while the test still passed.
  //
  // Three files are seeded because a single denial no longer blocks: AWS answers 403 for
  // a missing key when the caller lacks s3:ListBucket, so one denial is one file's
  // failure, and only a streak of consecutive denials (three) is read as a wholesale deny.
  e2eTest('a wholesale denial stops the job and says why', async () => {
    // The previous run issued every item (its errors happened after issuing), so its
    // manifest is gone and this scans a fresh job.
    // No reload: reconnecting would have to disambiguate three submit buttons in the connected UI.
    ctx.mock.configure({ faults: [{ op: 'GetObject', method: 'GET', status: 403, code: 'AccessDenied', message: 'denied' }] });
    ctx.mock.requestLog.reset();

    await startFolderDownload();

    await page.getByText(/refused the download/i).first().waitFor({ timeout: 15000 });
    assert.equal(page.url().startsWith(app.url), true, 'a blocked job must not navigate either');
    assert.equal(ctx.mock.requestLog.list().filter((r) => r.isNavGet).length, 0,
      'nothing may be handed to the download manager under a wholesale deny');
  });
});
