// Browser e2e: the read-only folder check, end to end — and the reachability invariant.
//
// The 2026-08-01 postmortem's most serious v1.44.0 finding (F3): verifying a completed
// job that had missing files marked them FAILED, stamped the job verified, and left its
// status DONE — after which NO list showed it on any browser: no resume, no re-check, no
// Discard, manifest permanent. Measured live as 0 UI rows with 2 FAILED items stranded in
// IndexedDB. This spec drives the same flow against the built bundle and asserts the
// redesigned lifecycle keeps the job reachable at every step.
//
// The picker is stubbed via addInitScript (Playwright cannot drive the native dialog);
// the stub exists before the bundle loads, so capability detection sees it — which also
// means the check ACTION renders on every engine here. The unstubbed reachability test at
// the end asserts the row itself never depends on the picker.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage,
  installFakeDirectoryPicker, e2eTest,
} from '../harness.mjs';

let ctx, app, browser, context;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  context = await newE2EContext(browser);

  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dv/a.txt', Body: 'a'.repeat(11) }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dv/b.txt', Body: 'b'.repeat(22) }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dv/gone.txt', Body: 'g'.repeat(33) }));
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

async function openPanel(page) {
  await page.locator('[data-testid="open-download-job"]').dispatchEvent('click');
}

async function newAppPage(fakeFolder) {
  const page = await newE2EPage(context);
  if (fakeFolder) await installFakeDirectoryPicker(page, fakeFolder);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.httpsBrowserEndpoint);
  return page;
}

describe('browser e2e — folder verification keeps every job reachable', () => {
  e2eTest('a clean run is retained and offered for checking', async () => {
    const page = await newAppPage(null);
    await page.locator('[data-testid="folder-row:dv"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 3 of 3/).first().waitFor({ timeout: 60000 });

    await openPanel(page);
    await page.getByText(/Sent, but not yet confirmed/).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-testid^="discard-"]').count() >= 1, true,
      'a retained manifest must always carry a Discard');
    await page.close();
  });

  // The F3 flow itself: check a folder that is missing one file and truncated another.
  e2eTest('a check that finds problems reports them and turns the job resumable', async () => {
    const page = await newAppPage([
      { name: 'a.txt', size: 11 },
      { name: 'b.txt', size: 5 },     // wrong size
      /* gone.txt absent */
    ]);
    await openPanel(page);
    await page.locator('[data-testid^="verify-"]').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid^="verify-"]').first().click();

    // The verdicts render from the job record, and the job — now carrying failures —
    // must classify as unfinished: resumable and discardable, on every browser.
    await page.getByText(/1 missing/).first().waitFor({ timeout: 15000 });
    await page.getByText(/1 the wrong size/).first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator('[data-testid^="resume-"]').count(), 1,
      'failures found by a check must be reachable by resume (the stranded-job defect)');
    assert.equal(await page.locator('[data-testid^="discard-"]').count() >= 1, true);
    await page.close();
  });

  // Catalog defect 37: verify → resume → the re-issued files must be checkable again.
  e2eTest('after a resume, the job can be checked again and settles', async () => {
    const page = await newAppPage([
      { name: 'a.txt', size: 11 },
      { name: 'b.txt', size: 22 },
      { name: 'gone.txt', size: 33 },
    ]);
    await openPanel(page);
    await page.locator('[data-testid^="resume-"]').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid^="resume-"]').first().click();
    await page.getByText(/Sent 2 of 2/).first().waitFor({ timeout: 60000 });

    await openPanel(page);
    await page.locator('[data-testid^="verify-"]').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid^="verify-"]').first().click();

    // Everything now on disk at the right size: the job settles, still discardable.
    await page.getByText(/Confirmed complete/).waitFor({ timeout: 15000 });
    await page.getByText(/all 3 files confirmed/).waitFor({ timeout: 5000 });
    const discard = page.locator('[data-testid^="discard-"]').first();
    await discard.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-testid^="discard-"]').count(), 0,
      'discarding the settled job removes the last row');
    await page.close();
  });

  // The row-vs-action half of the invariant, without the stub: engines with no real
  // directoryPicker (firefox, webkit) must still show the row and its Discard for a
  // sent job — only the check button is capability-gated. (Catalog defect 18: on those
  // engines a retained manifest had no UI at all.)
  e2eTest('a sent job is discardable even where no directory picker exists', async () => {
    const page = await newAppPage(null);
    await page.locator('[data-testid="folder-row:dv"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 3 of 3/).first().waitFor({ timeout: 60000 });

    await openPanel(page);
    await page.getByText(/Sent, but not yet confirmed/).waitFor({ timeout: 10000 });
    const discard = page.locator('[data-testid^="discard-"]').first();
    await discard.waitFor({ timeout: 5000 });
    await discard.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-testid^="discard-"]').count(), 0);
    await page.close();
  });
});
