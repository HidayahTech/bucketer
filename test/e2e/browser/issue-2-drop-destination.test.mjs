// GitLab issue #2 — "Files/folders that are drag-and-dropped to nested folders/directories are
// uploaded to the root directory." Root cause (BUG-031): UploadQueue exposes addFiles via onMount
// with [] deps, so addFilesRef captures a stale closure over the mount-time destinationPrefix ('' =
// root); every drag-drop path goes through it and uploads to root regardless of the current folder.
//
// This test drives the table drop handler with a synthetic DataTransfer (the e.dataTransfer.files
// fallback path, which the real OS drag uses when FileSystemEntry isn't available) while viewing a
// nested folder, and asserts the object lands UNDER that folder — not at root.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  scaleTimeout,
  startMock,
  startAppServer,
  connectApp,
  BUCKET,
  launchBrowser,
  newE2EContext,
  newE2EPage,
  e2eTest,
  seedSavedBuckets,
  connectSaved,
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
// Dispatch a real file drop onto the Browser drop container, the way the OS does when
// FileSystemEntry isn't exposed (handleTableDrop falls back to e.dataTransfer.files).
async function dropFile(page, name, content = 'x') {
  await page.evaluate(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/plain' }));
      const el = document.querySelector('[data-testid="browser-drop"]');
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { name, content },
  );
}

// GitLab #72 (R01) — the connection half of the same stale onMount closure: after switching
// bucket A → B, a drop was uploaded to A while the screen showed B. Observable: where the
// dropped object's bytes end up in the mock, for both switch paths App offers.
describe('#72 — a drop after switching buckets uploads to the bucket on screen', () => {
  const A = 'bucket-a';
  const B = 'bucket-b';
  const keysIn = (b) => [...(ctx.mock.buckets.get(b)?.objects.keys() || [])].sort();
  async function seedTwoBuckets() {
    ctx.mock.reset();
    await ctx.client.send(new PutObjectCommand({ Bucket: A, Key: 'a-marker.txt', Body: 'A' }));
    await ctx.client.send(new PutObjectCommand({ Bucket: B, Key: 'b-marker.txt', Body: 'B' }));
  }
  async function showsBucketB(page) {
    await page.locator('[data-testid="file-row:b-marker.txt"]').waitFor({ timeout: scaleTimeout(15000) });
    await page
      .locator('[data-testid="file-row:a-marker.txt"]')
      .waitFor({ state: 'detached', timeout: scaleTimeout(5000) });
  }
  async function dropAndSettle(page) {
    await dropFile(page, 'dropped.txt', 'dropped while viewing B');
    const deadline = Date.now() + scaleTimeout(15000);
    while (!keysIn(A).includes('dropped.txt') && !keysIn(B).includes('dropped.txt') && Date.now() < deadline)
      await page.waitForTimeout(150);
    const r = await ctx.client.send(new GetObjectCommand({ Bucket: B, Key: 'dropped.txt' })).catch(() => null);
    const bytesInB = r ? await r.Body.transformToString() : null;
    assert.ok(!keysIn(A).includes('dropped.txt'), `must NOT land in ${A}; ${A}=${JSON.stringify(keysIn(A))}`);
    assert.equal(bytesInB, 'dropped while viewing B', `the dropped bytes must be in ${B}`);
  }

  e2eTest('sidebar reconnect A → B, then drop: the object is written to B', async () => {
    await seedTwoBuckets();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint, A);
      await page.locator('[data-testid="file-row:a-marker.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      await page.locator('.hamburger').click();
      await page.fill('#cred-bucket', B);
      await page.locator('.sidebar .cred-panel button[type="submit"]').click();
      await showsBucketB(page);
      await page.locator('.hamburger').click();
      await dropAndSettle(page);
    } finally {
      await context.close();
    }
  });

  e2eTest('saved-connection quick-switch A → B, then drop: the object is written to B', async () => {
    await seedTwoBuckets();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      // B and A saved on the same credential (the cached secret is keyed on the credential,
      // region included), connect A, then quick-switch to B the way the viewport offers it.
      await seedSavedBuckets(page, ctx.browserEndpoint, [{ bucket: B }, { bucket: A }]);
      await connectSaved(page, A);
      await page.locator('[data-testid="file-row:a-marker.txt"]').waitFor({ timeout: scaleTimeout(15000) });

      const tab = page.locator('.connection-tab', { hasText: B });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await showsBucketB(page);
      } else {
        await page.locator('button[aria-label="Open menu"]').click();
        await page.locator('.bucket-row', { hasText: B }).click();
        await showsBucketB(page);
        if (
          await page
            .locator('.sidebar')
            .isVisible()
            .catch(() => false)
        )
          await page.locator('button[aria-label="Open menu"]').click();
      }
      await dropAndSettle(page);
    } finally {
      await context.close();
    }
  });
});

describe('issue #2 — drag-dropped uploads target the current folder, not root', () => {
  e2eTest('dropping a file while viewing a nested folder uploads it INTO that folder', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // Create and enter a nested folder.
      await page.locator('button[title="Create a new folder"]').click();
      const ni = page.locator('.modal-overlay input.form-input');
      await ni.waitFor({ timeout: scaleTimeout(5000) });
      await ni.fill('sub');
      await ni.press('Enter');
      await page.locator('[data-testid="folder-row:sub"]').click();
      await page.locator('.breadcrumb .current', { hasText: 'sub' }).waitFor({ timeout: scaleTimeout(5000) });
      // Wait for the upload destination to reflect the folder (a real user takes far longer than this
      // to start a drag). The bug is the STALE CLOSURE: even fully settled, the captured addFiles read
      // the mount-time root prefix — waiting proves the fix, not the unrelated propagation lag.
      const dest = page.locator('.upload-target');
      for (let i = 0; i < 50 && (await dest.getAttribute('data-upload-target').catch(() => null)) !== 'sub/'; i++)
        await page.waitForTimeout(100);

      // Drag-drop a file onto the browser (the path that used the stale closure).
      await dropFile(page, 'dropped.txt');

      // It must land under sub/, never at the bucket root.
      const deadline = Date.now() + scaleTimeout(15000);
      let keys = await bucketKeys();
      while (!keys.includes('sub/dropped.txt') && !keys.includes('dropped.txt') && Date.now() < deadline) {
        await page.waitForTimeout(150);
        keys = await bucketKeys();
      }
      assert.ok(keys.includes('sub/dropped.txt'), `expected sub/dropped.txt, got ${JSON.stringify(keys)}`);
      assert.ok(!keys.includes('dropped.txt'), 'must NOT land at the bucket root (issue #2)');
    } finally {
      await context.close();
    }
  });
});
