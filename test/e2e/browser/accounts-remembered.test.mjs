// Accounts A (v1.66.0). Basil's complaint (REPORT C1): a first connection was never saved, and
// Sign out wiped endpoint, bucket and key ID, so every return meant retyping all four.
// Observable: after an ordinary typed connect and Sign out, the splash lists that bucket with its
// storage address, and picking it refills endpoint, bucket and key ID (never the secret); the
// secret alone reconnects. Plus: a known key ID recalls its endpoint and bucket (C3), and the
// connected header names the bucket and host (C6).
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

describe('accounts A — remembered buckets', () => {
  e2eTest('a typed connect is remembered; after Sign out, picking it needs only the secret', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    const host = new URL(ctx.browserEndpoint).host;
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);

      // The page title names the bucket, and the line under it the storage address (layout A, v1.67.0).
      const title = page.locator('h1.breadcrumb-title');
      await title.waitFor({ timeout: scaleTimeout(10000) });
      assert.equal((await title.textContent()).trim(), BUCKET);
      assert.equal(await page.locator('.bucket-identity-host').textContent(), host);

      // Remembered once a request succeeds (the first listing), with no Save click.
      await page.waitForFunction(
        () => (JSON.parse(localStorage.getItem('s3b_connections') || '{}').connections || []).length === 1,
        null,
        { timeout: scaleTimeout(10000) },
      );
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
      assert.ok(!stored.includes('test-secret-key'), 'the secret is never written to localStorage');

      await page.locator('button:has-text("Sign out")').click();
      // Come back later: a reload drops everything in memory (including the listing cache).
      await page.reload({ waitUntil: 'domcontentloaded' });
      const card = page.locator('.accounts-manager-splash .bucket-row', { hasText: BUCKET });
      await card.waitFor({ timeout: scaleTimeout(10000) });
      assert.ok((await card.textContent()).includes(host), 'the card names its storage address');

      await card.locator('.bucket-name').click();
      assert.equal(await page.locator('#cred-endpoint').inputValue(), ctx.browserEndpoint);
      assert.equal(await page.locator('#cred-bucket').inputValue(), BUCKET);
      assert.equal(await page.locator('#cred-keyid').inputValue(), 'test-key-id');
      assert.equal(await page.locator('#cred-secretkey').inputValue(), '', 'the secret is not refilled');
      assert.equal((await page.locator('button[type="submit"]').textContent()).trim(), `Connect to ${BUCKET}`);

      ctx.mock.requestLog.reset();
      await page.locator('#cred-secretkey').fill('test-secret-key');
      await page.locator('button[type="submit"]').click();
      await page.locator('[data-testid="file-input"]').waitFor({ state: 'attached', timeout: scaleTimeout(15000) });
      assert.equal((await page.locator('h1.breadcrumb-title').textContent()).trim(), BUCKET);
      // Presence, not just "no error": after the reload, the reconnect listed the bucket on the mock.
      const deadline = Date.now() + scaleTimeout(10000);
      while (!ctx.mock.requestLog.list().some((r) => r.isList) && Date.now() < deadline) {
        await page.waitForTimeout(100);
      }
      const lists = ctx.mock.requestLog.list().filter((r) => r.isList);
      assert.ok(lists.length >= 1, `the reconnect listed the bucket (saw ${lists.length} list requests)`);
    } finally {
      await context.close();
    }
  });

  e2eTest('a key ID used before fills the endpoint and bucket', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await connectApp(page, ctx.browserEndpoint);
      await page.waitForFunction(
        () => (JSON.parse(localStorage.getItem('s3b_connections') || '{}').connections || []).length === 1,
        null,
        { timeout: scaleTimeout(10000) },
      );
      await page.locator('button:has-text("Sign out")').click();
      await page.locator('#cred-endpoint').fill('');
      await page.locator('#cred-bucket').fill('');
      await page.locator('#cred-keyid').fill('');
      await page.locator('#cred-keyid').fill('test-key-id');
      assert.equal(await page.locator('#cred-endpoint').inputValue(), ctx.browserEndpoint);
      assert.equal(await page.locator('#cred-bucket').inputValue(), BUCKET);
    } finally {
      await context.close();
    }
  });
});
