// Browser e2e — credential/profile screen regressions. These are all BUG-LOG entries that shipped
// with "No automated test — DOM-dependent": BUG-018, BUG-020, BUG-026, BUG-027. Mostly disconnected
// screen, so the mock S3 server is only needed for the connect→disconnect flow (BUG-027).
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, startAppServer, connectApp, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function freshPage() {
  const context = await newE2EContext(browser); // empty localStorage → no saved profiles/creds
  const page = await newE2EPage(context);
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}
async function fillCreds(page, { endpoint, bucket, keyId, secret }) {
  if (endpoint != null) await page.locator('input[type="url"]').fill(endpoint);
  if (bucket != null) await page.locator('input[placeholder="my-bucket"]').fill(bucket);
  if (keyId != null) await page.locator('input[placeholder="Access Key ID"]').fill(keyId);
  if (secret != null) await page.locator('input[placeholder="Secret Access Key"]').fill(secret);
}

// ── BUG-047: a share link's details must survive a disconnect ──────────────────
// Reported in production. Every deep-link parameter lives in the URL fragment by
// design, so re-entering the link cannot recover it — a fragment-only navigation
// never reloads the page. Disconnecting therefore had to stop blanking a form the
// URL still describes, because the user has no way to get those values back.
describe('BUG-047 — a share link survives disconnect', () => {
  e2eTest('after disconnecting, the form still shows the connection details from the URL', async () => {
    ctx.mock.reset();
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      const hash = '#endpoint=' + encodeURIComponent(ctx.browserEndpoint)
                 + '&bucket=test-bucket&keyId=k';
      await page.goto(app.url + hash, { waitUntil: 'domcontentloaded' });

      // The link supplies everything but the secret, which is the whole point of it.
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-input"]').waitFor({ state: 'attached', timeout: 15000 });

      await page.locator('button:has-text("Disconnect")').click();
      await page.locator('input[type="url"]').waitFor({ timeout: 5000 });

      assert.equal(await page.locator('input[type="url"]').inputValue(), ctx.browserEndpoint,
        'endpoint from the share link must survive disconnect (BUG-047)');
      assert.equal(await page.locator('input[placeholder="my-bucket"]').inputValue(), 'test-bucket',
        'bucket from the share link must survive disconnect (BUG-047)');
      assert.equal(await page.locator('input[placeholder="Access Key ID"]').inputValue(), 'k',
        'key ID from the share link must survive disconnect (BUG-047)');
    } finally { await context.close(); }
  });
});

// ── BUG-018: "Save as profile…" stays disabled until the form has valid required fields ──
describe('BUG-018 — Save-as-profile enablement', () => {
  e2eTest('disabled on an empty form, enabled once endpoint/bucket/keyId are valid', async () => {
    const { context, page } = await freshPage();
    try {
      const trigger = page.locator('.bucket-save-trigger');
      await trigger.waitFor({ timeout: 5000 });
      assert.ok(await trigger.isDisabled(), 'disabled with an empty form');
      await fillCreds(page, { endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'AKIAEXAMPLE' });
      await assert.doesNotReject(trigger.waitFor({ state: 'visible' }));
      // poll for enablement (onFormChange propagates through App → AccountsManager)
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      assert.ok(!(await trigger.isDisabled()), 'enabled once required fields are valid (BUG-018)');
    } finally { await context.close(); }
  });
});

// ── BUG-020: saving a profile before connecting stores the values and does NOT clear the form ──
describe('BUG-020 — save profile pre-connect', () => {
  e2eTest('the saved profile holds the typed values and the form keeps them', async () => {
    const { context, page } = await freshPage();
    try {
      await fillCreds(page, { endpoint: 'https://s3.example.com', bucket: 'realbucket', keyId: 'AKIAREAL', secret: 'sekret' });
      const trigger = page.locator('.bucket-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Name"]');
      await nameInput.waitFor({ timeout: 5000 });
      await nameInput.fill('My Profile');
      await page.locator('button[type="submit"]:has-text("Save")').click();

      // A profile row now exists…
      await page.locator('.bucket-row', { hasText: 'realbucket' }).waitFor({ timeout: 5000 });
      // …and the form was NOT cleared (BUG-020 cleared it and stored empties).
      assert.equal(await page.locator('input[placeholder="my-bucket"]').inputValue(), 'realbucket', 'form retained its values');
      assert.equal(await page.locator('input[type="url"]').inputValue(), 'https://s3.example.com');
    } finally { await context.close(); }
  });
});

// ── BUG-027: after disconnect the form is pre-filled from the selected profile (not blank) ──
describe('BUG-027 — post-disconnect form is populated', () => {
  e2eTest('disconnecting leaves the endpoint/bucket/keyId visible for reconnection', async () => {
    ctx.mock.reset();
    const { context, page } = await freshPage();
    try {
      // Save a profile pointing at the mock, then connect with it.
      await fillCreds(page, { endpoint: ctx.browserEndpoint, bucket: 'test-bucket', keyId: 'k', secret: 's' });
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      const trigger = page.locator('.bucket-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Name"]');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('Mock');
      await page.locator('button[type="submit"]:has-text("Save")').click();
      await page.locator('.bucket-row', { hasText: 'test-bucket' }).waitFor({ timeout: 5000 });

      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-input"]').waitFor({ state: 'attached', timeout: 15000 });

      // Disconnect → the splash returns with the profile's fields pre-filled (minus secret).
      await page.locator('button:has-text("Disconnect")').click();
      await page.locator('input[type="url"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('input[type="url"]').inputValue(), ctx.browserEndpoint, 'endpoint pre-filled after disconnect (BUG-027)');
      assert.equal(await page.locator('input[placeholder="my-bucket"]').inputValue(), 'test-bucket', 'bucket pre-filled');
      assert.ok(await page.locator('.bucket-row-selected').count() >= 1, 'the profile stays highlighted');
    } finally { await context.close(); }
  });
});

// ── BUG-026: changing the endpoint after loading a profile re-infers the region ──
describe('BUG-026 — region re-inference after profile load', () => {
  e2eTest('a saved B2 profile, reloaded, updates its region when the endpoint changes', async () => {
    const { context, page } = await freshPage();
    try {
      // Save a B2 profile (region auto-inferred from the endpoint).
      await fillCreds(page, { endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'b2bucket', keyId: 'b2key' });
      const trigger = page.locator('.bucket-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Name"]');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('B2');
      await page.locator('button[type="submit"]:has-text("Save")').click();
      await page.locator('.bucket-row', { hasText: 'b2bucket' }).waitFor({ timeout: 5000 });

      // Reload — the app pre-fills the form from the saved profile (regionOverride set). This is the
      // exact state BUG-026 broke: the region stayed stuck after a profile load.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const regionInput = page.locator('input[placeholder="us-east-1"]');
      await regionInput.waitFor({ timeout: 5000 });

      // The pre-fill is asynchronous. On a slow lane, filling the endpoint BEFORE the
      // pre-fill lands lets the pre-fill overwrite it right back — the region then stays
      // us-west-004 and the final assertion flakes (seen repeatedly on CI shared runners,
      // issue #55). Wait for the pre-fill to have settled: the url field must show the
      // saved endpoint first.
      const urlInput = page.locator('input[type="url"]');
      const settle = Date.now() + 10000;
      while (await urlInput.inputValue() !== 'https://s3.us-west-004.backblazeb2.com' && Date.now() < settle) {
        await page.waitForTimeout(100);
      }
      assert.equal(await regionInput.inputValue(), 'us-west-004', 'region inferred from the loaded B2 endpoint');

      // Change the endpoint to a different B2 region → the region must re-infer.
      await urlInput.fill('https://s3.eu-central-003.backblazeb2.com');
      const deadline2 = Date.now() + 10000;
      while (await regionInput.inputValue() !== 'eu-central-003' && Date.now() < deadline2) await page.waitForTimeout(100);
      assert.equal(await regionInput.inputValue(), 'eu-central-003', 'region re-inferred after endpoint change (BUG-026)');
    } finally { await context.close(); }
  });
});
