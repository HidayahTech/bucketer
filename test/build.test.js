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
import { createHash } from 'node:crypto';
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

describe('Build output — no source maps in production bundle (T5-1)', () => {
  // sourceMappingURL in a production bundle exposes unminified source to anyone
  // who fetches the deployed app. Prod mode uses sourcemap:false; this guard
  // catches any accidental config change.
  test('JS bundle contains no sourceMappingURL comment', () => {
    assert.ok(
      !jsBundle.includes('sourceMappingURL'),
      'production JS bundle must not contain //# sourceMappingURL — ' +
      'source maps expose unminified source to any visitor who fetches the app'
    );
  });
});

describe('Build output — bundle size ceiling (T5-2)', () => {
  // 600 KB ceiling guards against accidental inclusion of large assets or
  // dependencies. Current size is ~515 KB; 600 KB leaves headroom while
  // preventing runaway growth.
  const SIZE_LIMIT_BYTES = 600 * 1024;

  test(`dist/index.html is under ${SIZE_LIMIT_BYTES / 1024} KB`, () => {
    const size = Buffer.byteLength(html, 'utf8');
    assert.ok(
      size <= SIZE_LIMIT_BYTES,
      `dist/index.html is ${(size / 1024).toFixed(1)} KB — exceeds the ` +
      `${SIZE_LIMIT_BYTES / 1024} KB ceiling (T5-2)`
    );
  });
});

describe('Build output — integrity manifest', () => {
  // dist/integrity.json publishes the SHA-256 of dist/index.html so an in-app
  // verification check can compare the running bytes against the canonical
  // build GitLab CI published for this version (honest-host check).
  const manifestPath = resolve(ROOT, 'dist/integrity.json');

  test('integrity.json exists alongside dist/index.html', () => {
    assert.doesNotThrow(() => readFileSync(manifestPath, 'utf8'),
      'dist/integrity.json must be emitted by production build');
  });

  test('manifest.version matches package.json', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, pkg.version);
  });

  test('manifest.filename follows bucketer-v{VERSION}.html convention', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.filename, `bucketer-v${pkg.version}.html`);
  });

  test('manifest.hashes.sha256 matches actual SHA-256 of dist/index.html', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const expected = createHash('sha256')
      .update(readFileSync(resolve(ROOT, 'dist/index.html')))
      .digest('hex');
    assert.equal(manifest.hashes.sha256, expected);
  });
});

describe('Build output — meta Content-Security-Policy for static hosting (T5-4)', () => {
  // When deployed to S3/R2/B2 static hosting, no HTTP server can set headers.
  // A <meta http-equiv="Content-Security-Policy"> tag provides a baseline XSS
  // defence without requiring any server configuration.
  test('HTML head contains a <meta http-equiv="Content-Security-Policy"> tag', () => {
    assert.ok(
      html.includes('http-equiv="Content-Security-Policy"'),
      'dist/index.html must include a <meta http-equiv="Content-Security-Policy"> tag — ' +
      'S3/R2/B2 static hosting cannot set response headers; the meta CSP provides ' +
      'a baseline XSS defence for file-hosted deployments (T5-4)'
    );
  });
});

describe('Build output — Referrer-Policy for privacy (#12)', () => {
  // A <meta name="referrer" content="no-referrer"> stops presigned S3 URLs and
  // bucket/prefix names — which live in the URL and hash fragment — from leaking
  // via the Referer header on any outbound navigation, including the sandboxed
  // PDF preview iframe. S3/R2/B2 static hosting cannot set a Referrer-Policy
  // response header, so the meta tag provides the guarantee with no server config.
  test('HTML head sets <meta name="referrer" content="no-referrer">', () => {
    const match = html.match(/name="referrer"\s+content="([^"]+)"/);
    assert.ok(
      match,
      'dist/index.html must include a <meta name="referrer"> tag — without it, ' +
      'presigned URLs and bucket/prefix names can leak via the Referer header (#12)'
    );
    assert.equal(match[1], 'no-referrer', 'referrer policy must be "no-referrer"');
  });
});
