// Source-level structural assertions.
//
// These tests read JSX/JS source directly to enforce invariants that are:
//   (a) erased by minification and therefore invisible in build output, and
//   (b) not expressible as unit tests (they guard against omissions in component
//       source that only become bugs in a specific runtime context).
//
// No build step required — tests run against the raw src/ tree.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function src(relPath) {
  return readFileSync(resolve(ROOT, 'src', relPath), 'utf8');
}

// ── BUG-006: buttons inside forms must have explicit type ─────────────────────
// HTML buttons default to type="submit" when no type attribute is present.
// SetupGuide is rendered inside CredentialForm's <form> element. A button in
// SetupGuide without type="button" will submit the credential form when clicked.
// Fix: every <button> in SetupGuide must carry an explicit type attribute.

describe('SetupGuide — every <button> has explicit type (BUG-006)', () => {
  const source = src('components/SetupGuide.jsx');

  test('no <button> element is missing a type attribute', () => {
    // Match self-closing and open button tags; capture the attribute string.
    const pattern = /<button\b([^>]*?)(?:\s*\/>|\s*>)/g;
    let m;
    const missing = [];
    while ((m = pattern.exec(source)) !== null) {
      const attrs = m[1];
      if (!/\btype\s*=/.test(attrs)) {
        const lineNo = source.slice(0, m.index).split('\n').length;
        missing.push(`line ${lineNo}`);
      }
    }
    assert.deepEqual(
      missing, [],
      `SetupGuide buttons missing explicit type (default is "submit", submits parent form): ${missing.join(', ')}`
    );
  });
});

// ── BUG-014: App.jsx must not silently drop hook imports ─────────────────────
// Named imports from preact/hooks must be explicit. Missing a hook import causes
// a blank page (ReferenceError at runtime) with no UI indication of the failure.
// Guard the hooks that App.jsx currently depends on.

describe('App.jsx — required hooks imported from preact/hooks (BUG-014)', () => {
  const source = src('components/App.jsx');
  const importMatch = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]preact\/hooks['"]/);

  test('preact/hooks import exists', () => {
    assert.ok(importMatch, 'App.jsx must import from preact/hooks');
  });

  for (const hook of ['useState', 'useEffect', 'useCallback', 'useRef']) {
    test(`${hook} is imported`, () => {
      assert.ok(
        importMatch && importMatch[1].includes(hook),
        `${hook} must be in the preact/hooks import — a missing hook import causes a blank page at runtime`
      );
    });
  }
});

// ── BUG-021: UploadLog must cap rendered rows to prevent Preact VDOM freeze ────
// With tens of thousands of entries, Preact's synchronous VDOM diff of all rows
// on every state update took several seconds of wall-clock time, triggering
// Firefox's script timeout and freezing the page entirely. The MAX_DISPLAY
// constant caps the rendered row count regardless of how many entries exist in
// IndexedDB. If the constant is raised too high or removed, the freeze returns.

describe('UploadLog — MAX_DISPLAY cap is present and bounded (BUG-021)', () => {
  const source = src('components/UploadLog.jsx');

  test('MAX_DISPLAY constant is declared', () => {
    assert.ok(
      /const\s+MAX_DISPLAY\s*=/.test(source),
      'UploadLog.jsx must declare MAX_DISPLAY — removing it re-exposes the Preact VDOM freeze on large upload histories'
    );
  });

  test('MAX_DISPLAY value is at most 500', () => {
    const m = source.match(/const\s+MAX_DISPLAY\s*=\s*(\d+)/);
    assert.ok(m, 'MAX_DISPLAY must be a numeric literal');
    const value = Number(m[1]);
    assert.ok(
      value <= 500,
      `MAX_DISPLAY is ${value}, which is dangerously high — keep it at or below 500 to prevent VDOM diffing thousands of rows`
    );
  });

  test('displayEntries slices using MAX_DISPLAY', () => {
    assert.ok(
      /slice\s*\(\s*0\s*,\s*MAX_DISPLAY\s*\)/.test(source),
      'UploadLog.jsx must slice entries to MAX_DISPLAY rows before rendering'
    );
  });
});

// ── BUG-017: selectedProfileId must be declared before credentials ─────────────
// The credentials useState initializer pre-fills the form from the last-used
// profile by calling loadLastProfileId() and matching it against loadProfiles().
// If credentials is declared before selectedProfileId, JavaScript's sequential
// useState initialization means the credentials initializer runs before
// selectedProfileId is assigned — making the profile lookup impossible and
// leaving the form empty even when a profile is saved and selected.

describe('App.jsx — selectedProfileId declared before credentials (BUG-017)', () => {
  const source = src('components/App.jsx');

  test('selectedProfileId state declaration precedes credentials state declaration', () => {
    const profileIdIdx = source.indexOf('selectedProfileId, setSelectedProfileId');
    const credIdx      = source.indexOf('credentials, setCredentials');
    assert.ok(profileIdIdx !== -1, 'selectedProfileId state must exist in App.jsx');
    assert.ok(credIdx !== -1,      'credentials state must exist in App.jsx');
    assert.ok(
      profileIdIdx < credIdx,
      'selectedProfileId must be declared before credentials — the credentials ' +
      'initializer calls loadLastProfileId() to pre-fill from the saved profile; ' +
      'if credentials is first, the profile lookup is impossible and the form loads empty'
    );
  });
});

// ── T3-1: Wasabi billing warning must appear in delete confirmation dialogs ───────────
// Wasabi charges for a minimum of 90 days per object. A user who deletes test data
// minutes after uploading is billed for the remainder of the retention window.

describe('DeleteQueue.jsx — Wasabi 90-day billing warning present (T3-1)', () => {
  const source = src('components/DeleteQueue.jsx');

  test('warning text mentions Wasabi and 90 days', () => {
    assert.ok(
      /[Ww]asabi/.test(source) && /90.day/.test(source),
      'DeleteQueue.jsx must include Wasabi 90-day retention warning — users deleting ' +
      'test objects will be billed for up to 89 more days after deletion'
    );
  });
});

describe('HiddenVersions.jsx — Wasabi 90-day billing warning in purge-all (T3-1)', () => {
  const source = src('components/HiddenVersions.jsx');

  test('warning text mentions Wasabi and 90 days', () => {
    assert.ok(
      /[Ww]asabi/.test(source) && /90.day/.test(source),
      'HiddenVersions.jsx must include Wasabi 90-day retention warning in purge-all confirmation'
    );
  });
});

// ── T3-2: HiddenVersions must gate on provider versioning support ─────────────────────
// Cloudflare R2 does not implement ListObjectVersions — panel returns empty with no
// explanation, making users think their versions disappeared.

describe('HiddenVersions.jsx — R2 versioning not-supported gate (T3-2)', () => {
  const source = src('components/HiddenVersions.jsx');

  test('component accepts provider prop', () => {
    assert.ok(
      /HiddenVersions\s*\(\s*\{[^}]*provider/.test(source),
      'HiddenVersions must accept a provider prop to gate R2 users'
    );
  });

  test('renders not-supported message for R2', () => {
    assert.ok(
      /R2[^}]*not support|not support[^}]*R2|versioning.*not.*support|R2.*versioning/i.test(source),
      'HiddenVersions must render a "versioning not supported" message for Cloudflare R2'
    );
  });
});

// ── T3-4: MinIO SetupGuide must warn about HTTPS mixed-content ───────────────────────
// Default MinIO is HTTP on localhost:9000. When Bucketer is deployed over HTTPS,
// the browser silently blocks all HTTP requests (mixed-content policy).

describe('SetupGuide.jsx — MinIO HTTPS mixed-content warning (T3-4)', () => {
  const source = src('components/SetupGuide.jsx');

  test('GuideMinIO has explicit mixed-content warning paragraph', () => {
    // Look within GuideMinIO function body (from its definition to the next function)
    const guideStart = source.indexOf('function GuideMinIO');
    const guideEnd   = source.indexOf('\nfunction ', guideStart + 1);
    const guide = source.slice(guideStart, guideEnd > guideStart ? guideEnd : undefined);
    // Must contain an explicit warning about mixed-content or the HTTPS requirement,
    // NOT just incidentally contain "https" in a URL placeholder.
    assert.ok(
      /mixed.content|HTTPS.*required|must.*HTTPS|HTTP.*block|TLS.*required|mixed content/i.test(guide),
      'GuideMinIO must include an explicit mixed-content warning — HTTPS Bucketer cannot ' +
      'make requests to an HTTP MinIO server; the error appears only in DevTools'
    );
  });
});

// ── T3-5: B2 SetupGuide must mention listAllBucketNames capability ────────────────────
// AWS SDK v3 calls ListBuckets during init. A B2 key scoped to one bucket without
// listAllBucketNames causes init to fail entirely.

describe('SetupGuide.jsx — B2 listAllBucketNames capability mentioned (T3-5)', () => {
  const source = src('components/SetupGuide.jsx');

  test('GuideB2 mentions listAllBucketNames or List All Bucket Names', () => {
    const guideStart = source.indexOf('function GuideB2');
    const guideEnd   = source.indexOf('\nfunction ', guideStart + 1);
    const guide = source.slice(guideStart, guideEnd > guideStart ? guideEnd : undefined);
    assert.ok(
      /listAllBucketNames|List All Bucket Names/i.test(guide),
      'GuideB2 must mention listAllBucketNames — a single-bucket key without this capability ' +
      'causes AWS SDK v3 initialisation to fail entirely'
    );
  });
});

// ── T3-6: R2 SetupGuide must mention Account ID location, payment method, token scope ──
// Users don't know where to find Account ID, that a payment method is required at
// free tier, or the difference between bucket-scoped and account-scoped tokens.

describe('SetupGuide.jsx — R2 guide completeness (T3-6)', () => {
  const source = src('components/SetupGuide.jsx');

  function r2Guide() {
    const guideStart = source.indexOf('function GuideR2');
    const guideEnd   = source.indexOf('\nfunction ', guideStart + 1);
    return source.slice(guideStart, guideEnd > guideStart ? guideEnd : undefined);
  }

  test('GuideR2 mentions Account ID location', () => {
    assert.ok(
      /[Aa]ccount\s+ID/i.test(r2Guide()),
      'GuideR2 must tell users where to find their Account ID (Cloudflare dashboard sidebar)'
    );
  });

  test('GuideR2 mentions payment method requirement', () => {
    assert.ok(
      /payment|billing|credit card|free tier/i.test(r2Guide()),
      'GuideR2 must note that a payment method is required even on the free tier'
    );
  });

  test('GuideR2 mentions token scope (bucket-scoped vs account-scoped)', () => {
    assert.ok(
      /bucket.scoped|account.scoped|token scope|scope/i.test(r2Guide()),
      'GuideR2 must explain token scope: bucket-scoped for single-bucket, account-scoped for multi-bucket'
    );
  });
});

// ── T2-6: handleDeleteConfirm must wrap runDeleteOperation in try/catch ──────────────
// An uncaught throw from runDeleteOperation leaves the delete panel stuck in 'discovering'
// or 'deleting' phase with no dismiss path — the user is locked out until reload.

describe('App.jsx — handleDeleteConfirm wraps runDeleteOperation in try/catch (T2-6)', () => {
  const source = src('components/App.jsx');

  test('handleDeleteConfirm contains a try/catch block around runDeleteOperation', () => {
    // Find handleDeleteConfirm and assert try{ exists before the next function declaration
    const fnStart = source.indexOf('async function handleDeleteConfirm');
    assert.ok(fnStart !== -1, 'handleDeleteConfirm must exist in App.jsx');
    const fnBody = source.slice(fnStart, fnStart + 900);
    assert.ok(
      /\btry\s*\{/.test(fnBody),
      'handleDeleteConfirm must wrap runDeleteOperation in try/catch — an uncaught throw ' +
      'leaves the delete panel permanently stuck with no dismiss path'
    );
    assert.ok(
      /\bcatch\s*\(/.test(fnBody),
      'handleDeleteConfirm must have a catch clause to recover from unexpected errors'
    );
  });
});

// ── T2-5: README.md CSP examples must include media-src and frame-src ───────────────
// The nginx and Caddy examples used img-src data: only. Presigned S3 preview URLs are
// https: URLs — image, audio, video, and PDF previews silently break for anyone deploying
// with this example CSP verbatim.

describe('README.md — CSP examples include media-src and frame-src (T2-5)', () => {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

  test('CSP includes media-src https: for audio/video previews', () => {
    assert.ok(
      /media-src https:/.test(readme),
      'README.md CSP examples must include media-src https: — presigned audio/video preview ' +
      'URLs are https:, not data: URIs; without this directive previews are silently blocked'
    );
  });

  test('CSP includes frame-src https: for PDF previews', () => {
    assert.ok(
      /frame-src https:/.test(readme),
      'README.md CSP examples must include frame-src https: — PDF previews use an <iframe> ' +
      'with a presigned https: URL; without this directive PDF previews are silently blocked'
    );
  });

  test('CSP includes img-src https: for remote image previews', () => {
    assert.ok(
      /img-src data: https:/.test(readme),
      'README.md CSP examples must include img-src data: https: — presigned image preview ' +
      'URLs are https:, not data: URIs'
    );
  });
});

// ── T2-3: HiddenVersions purge-all must accumulate errors, not abort on first ────────
// Throwing on the first resp.Errors entry abandons all remaining batches. A 2500-version
// purge that fails on batch 2 permanently deletes the first 1000 with no indication.
// Fix: collect errors into allErrors[], continue through every batch, report aggregate.

describe('HiddenVersions — purge-all accumulates errors across all batches (T2-3)', () => {
  const source = src('components/HiddenVersions.jsx');

  test('uses error accumulation pattern (allErrors) instead of throwing on first error', () => {
    assert.ok(
      /allErrors\.push/.test(source),
      'HiddenVersions.jsx must accumulate errors into allErrors[] — throwing on the ' +
      'first error abandons remaining batches and silently leaves versions undeleted'
    );
  });

  test('does not throw on the first resp.Errors entry inside the batch loop', () => {
    // The old pattern: if (resp.Errors ...) { throw new Error(...) }
    // After fix, errors are collected, not thrown mid-loop.
    assert.ok(
      !/if\s*\(resp\.Errors[^}]*throw/.test(source),
      'HiddenVersions.jsx must not throw inside the batch loop on resp.Errors — ' +
      'this stops all remaining batches and leaves a partial purge with no error summary'
    );
  });
});

// ── T1-2: every new XCommand() call must have a matching @aws-sdk/client-s3 import ──
// When a Command identifier is used without being imported, JS throws ReferenceError at
// runtime. This is exactly how T1-1 (rename leaving a duplicate) manifested: the copy
// step succeeded but the delete step threw because DeleteObjectCommand was removed from
// the Browser.jsx import during the v1.14.0 unified-delete refactor.

function allSrcFiles(dir) {
  const abs = resolve(ROOT, dir);
  const entries = readdirSync(abs, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      files.push(...allSrcFiles(`${dir}/${e.name}`));
    } else if (e.name.endsWith('.js') || e.name.endsWith('.jsx')) {
      files.push(`${dir}/${e.name}`);
    }
  }
  return files;
}

const SDK_IMPORT = '@aws-sdk/client-s3';
const sdkFiles = allSrcFiles('src').filter(f =>
  readFileSync(resolve(ROOT, f), 'utf8').includes(SDK_IMPORT)
);

describe('every new XCommand() has a matching @aws-sdk/client-s3 import (T1-2)', () => {
  for (const relPath of sdkFiles) {
    test(`${relPath} — all used Commands are imported`, () => {
      const source = readFileSync(resolve(ROOT, relPath), 'utf8');

      // Named imports from @aws-sdk/client-s3
      const importMatch = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]@aws-sdk\/client-s3['"]/);
      const imported = new Set(
        importMatch ? importMatch[1].split(',').map(s => s.trim().replace(/\s+as\s+\S+$/, '')).filter(Boolean) : []
      );

      // All `new XyzCommand(` usages in the file
      const usagePattern = /new\s+([A-Z][A-Za-z]+Command)\s*\(/g;
      const used = new Set();
      let m;
      while ((m = usagePattern.exec(source)) !== null) {
        used.add(m[1]);
      }

      const missing = [...used].filter(cmd => !imported.has(cmd));
      assert.deepEqual(
        missing, [],
        `${relPath} uses Commands not present in its @aws-sdk/client-s3 import: ` +
        `${missing.join(', ')} — add them to prevent ReferenceError at runtime`
      );
    });
  }
});
