// Build output structural assertions.
//
// These tests guard against regressions that only manifest in the production
// build — not caught by unit tests or type checking. Run `npm run build` before
// running this file; it operates on the committed dist/index.html.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'dist/index.html'), 'utf8');
const pkg  = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

describe('Build output — BUG-001 (placeholder replacement)', () => {
  // BUG-001: String.prototype.replace() corrupted the bundle when the replacement
  // string contained $& / $` / $' sequences present in minified JS. The fix passes
  // a function as the replacement, disabling all $ interpretation. If the placeholder
  // survives or the output is truncated, we would see the literal comment string.
  test('bundle placeholder has been removed', () => {
    assert.ok(!html.includes('BUNDLE_PLACEHOLDER'), 'placeholder must not survive into dist');
  });

  test('output contains an opening <html tag', () => {
    assert.ok(html.includes('<html'), 'dist/index.html must be a valid HTML document');
  });

  test('output contains a closing </html> tag', () => {
    assert.ok(html.includes('</html>'), 'dist/index.html must have a closing </html> tag');
  });
});

describe('Build output — BUG-002 (Preact JSX transform)', () => {
  // BUG-002: esbuild defaulted to the React JSX transform, producing
  // React.createElement() calls. The app uses Preact; React is never in scope.
  // Fix: jsx:'automatic' + jsxImportSource:'preact'.
  test('bundle does not contain React.createElement', () => {
    assert.ok(!html.includes('React.createElement'), 'bundle must not reference React');
  });

  // "React" appears once in an AWS SDK comment ("Browser and React Native") — that is fine.
  // What must never appear is React.createElement, which signals the wrong JSX transform.
  test('bundle does not reference React.createElement (Preact JSX transform is active)', () => {
    assert.ok(!html.includes('React.createElement'), 'React.createElement must not appear in any context');
  });
});

describe('Build output — version metadata', () => {
  test('build-id meta tag is present', () => {
    assert.ok(html.includes('name="build-id"'), 'build-id meta tag required for update checker');
  });

  test('app-version meta tag is present', () => {
    assert.ok(html.includes('name="app-version"'), 'app-version meta tag required for update checker');
  });

  test('app-version in HTML matches package.json version', () => {
    const match = html.match(/name="app-version"\s+content="([^"]+)"/);
    assert.ok(match, 'app-version meta tag must have a content attribute');
    assert.equal(match[1], pkg.version, 'built version must match package.json');
  });
});

describe('Build output — CORS template (BUG-012)', () => {
  // BUG-012: DELETE was missing from the CORS AllowedMethods in the SetupGuide
  // template. B2's CORS enforcement rejected OPTIONS preflight for delete requests.
  test('CORS template includes DELETE method', () => {
    assert.ok(html.includes('"DELETE"'), 'DELETE must be present in the inlined CORS template');
  });

  // Regression guard: the full required method set must be present.
  test('CORS template includes GET, PUT, HEAD, POST, DELETE', () => {
    for (const method of ['GET', 'PUT', 'HEAD', 'POST', 'DELETE']) {
      assert.ok(html.includes(`"${method}"`), `CORS template must include "${method}"`);
    }
  });
});

describe('Build output — single self-contained bundle', () => {
  test('exactly one <script> tag', () => {
    const matches = html.match(/<script/g) ?? [];
    assert.equal(matches.length, 1, `expected 1 <script> tag, found ${matches.length}`);
  });

  test('exactly one <style> tag', () => {
    const matches = html.match(/<style/g) ?? [];
    assert.equal(matches.length, 1, `expected 1 <style> tag, found ${matches.length}`);
  });

  test('no external script src attributes', () => {
    assert.ok(!html.match(/<script[^>]+src=/), 'all JS must be inlined — no external <script src>');
  });

  test('no external stylesheet link tags', () => {
    assert.ok(!html.match(/<link[^>]+rel="stylesheet"/), 'all CSS must be inlined — no external <link> stylesheet');
  });
});
