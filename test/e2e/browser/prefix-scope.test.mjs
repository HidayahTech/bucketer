// Browser e2e — prefix-scoped access keys (#60).
//
// The mock simulates a key restricted to SCOPE (B2 namePrefix / IAM s3:prefix):
// any listing not at/under the scope and any object op outside it returns 403
// AccessDenied. Per the E2E Evidence Rules every absence assertion ("no root
// list ever happened") sits next to a presence assertion (rows from inside the
// scope actually rendered), backed by the mock's request log.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { startMock, startAppServer, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

const BUCKET = 'test-bucket';
const SCOPE = 'clients/acme/';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

// Seed while unscoped (the node-side admin client is "us", not the key under test),
// then turn the scope on and clear the log so assertions see only the app's traffic.
async function seedScoped() {
  ctx.mock.reset();
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'report.pdf', Body: new TextEncoder().encode('r') }));
  await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/secret.txt', Body: new TextEncoder().encode('x') }));
  ctx.mock.configure({ scopePrefix: SCOPE });
  ctx.mock.requestLog.reset();
}

async function freshPage(hash = '') {
  const context = await newE2EContext(browser);
  const page = await newE2EPage(context);
  await page.goto(app.url + hash, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

async function fillConnect(page, { baseFolder = null } = {}) {
  await page.locator('input[type="url"]').fill(ctx.browserEndpoint);
  await page.locator('input[placeholder="my-bucket"]').fill(BUCKET);
  if (baseFolder != null) await page.locator('#cred-baseprefix').fill(baseFolder);
  await page.locator('input[placeholder="Access Key ID"]').fill('scoped-key');
  await page.locator('input[placeholder="Secret Access Key"]').fill('s');
  const region = page.locator('input[placeholder="us-east-1"]');
  await region.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
  await page.locator('button[type="submit"]:has-text("Connect")').click();
}

function rootLists() {
  return ctx.mock.requestLog.list().filter((r) => r.isList && r.listPrefix === '');
}

describe('prefix-scoped keys — normal connect screen', () => {
  e2eTest('connect with a Base folder lists inside the scope; no root list is ever issued', async () => {
    await seedScoped();
    const { context, page } = await freshPage();
    try {
      await fillConnect(page, { baseFolder: SCOPE });
      // Presence: a row from inside the scope renders (keyed relative to the floor).
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: 15000 });
      // Absence, next to it: the app never asked for the bucket root.
      assert.equal(rootLists().length, 0,
        'no ListObjectsV2 with an empty Prefix may be issued for a scoped connection');
      // The breadcrumb is pinned: the floor leaf, not "root".
      const crumb = await page.locator('.breadcrumb').textContent();
      assert.ok(crumb.includes('acme') && !crumb.includes('root'), 'breadcrumb pinned at the floor');
    } finally { await context.close(); }
  });

  e2eTest('connecting WITHOUT a Base folder hits the denial and shows the recovery hint', async () => {
    await seedScoped();
    const { context, page } = await freshPage();
    try {
      await fillConnect(page); // no base folder → initial root list → mock 403
      await page.locator('.error-block').waitFor({ timeout: 15000 });
      const text = await page.locator('.error-block').textContent();
      assert.ok(text.includes('Base folder'),
        'the connection-failed error must point prefix-restricted keys at the Base folder field');
      // Presence proof that the denial actually happened at the mock:
      assert.ok(rootLists().length >= 1, 'the root list request must have reached the mock and been denied');
    } finally { await context.close(); }
  });
});

describe('prefix-scoped keys — shared link screen', () => {
  e2eTest('a share link carrying basePrefix pre-fills the scope and lists inside it after the secret', async () => {
    await seedScoped();
    const hash = '#endpoint=' + encodeURIComponent(ctx.browserEndpoint)
               + '&bucket=' + BUCKET + '&keyId=scoped-key&basePrefix=' + encodeURIComponent(SCOPE);
    const { context, page } = await freshPage(hash);
    try {
      // The link supplied everything but the secret — including the Base folder.
      assert.equal(await page.locator('#cred-baseprefix').inputValue(), SCOPE,
        'basePrefix from the link must pre-fill the Base folder field');
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: 15000 });
      assert.equal(rootLists().length, 0, 'no root list on the shared-link path either');
    } finally { await context.close(); }
  });

  e2eTest('an in-floor deep-link prefix lands in that subfolder', async () => {
    await seedScoped();
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + '2026/inner.txt', Body: new TextEncoder().encode('i') }));
    const hash = '#endpoint=' + encodeURIComponent(ctx.browserEndpoint)
               + '&bucket=' + BUCKET + '&keyId=scoped-key'
               + '&basePrefix=' + encodeURIComponent(SCOPE)
               + '&prefix=' + encodeURIComponent(SCOPE + '2026/');
    const { context, page } = await freshPage(hash);
    try {
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: 15000 });
      assert.equal(rootLists().length, 0, 'no root list while restoring an in-floor deep link');
    } finally { await context.close(); }
  });

  e2eTest('a deep-link prefix outside the floor is clamped to the floor, said out loud', async () => {
    await seedScoped();
    const hash = '#endpoint=' + encodeURIComponent(ctx.browserEndpoint)
               + '&bucket=' + BUCKET + '&keyId=scoped-key'
               + '&basePrefix=' + encodeURIComponent(SCOPE)
               + '&prefix=' + encodeURIComponent('clients/other/');
    const { context, page } = await freshPage(hash);
    try {
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      // Presence: the floor listing renders (clamped landing).
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: 15000 });
      // The clamp is announced, not silent.
      const bodyText = await page.locator('body').textContent();
      assert.ok(bodyText.includes('outside this connection’s base folder'),
        'the clamp notice must be visible');
      // Absence, next to presence: the out-of-floor prefix was never requested.
      const outOfScope = ctx.mock.requestLog.list().filter((r) => r.isList && r.listPrefix === 'clients/other/');
      assert.equal(outOfScope.length, 0, 'the out-of-floor prefix must never reach the server');
      assert.equal(rootLists().length, 0, 'nor the bucket root');
    } finally { await context.close(); }
  });
});
