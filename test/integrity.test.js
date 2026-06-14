// Copyright (C) 2026 HidayahTech, LLC
// Unit tests for src/lib/integrity.js — the in-app honest-host integrity check.
//
// The library is dependency-injected (fetchFn, subtleDigest) so it is fully
// testable in Node without jsdom or a real crypto subtle.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyIntegrity } from '../src/lib/integrity.js';

// ── Test doubles ────────────────────────────────────────────────────────────
function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, handler] of routes) {
      if (typeof pattern === 'string' ? url === pattern : pattern.test(url)) {
        return handler();
      }
    }
    throw new Error(`no route matched ${url}`);
  };
}

function okResponse(body, opts = {}) {
  return {
    ok: true,
    status: opts.status ?? 200,
    arrayBuffer: async () => body,
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    text: async () => new TextDecoder().decode(body),
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    arrayBuffer: async () => { throw new Error('not ok'); },
    json: async () => { throw new Error('not ok'); },
    text: async () => '',
  };
}

function utf8(s) { return new TextEncoder().encode(s).buffer; }
function nodeSha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

// subtleDigest takes (algo, ArrayBuffer) and returns an ArrayBuffer of the hash.
// We back it with Node's crypto so tests don't need a real WebCrypto.
const fakeSubtle = {
  digest: async (algo, buf) => {
    if (algo !== 'SHA-256') throw new Error(`unsupported algo: ${algo}`);
    const hex = createHash('sha256').update(Buffer.from(buf)).digest('hex');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out.buffer;
  },
};

const PAGE_URL = 'https://bucketer.example.test/';
const VERSION  = '1.21.1';
const MANIFEST_URL_RE = /packages\/generic\/bucketer\/1\.21\.1\/bucketer-v1\.21\.1\.integrity\.json/;

describe('verifyIntegrity — match', () => {
  test('returns status:match when page sha256 equals manifest sha256', async () => {
    const pageBytes = utf8('<html>hello world</html>');
    const expected = nodeSha256(new Uint8Array(pageBytes));
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { sha256: expected },
    });

    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(pageBytes)],
      [MANIFEST_URL_RE, () => okResponse(utf8(manifest))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'match');
    assert.equal(result.algorithm, 'sha256');
    assert.equal(result.hash, expected);
    assert.equal(result.version, VERSION);
  });
});

describe('verifyIntegrity — mismatch', () => {
  test('returns status:mismatch with both hashes when they differ', async () => {
    const pageBytes = utf8('<html>real page</html>');
    const actual = nodeSha256(new Uint8Array(pageBytes));
    const wrongHash = '0'.repeat(64);
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { sha256: wrongHash },
    });

    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(pageBytes)],
      [MANIFEST_URL_RE, () => okResponse(utf8(manifest))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.algorithm, 'sha256');
    assert.equal(result.actual, actual);
    assert.equal(result.expected, wrongHash);
  });
});

describe('verifyIntegrity — no manifest', () => {
  test('returns status:no-manifest when manifest fetch returns 404', async () => {
    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(utf8('<html></html>'))],
      [MANIFEST_URL_RE, () => errorResponse(404)],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'no-manifest');
    assert.equal(result.version, VERSION);
  });
});

describe('verifyIntegrity — network errors', () => {
  test('returns status:network-error when page fetch throws', async () => {
    const fetchFn = mockFetch([
      [PAGE_URL, () => { throw new TypeError('Failed to fetch'); }],
      [MANIFEST_URL_RE, () => okResponse(utf8('{}'))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'network-error');
    assert.ok(result.message);
  });

  test('returns status:network-error when manifest fetch throws', async () => {
    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(utf8('<html></html>'))],
      [MANIFEST_URL_RE, () => { throw new TypeError('CORS error'); }],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'network-error');
  });

  test('returns status:network-error on non-404 manifest HTTP error (e.g. 500)', async () => {
    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(utf8('<html></html>'))],
      [MANIFEST_URL_RE, () => errorResponse(500)],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'network-error');
  });

  test('returns status:network-error on malformed manifest JSON', async () => {
    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(utf8('<html></html>'))],
      [MANIFEST_URL_RE, () => okResponse(utf8('not json at all'))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'network-error');
  });
});

describe('verifyIntegrity — algorithm selection', () => {
  test('returns status:unknown-algorithm when manifest has only unknown algorithms', async () => {
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { blake3: '0'.repeat(64), sha3_256: '0'.repeat(64) },
    });

    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(utf8('<html></html>'))],
      [MANIFEST_URL_RE, () => okResponse(utf8(manifest))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'unknown-algorithm');
    assert.deepEqual(result.algorithms.sort(), ['blake3', 'sha3_256'].sort());
  });

  test('prefers sha256 over future algorithms when both are present', async () => {
    const pageBytes = utf8('<html>page</html>');
    const sha256 = nodeSha256(new Uint8Array(pageBytes));
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { sha256, blake3: 'unused' },
    });

    const fetchFn = mockFetch([
      [PAGE_URL, () => okResponse(pageBytes)],
      [MANIFEST_URL_RE, () => okResponse(utf8(manifest))],
    ]);

    const result = await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(result.status, 'match');
    assert.equal(result.algorithm, 'sha256');
  });
});

describe('verifyIntegrity — request shape', () => {
  test('page fetch uses cache:no-store to bypass HTTP cache', async () => {
    let pageInit = null;
    const pageBytes = utf8('<html></html>');
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { sha256: nodeSha256(new Uint8Array(pageBytes)) },
    });
    const fetchFn = async (url, init) => {
      if (url === PAGE_URL) { pageInit = init; return okResponse(pageBytes); }
      return okResponse(utf8(manifest));
    };

    await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.equal(pageInit?.cache, 'no-store',
      'page self-fetch must bypass cache so we hash the served bytes, not a cached snapshot');
  });

  test('manifest URL targets the GitLab Generic Package Registry for the given version', async () => {
    let manifestUrl = null;
    const pageBytes = utf8('<html></html>');
    const manifest = JSON.stringify({
      version: VERSION,
      filename: `bucketer-v${VERSION}.html`,
      hashes: { sha256: nodeSha256(new Uint8Array(pageBytes)) },
    });
    const fetchFn = async (url) => {
      if (url === PAGE_URL) return okResponse(pageBytes);
      manifestUrl = url;
      return okResponse(utf8(manifest));
    };

    await verifyIntegrity({ version: VERSION, pageUrl: PAGE_URL, fetchFn, subtle: fakeSubtle });
    assert.ok(manifestUrl.startsWith('https://gitlab.com/api/v4/projects/hidayahtech%2Fbucketer/packages/generic/bucketer/'),
      `manifest URL must point at the project's GitLab Generic Package Registry, got: ${manifestUrl}`);
    assert.ok(manifestUrl.endsWith(`/${VERSION}/bucketer-v${VERSION}.integrity.json`),
      `manifest URL must follow bucketer-v{VERSION}.integrity.json convention, got: ${manifestUrl}`);
  });
});
