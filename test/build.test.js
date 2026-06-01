// Build output structural assertions.
//
// These tests guard against regressions that only manifest in the production
// build — not caught by unit tests or type checking. Run `npm run build` before
// running this file; it operates on the committed dist/index.html.
//
// Structural note: the bundle is a single file with the form:
//   ...HTML head...<style>CSS</style><script>JS bundle</script></body></html>
//
// The JS bundle may contain <script>, <style>, and other tag-like strings as
// data (e.g. changelog entries, CORS templates). Whole-file string counting
// would yield false positives. Tests that care about tag count or JS content
// operate on the HTML frame and JS bundle separately.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'dist/index.html'), 'utf8');
const pkg  = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

// Split into HTML frame (before the injected bundle) and JS bundle content.
// The injection point is the single <style>CSS</style><script>JS</script> block.
const styleOpen  = html.indexOf('<style>');
const scriptOpen = html.indexOf('<script>') + '<script>'.length;
const scriptClose = html.lastIndexOf('</script>');
const htmlFrame  = html.slice(0, styleOpen);   // everything before the CSS injection
const jsBundle   = html.slice(scriptOpen, scriptClose);

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
  // React.createElement(...) calls. The app uses Preact; React is never in scope.
  // Fix: jsx:'automatic' + jsxImportSource:'preact'.
  //
  // We check the JS bundle directly, not the full file: the changelog may contain
  // the string "React.createElement" as prose, which would cause a false positive
  // on a whole-file search. A function-call pattern (with `(`) won't match prose.
  test('JS bundle has no React.createElement( call sites', () => {
    assert.ok(!jsBundle.includes('React.createElement('), 'Preact JSX transform must be active');
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
    assert.ok(jsBundle.includes('"DELETE"'), 'DELETE must be present in the inlined CORS template');
  });

  // Regression guard: the full required method set must be present.
  test('CORS template includes GET, PUT, HEAD, POST, DELETE', () => {
    for (const method of ['GET', 'PUT', 'HEAD', 'POST', 'DELETE']) {
      assert.ok(jsBundle.includes(`"${method}"`), `CORS template must include "${method}"`);
    }
  });
});

describe('Build output — single self-contained bundle', () => {
  // These assertions operate on the HTML frame (before the injected CSS/JS),
  // not the full file. The JS bundle may contain tag-like strings as data.

  test('HTML frame before the bundle has no extra script or style tags', () => {
    assert.ok(!htmlFrame.includes('<script'), 'no <script> tags before the bundle injection point');
    assert.ok(!htmlFrame.includes('<style'),  'no <style> tags before the bundle injection point');
  });

  test('file ends with the expected closing sequence', () => {
    assert.ok(html.trimEnd().endsWith('</html>'), 'file must end with </html>');
    assert.ok(html.includes('</script>'), 'bundle must have a closing </script> tag');
  });

  test('no external script src attributes', () => {
    assert.ok(!html.match(/<script[^>]+src=/), 'all JS must be inlined — no external <script src>');
  });

  test('no external stylesheet link tags', () => {
    assert.ok(!html.match(/<link[^>]+rel="stylesheet"/), 'all CSS must be inlined — no external <link> stylesheet');
  });
});
