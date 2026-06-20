// Browser e2e — credential/profile screen regressions. These are all BUG-LOG entries that shipped
// with "No automated test — DOM-dependent": BUG-018, BUG-020, BUG-026, BUG-027. Mostly disconnected
// screen, so the mock S3 server is only needed for the connect→disconnect flow (BUG-027).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMock, startAppServer, connectApp } from '../harness.mjs';

let ctx, app, browser;
before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await app?.close(); await ctx?.mock.close(); });

async function freshPage() {
  const context = await browser.newContext(); // empty localStorage → no saved profiles/creds
  const page = await context.newPage();
  page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}
async function fillCreds(page, { endpoint, bucket, keyId, secret }) {
  if (endpoint != null) await page.locator('input[type="url"]').fill(endpoint);
  if (bucket != null) await page.locator('input[placeholder="my-bucket"]').fill(bucket);
  if (keyId != null) await page.locator('input[placeholder="Access Key ID"]').fill(keyId);
  if (secret != null) await page.locator('input[placeholder="Secret Access Key"]').fill(secret);
}

// ── BUG-018: "Save as profile…" stays disabled until the form has valid required fields ──
describe('BUG-018 — Save-as-profile enablement', () => {
  test('disabled on an empty form, enabled once endpoint/bucket/keyId are valid', async () => {
    const { context, page } = await freshPage();
    try {
      const trigger = page.locator('.profile-save-trigger');
      await trigger.waitFor({ timeout: 5000 });
      assert.ok(await trigger.isDisabled(), 'disabled with an empty form');
      await fillCreds(page, { endpoint: 'https://s3.example.com', bucket: 'my-bucket', keyId: 'AKIAEXAMPLE' });
      await assert.doesNotReject(trigger.waitFor({ state: 'visible' }));
      // poll for enablement (onFormChange propagates through App → ProfilePicker)
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      assert.ok(!(await trigger.isDisabled()), 'enabled once required fields are valid (BUG-018)');
    } finally { await context.close(); }
  });
});

// ── BUG-020: saving a profile before connecting stores the values and does NOT clear the form ──
describe('BUG-020 — save profile pre-connect', () => {
  test('the saved profile holds the typed values and the form keeps them', async () => {
    const { context, page } = await freshPage();
    try {
      await fillCreds(page, { endpoint: 'https://s3.example.com', bucket: 'realbucket', keyId: 'AKIAREAL', secret: 'sekret' });
      const trigger = page.locator('.profile-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Profile name"]');
      await nameInput.waitFor({ timeout: 5000 });
      await nameInput.fill('My Profile');
      await page.locator('button[type="submit"]:has-text("Save")').click();

      // A profile row now exists…
      await page.locator('.profile-row', { hasText: 'My Profile' }).waitFor({ timeout: 5000 });
      // …and the form was NOT cleared (BUG-020 cleared it and stored empties).
      assert.equal(await page.locator('input[placeholder="my-bucket"]').inputValue(), 'realbucket', 'form retained its values');
      assert.equal(await page.locator('input[type="url"]').inputValue(), 'https://s3.example.com');
    } finally { await context.close(); }
  });
});

// ── BUG-027: after disconnect the form is pre-filled from the selected profile (not blank) ──
describe('BUG-027 — post-disconnect form is populated', () => {
  test('disconnecting leaves the endpoint/bucket/keyId visible for reconnection', async () => {
    ctx.mock.reset();
    const { context, page } = await freshPage();
    try {
      // Save a profile pointing at the mock, then connect with it.
      await fillCreds(page, { endpoint: ctx.browserEndpoint, bucket: 'test-bucket', keyId: 'k', secret: 's' });
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      const trigger = page.locator('.profile-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Profile name"]');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('Mock');
      await page.locator('button[type="submit"]:has-text("Save")').click();
      await page.locator('.profile-row', { hasText: 'Mock' }).waitFor({ timeout: 5000 });

      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-input"]').waitFor({ state: 'attached', timeout: 15000 });

      // Disconnect → the splash returns with the profile's fields pre-filled (minus secret).
      await page.locator('button:has-text("Disconnect")').click();
      await page.locator('input[type="url"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('input[type="url"]').inputValue(), ctx.browserEndpoint, 'endpoint pre-filled after disconnect (BUG-027)');
      assert.equal(await page.locator('input[placeholder="my-bucket"]').inputValue(), 'test-bucket', 'bucket pre-filled');
      assert.ok(await page.locator('.profile-row-selected').count() >= 1, 'the profile stays highlighted');
    } finally { await context.close(); }
  });
});

// ── BUG-026: changing the endpoint after loading a profile re-infers the region ──
describe('BUG-026 — region re-inference after profile load', () => {
  test('a saved B2 profile, reloaded, updates its region when the endpoint changes', async () => {
    const { context, page } = await freshPage();
    try {
      // Save a B2 profile (region auto-inferred from the endpoint).
      await fillCreds(page, { endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'b2bucket', keyId: 'b2key' });
      const trigger = page.locator('.profile-save-trigger');
      const deadline = Date.now() + 5000;
      while (await trigger.isDisabled() && Date.now() < deadline) await page.waitForTimeout(100);
      await trigger.click();
      const nameInput = page.locator('input[placeholder="Profile name"]');
      await nameInput.waitFor({ timeout: 5000 }); await nameInput.fill('B2');
      await page.locator('button[type="submit"]:has-text("Save")').click();
      await page.locator('.profile-row', { hasText: 'B2' }).waitFor({ timeout: 5000 });

      // Reload — the app pre-fills the form from the saved profile (regionOverride set). This is the
      // exact state BUG-026 broke: the region stayed stuck after a profile load.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const regionInput = page.locator('input[placeholder="us-east-1"]');
      await regionInput.waitFor({ timeout: 5000 });
      assert.equal(await regionInput.inputValue(), 'us-west-004', 'region inferred from the loaded B2 endpoint');

      // Change the endpoint to a different B2 region → the region must re-infer.
      await page.locator('input[type="url"]').fill('https://s3.eu-central-003.backblazeb2.com');
      const deadline2 = Date.now() + 5000;
      while (await regionInput.inputValue() !== 'eu-central-003' && Date.now() < deadline2) await page.waitForTimeout(100);
      assert.equal(await regionInput.inputValue(), 'eu-central-003', 'region re-inferred after endpoint change (BUG-026)');
    } finally { await context.close(); }
  });
});
