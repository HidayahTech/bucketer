// Tests for corsJson() — CORS configuration template.
//
// This is the configuration users apply to their S3-compatible buckets to allow
// browser-originated requests. Incorrect headers or missing methods cause silent
// failures in the browser (CORS errors that look like network errors).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { corsJson } from '../src/lib/cors-config.js';

function parsed(origin = 'https://app.example.com') {
  return JSON.parse(corsJson(origin));
}

describe('corsJson — structure', () => {
  test('returns valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(corsJson('https://app.example.com')));
  });

  test('has exactly one CORSRule', () => {
    assert.equal(parsed().CORSRules.length, 1);
  });

  test('AllowedOrigins contains the passed origin', () => {
    const rule = parsed('https://my.app.com').CORSRules[0];
    assert.deepEqual(rule.AllowedOrigins, ['https://my.app.com']);
  });

  test('MaxAgeSeconds is 3600', () => {
    assert.equal(parsed().CORSRules[0].MaxAgeSeconds, 3600);
  });
});

describe('corsJson — AllowedMethods (BUG-012)', () => {
  // BUG-012: DELETE was missing, causing delete operations to fail on B2.
  test('includes DELETE', () => {
    assert.ok(parsed().CORSRules[0].AllowedMethods.includes('DELETE'), 'DELETE must be in AllowedMethods');
  });

  test('includes all required HTTP methods', () => {
    const methods = parsed().CORSRules[0].AllowedMethods;
    for (const m of ['GET', 'PUT', 'HEAD', 'POST', 'DELETE']) {
      assert.ok(methods.includes(m), `${m} must be in AllowedMethods`);
    }
  });
});

describe('corsJson — AllowedHeaders', () => {
  // The AWS SDK sends amz-sdk-invocation-id and amz-sdk-request headers on every
  // request. These do NOT have an x-amz- prefix, so the x-amz-* wildcard does not
  // cover them. Without explicit entries, B2 rejects the preflight for SDK requests.
  test('includes amz-sdk-invocation-id explicitly', () => {
    const headers = parsed().CORSRules[0].AllowedHeaders;
    assert.ok(headers.includes('amz-sdk-invocation-id'), 'amz-sdk-invocation-id must be explicit');
  });

  test('includes amz-sdk-request explicitly', () => {
    const headers = parsed().CORSRules[0].AllowedHeaders;
    assert.ok(headers.includes('amz-sdk-request'), 'amz-sdk-request must be explicit');
  });

  test('includes x-amz-* wildcard', () => {
    const headers = parsed().CORSRules[0].AllowedHeaders;
    assert.ok(headers.includes('x-amz-*'), 'x-amz-* wildcard must be present');
  });

  test('includes Authorization, Content-Type, Content-MD5, ETag', () => {
    const headers = parsed().CORSRules[0].AllowedHeaders;
    for (const h of ['Authorization', 'Content-Type', 'Content-MD5', 'ETag']) {
      assert.ok(headers.includes(h), `${h} must be in AllowedHeaders`);
    }
  });
});

describe('corsJson — ExposeHeaders', () => {
  test('exposes ETag, Content-Length, Content-Type', () => {
    const expose = parsed().CORSRules[0].ExposeHeaders;
    for (const h of ['ETag', 'Content-Length', 'Content-Type']) {
      assert.ok(expose.includes(h), `${h} must be in ExposeHeaders`);
    }
  });

  // BUG-028: x-amz-meta-* response headers were not in ExposeHeaders.
  // Browsers silently strip response headers absent from ExposeHeaders before
  // JavaScript can read them. The AWS SDK v3 builds head.Metadata from those
  // headers, so HeadObject appeared to return no custom metadata even when
  // the data was stored. fetch() response.headers.get() was similarly blocked,
  // breaking the DownloadPage mtime display. Fix: expose x-amz-meta-*.
  test('exposes x-amz-meta-* so custom object metadata is readable from the browser', () => {
    const expose = parsed().CORSRules[0].ExposeHeaders;
    assert.ok(
      expose.includes('x-amz-meta-*'),
      'x-amz-meta-* must be in ExposeHeaders — without it the browser strips custom ' +
      'metadata headers (e.g. x-amz-meta-file-mtime) from HeadObject and GET responses ' +
      'before JavaScript can read them, making all stored object metadata invisible'
    );
  });
});

// ── T5-3: corsCmd must shell-quote bucket/endpoint to prevent injection ───────────────
// corsCmd() interpolates bucket and endpoint directly into a shell command string.
// A bucket name containing a single quote (e.g. "my'bucket") breaks the shell quoting
// and can cause the command to execute unexpected tokens.

describe('shellQuote — POSIX shell-quoting for corsCmd arguments (T5-3)', () => {
  let shellQuote;

  before(async () => {
    const mod = await import('../src/lib/cors-config.js');
    shellQuote = mod.shellQuote;
  });

  test('shellQuote is exported from cors-config.js', () => {
    assert.ok(
      typeof shellQuote === 'function',
      'cors-config.js must export shellQuote — corsCmd interpolates bucket/endpoint ' +
      'into shell commands; a single quote in the bucket name breaks the command'
    );
  });

  test('wraps a plain string in single quotes', () => {
    assert.equal(shellQuote?.('mybucket'), "'mybucket'");
  });

  test("escapes an embedded single quote as '\\\\''", () => {
    assert.equal(shellQuote?.("my'bucket"), "'my'\\''bucket'");
  });

  test('handles multiple embedded single quotes', () => {
    assert.equal(shellQuote?.("a'b'c"), "'a'\\''b'\\''c'");
  });
});
