// Shared e2e harness: boot a mock S3 server, build an S3 client pointed at it, serve the
// built app for browser specs, and connect the UI. Used by both the node-integration layer
// (test/e2e/node/*) and the browser layer (test/e2e/browser/*).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockS3 } from './mock-s3/server.mjs';
import { createS3Client } from '../../src/lib/s3-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUCKET = 'test-bucket';

// Boot a mock S3 server on an ephemeral port and return it plus a real S3 client (built via
// the app's own createS3Client) pointed at it. provider 'minio' forces path-style addressing.
export async function startMock(opts = {}) {
  const mock = createMockS3({ host: '127.0.0.1', ...opts });
  const port = await mock.listen(0);
  const endpoint = `http://127.0.0.1:${port}`;
  // For the browser the app detects 127.0.0.1 as a generic provider → virtual-hosted addressing
  // (test-bucket.127.0.0.1 won't resolve). Chromium resolves *.localhost to loopback, so the
  // browser must use a localhost endpoint; the mock (listening on 127.0.0.1) still receives it.
  const browserEndpoint = `http://localhost:${port}`;
  const client = createS3Client({ endpoint, keyId: 'test', secretKey: 'test', provider: 'minio', regionOverride: 'us-east-1' });
  return { mock, port, endpoint, browserEndpoint, client };
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
