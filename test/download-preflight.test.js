// Copyright (C) 2026 HidayahTech, LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeUrl, blockedMessage, PROBE_KIND,
} from '../src/lib/download-preflight.js';

const responding = (init) => {
  const fn = async (url, opts) => {
    fn.lastUrl = url;
    fn.lastOpts = opts;
    return { ok: init.status < 400, status: init.status };
  };
  return fn;
};

describe('probeUrl', () => {
  test('asks for a single byte so the check costs nothing', async () => {
    const fetchImpl = responding({ status: 206 });
    await probeUrl('https://example.invalid/k', { fetchImpl });

    assert.equal(fetchImpl.lastOpts.headers.Range, 'bytes=0-0');
  });

  test('uses the presigned url unmodified', async () => {
    // Signature covers the query string; appending or reordering anything invalidates it.
    const fetchImpl = responding({ status: 206 });
    const url = 'https://b.example.invalid/k?X-Amz-Signature=abc&X-Amz-Date=1';
    await probeUrl(url, { fetchImpl });

    assert.equal(fetchImpl.lastUrl, url);
  });

  test('treats 206 as readable', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 206 }) });
    assert.equal(r.kind, PROBE_KIND.OK);
  });

  test('treats 200 as readable, for a server that ignores Range', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 200 }) });
    assert.equal(r.kind, PROBE_KIND.OK);
  });

  test('treats 416 as readable: a zero-byte object cannot satisfy bytes=0-0', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 416 }) });
    assert.equal(r.kind, PROBE_KIND.OK, 'an empty object is present and readable, not a failure');
  });

  test('classifies 403 as denied', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 403 }) });
    assert.equal(r.kind, PROBE_KIND.DENIED);
  });

  test('classifies 404 as missing', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 404 }) });
    assert.equal(r.kind, PROBE_KIND.MISSING);
  });

  test('classifies 503 as transient', async () => {
    const r = await probeUrl('u', { fetchImpl: responding({ status: 503 }) });
    assert.equal(r.kind, PROBE_KIND.TRANSIENT);
  });

  test('classifies a thrown fetch as a network failure', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    const r = await probeUrl('u', { fetchImpl });

    assert.equal(r.kind, PROBE_KIND.NETWORK);
    assert.match(r.message, /Failed to fetch/);
  });
});

// Blocking semantics (what stops a whole job vs fails one file) are the engine's
// business and are tested behaviorally in download-queue.test.js.

// A job that stops has to tell the user something they can act on. The two blocking kinds
// have completely different remedies, so they must not collapse into one generic message.
describe('blockedMessage', () => {
  test('a denial points at credentials, permission, or the clock', () => {
    const msg = blockedMessage({ kind: PROBE_KIND.DENIED, status: 403 });
    assert.match(msg, /credential|permission|clock/i);
  });

  test('a network failure points at CORS, which is the usual cause', () => {
    const msg = blockedMessage({ kind: PROBE_KIND.NETWORK, message: 'Failed to fetch' });
    assert.match(msg, /CORS/);
  });

  test('never returns an empty string, whatever it is handed', () => {
    assert.ok(blockedMessage({ kind: 'something-new' }).length > 0);
    assert.ok(blockedMessage(null).length > 0);
  });
});
