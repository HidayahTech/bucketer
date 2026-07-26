// Unit tests for connection diagnostics (spec 2026-07-26).
// All I/O is injected — no network, no browser globals required.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics, diagnosticsProps, VERDICT_MESSAGES } from '../src/lib/connection-diagnostics.js';

const BASE = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'my-bucket',
  forcePathStyle: false,
  pageProtocol: 'https:',
  onLine: true,
};

const fetchOk = async () => ({ type: 'opaque' });
const fetchFail = async () => { throw new TypeError('NetworkError'); };

describe('runDiagnostics verdicts', () => {
  test('offline: navigator reports no connection', async () => {
    const { checks, verdict } = await runDiagnostics({ ...BASE, onLine: false, fetchFn: fetchOk });
    assert.equal(verdict, 'offline');
    assert.equal(checks[0].id, 'online');
    assert.equal(checks[0].status, 'fail');
    // everything after the verdict-determining check is skipped
    for (const c of checks.slice(1)) assert.equal(c.status, 'skip');
  });

  test('mixed-content: https page with http endpoint', async () => {
    const { verdict, checks } = await runDiagnostics({
      ...BASE, endpoint: 'http://minio.example.com:9000', fetchFn: fetchOk,
    });
    assert.equal(verdict, 'mixed-content');
    assert.equal(checks.find(c => c.id === 'mixed-content').status, 'fail');
  });

  test('http endpoint from an http page is NOT mixed content', async () => {
    const { verdict } = await runDiagnostics({
      ...BASE, endpoint: 'http://minio.example.com:9000', pageProtocol: 'http:', forcePathStyle: true, fetchFn: fetchOk,
    });
    assert.equal(verdict, 'cors-blocked');
  });

  test('bad-endpoint-url: unparseable endpoint', async () => {
    const { verdict } = await runDiagnostics({ ...BASE, endpoint: 'not a url', fetchFn: fetchOk });
    assert.equal(verdict, 'bad-endpoint-url');
  });

  test('endpoint-unreachable: probe of endpoint origin rejects', async () => {
    const { verdict, checks } = await runDiagnostics({ ...BASE, fetchFn: fetchFail });
    assert.equal(verdict, 'endpoint-unreachable');
    assert.equal(checks.find(c => c.id === 'endpoint-reachable').status, 'fail');
    assert.equal(checks.find(c => c.id === 'bucket-host-reachable').status, 'skip');
  });

  test('bucket-host-unreachable: endpoint ok, bucket vhost rejects', async () => {
    const fetchFn = async (url) => {
      if (String(url).includes('my-bucket.')) throw new TypeError('NetworkError');
      return { type: 'opaque' };
    };
    const { verdict } = await runDiagnostics({ ...BASE, fetchFn });
    assert.equal(verdict, 'bucket-host-unreachable');
  });

  test('bucket vhost probe targets bucket.<endpoint-host>', async () => {
    const urls = [];
    const fetchFn = async (url) => { urls.push(String(url)); return { type: 'opaque' }; };
    await runDiagnostics({ ...BASE, fetchFn });
    assert.ok(urls.some(u => u.startsWith('https://my-bucket.s3.us-west-004.backblazeb2.com')));
  });

  test('cors-blocked: everything reachable', async () => {
    const { verdict, checks } = await runDiagnostics({ ...BASE, fetchFn: fetchOk });
    assert.equal(verdict, 'cors-blocked');
    for (const c of checks) assert.equal(c.status, 'pass');
  });

  test('path-style skips the bucket-host probe', async () => {
    const urls = [];
    const fetchFn = async (url) => { urls.push(String(url)); return { type: 'opaque' }; };
    const { verdict, checks } = await runDiagnostics({ ...BASE, forcePathStyle: true, fetchFn });
    assert.equal(verdict, 'cors-blocked');
    assert.equal(checks.find(c => c.id === 'bucket-host-reachable').status, 'skip');
    assert.equal(urls.length, 1, 'only the endpoint origin is probed');
  });

  test('probe timeout counts as unreachable', async () => {
    // Never resolves; rejects only on abort — exercises the AbortController path.
    const hangingFetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const { verdict } = await runDiagnostics({ ...BASE, fetchFn: hangingFetch, timeoutMs: 10 });
    assert.equal(verdict, 'endpoint-unreachable');
  });

  test('every verdict has a user-facing message', async () => {
    for (const v of ['offline', 'mixed-content', 'bad-endpoint-url', 'endpoint-unreachable', 'bucket-host-unreachable', 'cors-blocked']) {
      assert.equal(typeof VERDICT_MESSAGES[v], 'string');
      assert.ok(VERDICT_MESSAGES[v].length > 20, `message for ${v} should be a real sentence`);
    }
    assert.ok(VERDICT_MESSAGES['cors-blocked'].includes('almost certainly'));
    assert.ok(!VERDICT_MESSAGES['cors-blocked'].toLowerCase().includes('definitely'));
  });
});

describe('diagnosticsProps', () => {
  test('derives forcePathStyle from provider', () => {
    const p = diagnosticsProps({ endpoint: 'https://x.example.com', bucket: 'b', provider: 'minio' });
    assert.deepEqual(p, { endpoint: 'https://x.example.com', bucket: 'b', forcePathStyle: true });
  });

  test('virtual-host provider yields forcePathStyle false', () => {
    const p = diagnosticsProps({ endpoint: 'https://s3.amazonaws.com', bucket: 'b', provider: 'aws' });
    assert.equal(p.forcePathStyle, false);
  });
});
