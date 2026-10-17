// Browser e2e: "Clear all app data" must remove every app-owned store (GitLab #78 / R05).
// It cleared the s3b_* keys and IndexedDB but left OPFS ZIP staging (real downloaded object
// bytes — completed ZIP downloads also leave theirs) and the bucketer:mtime:* keys (bucket
// and object names). Observable, after the real UI wipe and its reload: the OPFS directory
// listing and the localStorage keys. Absence (app files gone) is asserted next to presence
// (another feature's OPFS file and localStorage key on the same origin survive, and the
// s3b_ key the wipe has always cleared is gone).
//
// Harness fidelity: WebKit in this harness exposes no OPFS (navigator.storage is undefined
// on the http app origin) and the app gates its OPFS features off there, so that lane checks
// the localStorage half only; the OPFS half is covered by the Chromium and Firefox lanes.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scaleTimeout, startAppServer, launchBrowser, newE2EContext, newE2EPage, e2eTest } from '../harness.mjs';

let app, browser;
before(async () => {
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const OPFS_FIXTURES = ['bucketer-tmp-p0', 'bucketer-zip-review-fixture.zip', 'other-feature.bin'];

const opfsNames = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out = [];
    for await (const name of root.keys()) out.push(name);
    return out.sort();
  });

describe('#78 — Clear all app data clears OPFS staging and the mtime cache', () => {
  e2eTest('after the wipe and reload, no bucketer OPFS files or mtime keys remain; foreign data survives', async () => {
    const context = await newE2EContext(browser);
    const page = await newE2EPage(context);
    try {
      await page.goto(app.url, { waitUntil: 'domcontentloaded' });
      const hasOpfs = await page.evaluate(() => typeof navigator.storage?.getDirectory === 'function');
      await page.evaluate(
        async ({ hasOpfs, names }) => {
          if (hasOpfs) {
            const root = await navigator.storage.getDirectory();
            for (const name of names) {
              const h = await root.getFileHandle(name, { create: true });
              try {
                const w = await h.createWritable();
                await w.write('private object bytes');
                await w.close();
              } catch {
                /* an empty file still proves the name survives or not */
              }
            }
          }
          localStorage.setItem('bucketer:mtime:review-bucket:private-name.txt:1', '2026-01-01');
          localStorage.setItem('s3b_endpoint', 'https://example.test');
          localStorage.setItem('someone-elses-key', 'keep me');
        },
        { hasOpfs, names: OPFS_FIXTURES },
      );
      if (hasOpfs) assert.deepEqual(await opfsNames(page), OPFS_FIXTURES, 'precondition: fixtures seeded');

      await page.locator('button.footer-link-btn', { hasText: 'Storage & Privacy' }).click();
      await page.locator('button', { hasText: 'Clear all app data' }).click();
      await Promise.all([
        page.waitForEvent('load', { timeout: scaleTimeout(15000) }),
        page.locator('button', { hasText: 'Yes, clear everything' }).click(),
      ]);
      await page.waitForLoadState('domcontentloaded');

      const ls = await page.evaluate(() => Object.keys(localStorage).sort());
      assert.ok(!ls.includes('s3b_endpoint'), 'control: the wipe ran (s3b_ key cleared)');
      assert.ok(!ls.some((k) => k.startsWith('bucketer:mtime:')), `mtime keys must be gone; got ${JSON.stringify(ls)}`);
      assert.ok(ls.includes('someone-elses-key'), 'another feature’s localStorage key survives');
      if (hasOpfs)
        assert.deepEqual(await opfsNames(page), ['other-feature.bin'], 'only the foreign OPFS file survives');
    } finally {
      await context.close();
    }
  });
});
