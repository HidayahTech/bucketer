// Shared e2e harness: boot a mock S3 server, build an S3 client pointed at it, serve the
// built app for browser specs, and connect the UI. Used by both the node-integration layer
// (test/e2e/node/*) and the browser layer (test/e2e/browser/*).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockS3 } from './mock-s3/server.mjs';
import { ensureTlsCert } from './tls-cert.mjs';
import { createS3Client } from '../../src/lib/s3-client.js';
import { chromium, firefox, webkit, devices } from 'playwright';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyEngineQuirks, skipReasonFor } from './engine-quirks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUCKET = 'test-bucket';

// ── Cross-engine + mobile matrix ────────────────────────────────────────────
// Browser specs launch via launchBrowser()/newE2EContext() instead of hardcoding
// chromium, so the whole suite runs across engines and device profiles. The engine
// and device are selected by env vars the matrix runner (run.mjs) sets:
//   E2E_ENGINE = chromium | firefox | webkit   (default chromium)
//   E2E_DEVICE = a playwright.devices key, e.g. "Pixel 5" / "iPhone 13"  (default desktop)
const ENGINES = { chromium, firefox, webkit };

export function e2eEngineName() { return process.env.E2E_ENGINE || 'chromium'; }

export function e2eDeviceName() { return process.env.E2E_DEVICE || null; }

// Launch the selected engine. Throws if the engine's binary/deps are missing (e.g. WebKit on
// a stock host — see GitLab #47); in CI the Playwright image ships all three engines + deps.
export function launchBrowser(opts = {}) {
  const name = e2eEngineName();
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Unknown E2E_ENGINE "${name}" (use chromium|firefox|webkit)`);
  return engine.launch({ headless: true, ...opts });
}

// New context, applying the selected mobile device profile (viewport, UA, touch) when set.
export function newE2EContext(browser, extra = {}) {
  const dev = e2eDeviceName();
  const profile = dev ? devices[dev] : null;
  if (dev && !profile) throw new Error(`Unknown E2E_DEVICE "${dev}"`);
  // ignoreHTTPSErrors: the mock's https listener uses a boot-generated self-signed cert
  // (test/e2e/tls-cert.mjs); trusting it per-context beats installing it in a trust store.
  return browser.newContext(applyEngineQuirks(e2eEngineName(), profile, { ignoreHTTPSErrors: true, ...extra }));
}

// Re-export so specs that pin their own device (e.g. issue-3-mobile) get the firefox fix too.
export { applyEngineQuirks };

// Boot a mock S3 server on an ephemeral port and return it plus a real S3 client (built via
// the app's own createS3Client) pointed at it. provider 'minio' forces path-style addressing.
export async function startMock(opts = {}) {
  const mock = createMockS3({ host: '127.0.0.1', ...opts });
  const port = await mock.listen(0);
  // The https listener exists because the app's CSP treats transports differently
  // (frame-src) and production endpoints are https — the http-only harness is what let
  // BUG-052 pass unnoticed. Both stay: http is a supported real-world configuration
  // (MinIO on a LAN) and the node-layer SDK client keeps using it.
  const tlsPort = await mock.listenTls(0, ensureTlsCert());
  const endpoint = `http://127.0.0.1:${port}`;
  // For the browser the app detects 127.0.0.1 as a generic provider → virtual-hosted addressing
  // (test-bucket.127.0.0.1 won't resolve). Chromium resolves *.localhost to loopback, so the
  // browser must use a localhost endpoint; the mock (listening on 127.0.0.1) still receives it.
  const browserEndpoint = `http://localhost:${port}`;
  const httpsBrowserEndpoint = `https://localhost:${tlsPort}`;
  const client = createS3Client({ endpoint, keyId: 'test', secretKey: 'test', provider: 'minio', regionOverride: 'us-east-1' });
  return { mock, port, tlsPort, endpoint, browserEndpoint, httpsBrowserEndpoint, client };
}

// Serve the built app for browser specs. The e2e runner builds to perf/ (gitignored) so the
// committed dist/index.html stays pristine; fall back to dist/ if perf/ isn't present.
export async function startAppServer() {
  const perf = join(ROOT, 'perf', 'index.html');
  const html = readFileSync(existsSync(perf) ? perf : join(ROOT, 'dist', 'index.html'), 'utf8');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// Fill the credential form and connect, then wait for the connected browser UI. Reusable across
// browser specs. Robust connected-state signal: the upload file input (the old .upload-zone
// selector was removed from the connected UI in v1.15.3).
export async function connectApp(page, endpoint, bucket = BUCKET) {
  await page.locator('input[type="url"]').fill(endpoint);
  await page.locator('input[placeholder="my-bucket"]').fill(bucket);
  await page.locator('input[placeholder="Access Key ID"]').fill('test-key-id');
  await page.locator('input[placeholder="Secret Access Key"]').fill('test-secret-key');
  const region = page.locator('input[placeholder="us-east-1"]');
  await region.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await region.isVisible().catch(() => false)) await region.fill('us-east-1');
  await page.locator('button[type="submit"]').click();
  await page.locator('[data-testid="file-input"]').waitFor({ state: 'attached', timeout: 15000 });
}

// Download observation. Playwright fires 'download' when a navigation is taken over by
// the download manager — including navigations of hidden iframes (verified in the
// 2026-08-01 postmortem's discriminator experiment). WebKit does not fire it; specs fall
// back to the mock's request log there. This helper is the presence-assertion side of the
// harness: an e2e that only asserts an absence ("nothing navigated") passes just as
// happily when the feature is inert (BUG-052).
export function collectDownloads(page) {
  const names = [];
  page.on('download', (d) => names.push(d.suggestedFilename()));
  return {
    names: () => names.slice(),
    // Resolve once n downloads have been seen, or throw naming the shortfall — the
    // shortfall count IS the finding, so it belongs in the error message.
    waitForCount(n, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      return (async () => {
        while (names.length < n) {
          if (Date.now() > deadline) {
            throw new Error(`expected ${n} downloads, saw ${names.length} after ${timeoutMs}ms: [${names.join(', ')}]`);
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      })();
    },
    // Fixed grace period for stragglers, for arms where the count itself is the assertion.
    settle(ms = 3000) { return new Promise((r) => setTimeout(r, ms)); },
  };
}

// Playwright cannot drive a real showDirectoryPicker (it needs a user gesture and a
// native dialog), so verification specs install a stub that yields a synthetic folder.
// addInitScript, not evaluate: browser-capability.js feature-detects the picker at app
// load, so the stub must exist BEFORE the bundle runs or the verify UI never renders.
// `files` is [{ name, size }]; getFile() exposes only .size, which is all readFolder uses.
export function installFakeDirectoryPicker(page, files) {
  return page.addInitScript((list) => {
    // Both halves of the real FileSystemDirectoryHandle surface that verification uses:
    // values() for the streaming collision pass, getFileHandle() for per-item lookups.
    const byName = new Map(list.map((f) => [f.name, f.size]));
    window.showDirectoryPicker = async () => ({
      values: async function* () {
        for (const [name, size] of byName) yield { kind: 'file', name, getFile: async () => ({ size }) };
      },
      getFileHandle: async (name) => {
        if (!byName.has(name)) throw new DOMException(name, 'NotFoundError');
        return { getFile: async () => ({ size: byName.get(name) }) };
      },
    });
  }, files);
}

export function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try { const c = new AbortController(); const id = setTimeout(() => c.abort(), 1000); await fetch(url, { signal: c.signal }); clearTimeout(id); return; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for ${url}`);
  })();
}

// ── Failure capture + e2eTest wrapper ───────────────────────────────────────
// node:test has no per-test "on failure" hook (unlike @playwright/test), so specs run each
// test through e2eTest(): on a thrown assertion it writes the active page's screenshot +
// buffered console log to test/e2e/artifacts/ (git-ignored; CI collects it), then re-throws.
export const ARTIFACTS_DIR = join(ROOT, 'test', 'e2e', 'artifacts');

let _activePage = null;
let _activeLogs = [];

// Create the page, register it as active for failure capture, and buffer console/page errors.
export async function newE2EPage(context) {
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  _activePage = page;
  _activeLogs = logs;
  return page;
}

function slug(name) {
  const dev = e2eDeviceName();
  const suffix = `${e2eEngineName()}${dev ? '-' + dev : ''}`;
  return `${name}-${suffix}`.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
}

// Write the console log (always) + a best-effort screenshot (the page may be closed already
// if a spec closes its context in a finally before the throw propagates here).
export async function captureFailure(basename, page, logs, dir = ARTIFACTS_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename}.log`), (logs || []).join('\n') + '\n');
  try { if (page) await page.screenshot({ path: join(dir, `${basename}.png`), fullPage: true }); }
  catch { /* page closed / screenshot unavailable — the log is enough */ }
}

// opts.skipOn = { engineName: 'documented reason' } skips the test on that engine
// (surfaced as a skip with its reason in TAP/JUnit, not a silent pass). Use for
// engine-specific emulation gaps — see GitLab #48.
export function e2eTest(name, fn, opts = {}) {
  const skipReason = skipReasonFor(e2eEngineName(), opts.skipOn);
  if (skipReason) {
    test(name, { skip: skipReason }, () => {});
    return;
  }
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      await captureFailure(slug(name), _activePage, _activeLogs);
      throw err;
    }
  });
}
