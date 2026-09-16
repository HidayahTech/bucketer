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
import { devices } from 'playwright';
import {
  scaleTimeout,
  startMock,
  startAppServer,
  launchBrowser,
  newE2EContext,
  newE2EPage,
  e2eTest,
  applyEngineQuirks,
  e2eEngineName,
} from '../harness.mjs';

const BUCKET = 'test-bucket';
const SCOPE = 'clients/acme/';

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

// Seed while unscoped (the node-side admin client is "us", not the key under test),
// then turn the scope on and clear the log so assertions see only the app's traffic.
async function seedScoped() {
  ctx.mock.reset();
  await ctx.client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'report.pdf', Body: new TextEncoder().encode('r') }),
  );
  await ctx.client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: 'clients/other/secret.txt', Body: new TextEncoder().encode('x') }),
  );
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
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      // Absence, next to it: the app never asked for the bucket root.
      assert.equal(
        rootLists().length,
        0,
        'no ListObjectsV2 with an empty Prefix may be issued for a scoped connection',
      );
      // The breadcrumb is pinned: the floor leaf, not "root".
      const crumb = await page.locator('.breadcrumb').textContent();
      assert.ok(crumb.includes('acme') && !crumb.includes('root'), 'breadcrumb pinned at the floor');
    } finally {
      await context.close();
    }
  });

  // #65 observable: the failure is SEEN — the error block is inside the viewport and holds
  // focus (v1.62.3 rendered it ~200px below the fold with focus on <body>, so pressing
  // Connect appeared to do nothing) — and its "Set base folder" action lands the user in
  // the field with the field on screen. Geometry and activeElement, not textContent.
  async function assertSeenAndActionable(page, label) {
    await fillConnect(page); // no base folder → initial root list → mock 403
    const block = page.locator('.error-block');
    await block.waitFor({ timeout: scaleTimeout(15000) });
    // The smooth scroll settles within a frame or two; poll geometry rather than sleep.
    await page.waitForFunction(
      () => {
        const r = document.querySelector('.error-block').getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      },
      null,
      { timeout: scaleTimeout(5000) },
    );
    const seen = await page.evaluate(() => {
      const el = document.querySelector('.error-block');
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight, focused: document.activeElement === el };
    });
    assert.ok(
      seen.top < seen.vh && seen.bottom > 0,
      `${label}: error block inside the viewport ${JSON.stringify(seen)}`,
    );
    assert.ok(seen.focused, `${label}: the alert holds focus ${JSON.stringify(seen)}`);
    const text = await block.textContent();
    assert.ok(text.includes('Base folder'), `${label}: the hint names the field`);
    assert.ok(!text.includes('CORS'), `${label}: a parsed 403 must not send the user to CORS`);

    await block.locator('button:has-text("Set base folder")').click();
    await page.waitForFunction(
      () => {
        const f = document.getElementById('cred-baseprefix');
        const r = f.getBoundingClientRect();
        return document.activeElement === f && r.top >= 0 && r.bottom <= window.innerHeight;
      },
      null,
      { timeout: scaleTimeout(5000) },
    );
    // Presence proof that the denial actually happened at the mock:
    assert.ok(rootLists().length >= 1, `${label}: the root list request must have reached the mock and been denied`);
  }

  e2eTest(
    'connecting WITHOUT a Base folder: the denial is seen, focused, and Set base folder lands in the field',
    async () => {
      await seedScoped();
      const { context, page } = await freshPage();
      try {
        await assertSeenAndActionable(page, 'desktop');
      } finally {
        await context.close();
      }
    },
  );

  e2eTest('… and on a Pixel 5 viewport, where the field is a full screen above the error', async () => {
    await seedScoped();
    // applyEngineQuirks: Firefox rejects isMobile; the harness strips it for the lane device
    // and specs that pin their own device must do the same (see issue-3-mobile).
    const context = await newE2EContext(browser, applyEngineQuirks(e2eEngineName(), devices['Pixel 5']));
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      await assertSeenAndActionable(page, 'pixel5');
    } finally {
      await context.close();
    }
  });

  // Negative space: a bad credential is a 403 too, but a base folder cannot fix it, so the
  // hint must stay out of the way. The mock answers the root list with the AWS-convention
  // bad-secret code (B2's actual codes are unverified — see the live-probe item).
  e2eTest('a SignatureDoesNotMatch denial gets no Base folder hint', async () => {
    ctx.mock.reset();
    ctx.mock.configure({
      faults: [
        {
          op: 'ListObjectsV2',
          status: 403,
          code: 'SignatureDoesNotMatch',
          message: 'The request signature we calculated does not match',
        },
      ],
    });
    ctx.mock.requestLog.reset();
    const { context, page } = await freshPage();
    try {
      await fillConnect(page);
      const block = page.locator('.error-block');
      await block.waitFor({ timeout: scaleTimeout(15000) });
      const text = await block.textContent();
      assert.ok(text.includes('key ID or secret key is wrong'), 'the plain cause is stated');
      assert.ok(!text.includes('Base folder'), 'no scope hint for a bad credential');
      assert.equal(await block.locator('button:has-text("Set base folder")').count(), 0);
      assert.ok(rootLists().length >= 1, 'the denied list reached the mock');
    } finally {
      await context.close();
    }
  });

  // #66 observable — the CORS-masked shape. The mock's corsOnErrors:false models the
  // hypothesis that a provider omits CORS headers on error responses; it does not establish
  // that Backblaze B2 does. No e2e coverage: harness cannot represent B2's real
  // denial/CORS behaviour. Provider override MinIO → path-style, so the diagnostics'
  // bucket-hostname probe is skipped and no engine depends on *.localhost resolution.
  e2eTest(
    'a CORS-masked denial with no Base folder still offers Set base folder, and diagnostics name both causes',
    async () => {
      await seedScoped();
      ctx.mock.configure({ corsOnErrors: false });
      const { context, page } = await freshPage();
      try {
        await page.locator('#cred-provider').selectOption('minio');
        await fillConnect(page);
        const block = page.locator('.error-block');
        await block.waitFor({ timeout: scaleTimeout(15000) });
        const text = await block.textContent();
        assert.ok(
          !text.includes('Access Denied'),
          `the denial must be opaque to the browser, got: ${text.slice(0, 80)}`,
        );
        assert.ok(text.includes('two likely causes'), 'the masked two-cause block renders');
        await block.locator('button:has-text("Set base folder")').waitFor({ timeout: scaleTimeout(5000) });
        await block.locator('button:has-text("Run diagnostics")').click();
        await page.waitForFunction(
          () => document.querySelector('.error-block').textContent.includes('both causes above are still open'),
          null,
          { timeout: scaleTimeout(15000) },
        );
        const after = await block.textContent();
        assert.ok(!after.includes('almost certainly'), 'the verdict must not confidently blame CORS');
        // Presence, beside the absence above: the root list did reach the mock and was denied.
        assert.ok(rootLists().length >= 1, 'the root list reached the mock');
      } finally {
        await context.close();
      }
    },
  );
});

// #65: a failed quick-switch names the bucket it tried to open, so a tab click that fails
// reads as "couldn't open that bucket", not as a sign-out.
describe('prefix-scoped keys — quick-switch failure', () => {
  // Rows are labelled by bucket (see profiles.test.mjs), so wait on the bucket name.
  async function saveCurrentAs(page, name, bucket) {
    const trigger = page.locator('.bucket-save-trigger');
    await trigger.waitFor({ timeout: scaleTimeout(5000) });
    const deadline = Date.now() + scaleTimeout(5000);
    while ((await trigger.isDisabled()) && Date.now() < deadline) await page.waitForTimeout(100);
    await trigger.click();
    const nameInput = page.locator('input[placeholder="Name"]');
    await nameInput.waitFor({ timeout: scaleTimeout(5000) });
    await nameInput.fill(name);
    await page.locator('button[type="submit"]:has-text("Save")').click();
    await page.locator('.bucket-row', { hasText: bucket }).waitFor({ timeout: scaleTimeout(5000) });
  }

  // Quick-switch to a saved bucket the way the current viewport offers it: the header tab
  // strip on desktop, the sidebar's bucket row below 640px (the strip is display:none there).
  // Both drive App's switchToConnection.
  async function quickSwitchTo(page, bucket) {
    const tab = page.locator('.connection-tab', { hasText: bucket });
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return;
    }
    await page.locator('button:has-text("☰")').click();
    await page.locator('.bucket-row', { hasText: bucket }).click();
  }

  e2eTest('switching to a saved bucket the key cannot list titles the error with that bucket', async () => {
    await seedScoped();
    const { context, page } = await freshPage();
    try {
      // Two saved connections on the same credential: "other" (no floor, will be denied)
      // and "acme" (floored, works). Connect through "acme" so the secret is cached for
      // the credential, then quick-switch to "other".
      await page.locator('input[type="url"]').fill(ctx.browserEndpoint);
      await page.locator('input[placeholder="my-bucket"]').fill('other-bucket');
      await page.locator('input[placeholder="Access Key ID"]').fill('scoped-key');
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      // Region is part of the credential fingerprint the secret cache is keyed on, so it
      // must be in the saved record too, or the quick-switch finds no cached secret and
      // drops to the form instead of connecting.
      const region0 = page.locator('input[placeholder="us-east-1"]');
      await region0.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await region0.isVisible().catch(() => false)) await region0.fill('us-east-1');
      await saveCurrentAs(page, 'other', 'other-bucket');
      // Saving selects the new record and a second Save would update it in place, so add
      // the second bucket through the account's "+ bucket" path (deselects, keeps the key).
      await page.locator('.account-add-bucket').click();
      await page.locator('input[placeholder="my-bucket"]').fill(BUCKET);
      await page.locator('#cred-baseprefix').fill(SCOPE);
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      await saveCurrentAs(page, 'acme', BUCKET);
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });

      ctx.mock.requestLog.reset();
      await quickSwitchTo(page, 'other-bucket');
      const block = page.locator('.error-block');
      await block.waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(
        (await block.locator('.error-title').textContent()).trim(),
        "Couldn't open other-bucket",
        'the title names the bucket the switch tried to open',
      );
      assert.ok((await block.textContent()).includes('Base folder'), 'the scope hint still applies');
      assert.ok(rootLists().length >= 1, 'the denied root list of the other bucket reached the mock');
    } finally {
      await context.close();
    }
  });

  // #67 observable: a Base folder typed on the failed screen reaches the SAVED record, so a
  // quick-switch back to that connection (which re-resolves the record) lists inside the
  // floor with no root list. A same-tab reload already worked through the flat mirror on
  // pre-fix code, so a reload-based check would be a proxy — this measures the path that
  // looped (QA reproduction 2026-09-16, docs/review-prefix-access/40-qa-plan.md).
  e2eTest('a Base folder set on recovery is saved to the connection, so quick-switch no longer loops', async () => {
    await seedScoped();
    const { context, page } = await freshPage();
    try {
      await page.locator('input[type="url"]').fill(ctx.browserEndpoint);
      await page.locator('input[placeholder="my-bucket"]').fill(BUCKET);
      await page.locator('input[placeholder="Access Key ID"]').fill('scoped-key');
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region0 = page.locator('input[placeholder="us-east-1"]');
      await region0.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await region0.isVisible().catch(() => false)) await region0.fill('us-east-1');
      await saveCurrentAs(page, 'ScopedConn', BUCKET); // record saved with an EMPTY floor
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('.error-block').waitFor({ timeout: scaleTimeout(15000) });
      assert.ok(rootLists().length >= 1, 'precondition: the empty-floor connect was denied at the root');

      // Recover on the failed screen.
      ctx.mock.requestLog.reset();
      await page.locator('#cred-baseprefix').fill(SCOPE);
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      await page.locator('.toast', { hasText: 'Base folder saved to ScopedConn' }).waitFor({
        timeout: scaleTimeout(5000),
      });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('s3b_connections') || '{}'));
      const rec = (stored.connections || []).find((c) => c.name === 'ScopedConn');
      assert.equal(rec?.basePrefix, SCOPE, 'the saved record itself now carries the floor');

      // Quick-switch back to the same connection: re-resolves the record.
      ctx.mock.requestLog.reset();
      await quickSwitchTo(page, BUCKET);
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(rootLists().length, 0, 'no root list on the quick-switch after recovery');
      assert.equal(await page.locator('.error-block').count(), 0, 'no failure after the switch');
    } finally {
      await context.close();
    }
  });
});

describe('prefix-scoped keys — shared link screen', () => {
  e2eTest('a share link carrying basePrefix pre-fills the scope and lists inside it after the secret', async () => {
    await seedScoped();
    const hash =
      '#endpoint=' +
      encodeURIComponent(ctx.browserEndpoint) +
      '&bucket=' +
      BUCKET +
      '&keyId=scoped-key&basePrefix=' +
      encodeURIComponent(SCOPE);
    const { context, page } = await freshPage(hash);
    try {
      // The link supplied everything but the secret — including the Base folder.
      assert.equal(
        await page.locator('#cred-baseprefix').inputValue(),
        SCOPE,
        'basePrefix from the link must pre-fill the Base folder field',
      );
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(rootLists().length, 0, 'no root list on the shared-link path either');
    } finally {
      await context.close();
    }
  });

  e2eTest('an in-floor deep-link prefix lands in that subfolder', async () => {
    await seedScoped();
    await ctx.client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + '2026/inner.txt', Body: new TextEncoder().encode('i') }),
    );
    const hash =
      '#endpoint=' +
      encodeURIComponent(ctx.browserEndpoint) +
      '&bucket=' +
      BUCKET +
      '&keyId=scoped-key' +
      '&basePrefix=' +
      encodeURIComponent(SCOPE) +
      '&prefix=' +
      encodeURIComponent(SCOPE + '2026/');
    const { context, page } = await freshPage(hash);
    try {
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      await page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(rootLists().length, 0, 'no root list while restoring an in-floor deep link');
    } finally {
      await context.close();
    }
  });

  e2eTest('a deep-link prefix outside the floor is clamped to the floor, said out loud', async () => {
    await seedScoped();
    const hash =
      '#endpoint=' +
      encodeURIComponent(ctx.browserEndpoint) +
      '&bucket=' +
      BUCKET +
      '&keyId=scoped-key' +
      '&basePrefix=' +
      encodeURIComponent(SCOPE) +
      '&prefix=' +
      encodeURIComponent('clients/other/');
    const { context, page } = await freshPage(hash);
    try {
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      // Presence: the floor listing renders (clamped landing).
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      // The clamp is announced, not silent.
      const bodyText = await page.locator('body').textContent();
      assert.ok(bodyText.includes('outside this connection’s base folder'), 'the clamp notice must be visible');
      // Absence, next to presence: the out-of-floor prefix was never requested.
      const outOfScope = ctx.mock.requestLog.list().filter((r) => r.isList && r.listPrefix === 'clients/other/');
      assert.equal(outOfScope.length, 0, 'the out-of-floor prefix must never reach the server');
      assert.equal(rootLists().length, 0, 'nor the bucket root');
    } finally {
      await context.close();
    }
  });

  // #68 observable: a slash-less link prefix lands in the FOLDER (normalized), and "New
  // folder" under it composes a child key — on v1.62.3 `#prefix=clients/acme/sub` listed the
  // bare string prefix and New folder → "Reports" PUT `clients/acme/subReports/`.
  e2eTest('a slash-less deep-link prefix is normalized, so New folder creates a child, not a sibling', async () => {
    await seedScoped();
    await ctx.client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'sub/inner.txt', Body: new TextEncoder().encode('i') }),
    );
    const hash =
      '#endpoint=' +
      encodeURIComponent(ctx.browserEndpoint) +
      '&bucket=' +
      BUCKET +
      '&keyId=scoped-key' +
      '&basePrefix=' +
      encodeURIComponent(SCOPE) +
      '&prefix=' +
      encodeURIComponent(SCOPE + 'sub'); // no trailing slash
    const { context, page } = await freshPage(hash);
    try {
      await page.locator('input[placeholder="Secret Access Key"]').fill('s');
      const region = page.locator('input[placeholder="us-east-1"]');
      if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
      await page.locator('button[type="submit"]:has-text("Connect")').click();
      // Presence: the folder's own row renders, i.e. the listing asked for `…/sub/`.
      await page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      const lists = ctx.mock.requestLog.list().filter((r) => r.isList);
      assert.ok(
        lists.some((r) => r.listPrefix === SCOPE + 'sub/'),
        'the listing must use the normalized folder',
      );
      assert.ok(!lists.some((r) => r.listPrefix === SCOPE + 'sub'), 'never the bare string prefix');

      await page.locator('button[title="Create a new folder"]').click();
      const nameInput = page.locator('.modal-overlay input.form-input');
      await nameInput.waitFor({ timeout: scaleTimeout(5000) });
      await nameInput.fill('Reports');
      await nameInput.press('Enter');
      await page.locator('[data-testid="folder-row:Reports"]').waitFor({ timeout: scaleTimeout(10000) });
      const puts = ctx.mock.requestLog.list().filter((r) => r.method === 'PUT');
      assert.ok(
        puts.some((r) => decodeURIComponent(r.path).endsWith('/' + SCOPE + 'sub/Reports/')),
        `New folder must land under the folder; PUTs: ${puts.map((r) => r.path).join(', ')}`,
      );
      assert.ok(!puts.some((r) => decodeURIComponent(r.path).includes('subReports')), 'never a sibling key');
    } finally {
      await context.close();
    }
  });
});

// #69 observable: a folder link copied from inside a folder, opened by a recipient who
// supplies their own key, lands INSIDE that folder — a row from the folder renders and the
// mock saw no root (or floor-only) listing. The clipboard is stubbed on the context so the
// copied text is readable on every engine without clipboard-read permissions.
describe('folder links (#69)', () => {
  async function pageWithClipboardStub(hash = '') {
    const context = await newE2EContext(browser);
    await context.addInitScript(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => void (window.__copied = t) },
      });
    });
    const page = await newE2EPage(context);
    await page.goto(app.url + hash, { waitUntil: 'domcontentloaded' });
    return { context, page };
  }

  async function seedWithSub() {
    await seedScoped();
    await ctx.client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: SCOPE + 'sub/inner.txt', Body: new TextEncoder().encode('i') }),
    );
    ctx.mock.requestLog.reset();
  }

  async function openAsRecipient(url) {
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // The link supplies everything but the key: the recipient brings their own.
    await page.locator('input[placeholder="Access Key ID"]').fill('scoped-key');
    await page.locator('input[placeholder="Secret Access Key"]').fill('s');
    const region = page.locator('input[placeholder="us-east-1"]');
    if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
    await page.locator('button[type="submit"]:has-text("Connect")').click();
    return { context, page };
  }

  e2eTest('the breadcrumb button copies a link that opens the recipient inside the folder', async () => {
    await seedWithSub();
    const { context, page } = await pageWithClipboardStub();
    let url;
    try {
      await fillConnect(page, { baseFolder: SCOPE });
      await page.locator('[data-testid="folder-row:sub"]').click();
      await page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      await page.locator('[data-testid="crumb-copy-link"]').click();
      await page.locator('.toast', { hasText: 'Link copied — opens at ' + SCOPE + 'sub/' }).waitFor({
        timeout: scaleTimeout(5000),
      });
      url = await page.evaluate(() => window.__copied);
      const p = new URLSearchParams(url.split('#')[1]);
      assert.equal(p.get('prefix'), SCOPE + 'sub/', 'the link carries the folder');
      assert.equal(p.get('basePrefix'), SCOPE, 'and the floor');
      assert.equal(p.get('keyId'), null, 'and no key ID unless asked');
    } finally {
      await context.close();
    }

    ctx.mock.requestLog.reset();
    const recipient = await openAsRecipient(url);
    try {
      await recipient.page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      const lists = ctx.mock.requestLog.list().filter((r) => r.isList);
      assert.ok(
        lists.some((r) => r.listPrefix === SCOPE + 'sub/'),
        'the recipient listed the folder',
      );
      assert.equal(rootLists().length, 0, 'never the bucket root');
      assert.ok(!lists.some((r) => r.listPrefix === SCOPE), 'and did not land at the floor first');
    } finally {
      await recipient.context.close();
    }
  });

  e2eTest('the header menu offers the same folder link, and the top item omits the folder', async () => {
    await seedWithSub();
    const { context, page } = await pageWithClipboardStub();
    try {
      await fillConnect(page, { baseFolder: SCOPE });
      await page.locator('[data-testid="folder-row:sub"]').click();
      await page.locator('[data-testid="file-row:inner.txt"]').waitFor({ timeout: scaleTimeout(15000) });
      await page.locator('button:has-text("Copy link")').click();
      await page.locator('[data-testid="share-link-folder"]').click();
      const folderLink = await page.evaluate(() => window.__copied);
      assert.equal(new URLSearchParams(folderLink.split('#')[1]).get('prefix'), SCOPE + 'sub/');
      await page.locator('button:has-text("Copy link")').click();
      await page.locator('[data-testid="share-link-top"]').click();
      const topLink = await page.evaluate(() => window.__copied);
      assert.equal(new URLSearchParams(topLink.split('#')[1]).get('prefix'), null, 'top link carries no folder');
      await page
        .locator('.toast', { hasText: 'opens at the top of ' + SCOPE })
        .waitFor({ timeout: scaleTimeout(5000) });
    } finally {
      await context.close();
    }
  });

  e2eTest('no breadcrumb link button at the floor', async () => {
    await seedWithSub();
    const { context, page } = await pageWithClipboardStub();
    try {
      await fillConnect(page, { baseFolder: SCOPE });
      await page.locator('[data-testid="file-row:report.pdf"]').waitFor({ timeout: scaleTimeout(15000) });
      assert.equal(await page.locator('[data-testid="crumb-copy-link"]').count(), 0);
    } finally {
      await context.close();
    }
  });
});
