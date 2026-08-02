// GitLab issue #4 — "I don't see it until I refresh."
//  Part 2 (BUG-032, same-client): uploading a folder INTO the current view created a sub-prefix that
//  onUploadsDrained never refetched (it matched the current prefix exactly, not descendants), so the
//  new folder stayed invisible until reload. Now the current view refetches when an upload lands in
//  it OR under it.
//  Part 1 (cross-client, by design — backendless): another device's upload isn't pushed; the Refresh
//  button pulls it on demand. This proves the Refresh control re-lists.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function freshSession({ seed } = {}) {
  ctx.mock.reset();
  // Seed AFTER the reset (which would otherwise wipe it): a pre-existing row is how a spec
  // proves the initial listing has fully landed — and the app has finished mounting — before
  // it acts (issue #55). Same anchor technique as part 1 below.
  if (seed) await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: seed, Body: new TextEncoder().encode('a') }));
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await connectApp(page, ctx.browserEndpoint);
  return { context, page };
}
// Drop a file (with a folder-bearing relativePath) onto the Browser drop container.
async function dropFile(page, name, content = 'x') {
  await page.evaluate(({ name, content }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'text/plain' }));
    document.querySelector('[data-testid="browser-drop"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name, content });
}

describe('issue #4 part 2 — a sub-folder created by an upload appears without a manual refresh', () => {
  e2eTest('dropping a file that creates a sub-folder in the current view shows it immediately', async () => {
    // Anchor on a pre-seeded root file: waiting for its row proves the initial listing has
    // landed AND the app is drop-ready. The drop path is App's
    // onExternalDrop={(entries) => addFilesRef.current?.(entries)}, and addFilesRef is wired by
    // the upload subsystem's onMount. connectApp only waits for the Browser to be *attached*,
    // not for that onMount to have run — so on a slow lane the drop could fire while
    // addFilesRef.current is still null, and the `?.` silently no-ops it: no upload, no
    // refetch, and folder-row:newdir never appears (issue #55, both webkit lanes, pipeline
    // #215). Gating on a rendered row closes that window.
    const { context, page } = await freshSession({ seed: 'anchor.txt' });
    try {
      await page.locator('[data-testid="file-row:anchor.txt"]').waitFor({ timeout: 10000 });
      // At root, drop a file whose relativePath creates a new sub-folder "newdir".
      await dropFile(page, 'newdir/x.txt');
      // The new folder must appear in the listing WITHOUT a page reload (the drained prefix is
      // "newdir/", a descendant of the current view "").
      await page.locator('[data-testid="folder-row:newdir"]').waitFor({ timeout: 15000 });
      assert.equal(await page.locator('[data-testid="folder-row:newdir"]').count(), 1);
    } finally { await context.close(); }
  });
});

describe('issue #4 part 1 — the Refresh button pulls changes made by another client', () => {
  e2eTest('an object added out-of-band appears after clicking Refresh', async () => {
    // Inlined session (freshSession's reset would wipe the marker): the marker exists
    // before the app connects, so waiting for its row proves the INITIAL listing has
    // fully landed. Without that anchor, a slow lane's first listing response can arrive
    // AFTER the out-of-band put below, making the "not visible yet" assertion race the
    // connect (seen on CI shared runners, issue #55).
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'already-here.txt', Body: new TextEncoder().encode('m') }));
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.browserEndpoint);
    try {
      await page.locator('[data-testid="file-row:already-here.txt"]').waitFor({ timeout: 10000 });
      // Simulate "another device" writing directly to the bucket (no UI involved).
      await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'from-other-device.txt', Body: new TextEncoder().encode('x') }));
      // It isn't visible yet (no live sync)…
      assert.equal(await page.locator('[data-testid="file-row:from-other-device.txt"]').count(), 0);
      // …until the user clicks Refresh.
      await page.locator('[data-testid="refresh-listing"]').click();
      await page.locator('[data-testid="file-row:from-other-device.txt"]').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('[data-testid="file-row:from-other-device.txt"]').count(), 1);
    } finally { await context.close(); }
  });
});
