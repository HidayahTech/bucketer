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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
// The delete confirmation moved from DeleteQueue.jsx onto DeleteConfirmModal.jsx (the
// pre-queue confirm step); its Wasabi/90-day warning is asserted by the rendering test
// test/components/delete-confirm-modal.test.jsx (Task 5), which is stronger than a
// source regex, so the source invariant that guarded DeleteQueue.jsx is retired here.

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
    // Bound the slice by the next sibling function so the check is robust to the
    // function growing (a fixed-length window silently drops the catch clause).
    const fnEnd = source.indexOf('async function handleMoveRequest', fnStart);
    const fnBody = source.slice(fnStart, fnEnd === -1 ? fnStart + 1200 : fnEnd);
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

describe('purge-versions.js — purge-all accumulates errors across all batches (T2-3)', () => {
  // The accumulation logic moved from HiddenVersions.jsx to purge-versions.js in the
  // 2026-06 simplification pass. The invariant is tested here for the canonical location.
  const source = src('lib/purge-versions.js');

  test('uses error accumulation pattern (allErrors) instead of throwing on first error', () => {
    assert.ok(
      /allErrors\.push/.test(source),
      'purge-versions.js must accumulate errors into allErrors[] — throwing on the ' +
      'first error abandons remaining batches and silently leaves versions undeleted'
    );
  });

  test('does not throw on the first resp.Errors entry inside the batch loop', () => {
    // The old pattern: if (resp.Errors ...) { throw new Error(...) }
    // After fix, errors are collected, not thrown mid-loop.
    assert.ok(
      !/if\s*\(resp\.Errors[^}]*throw/.test(source),
      'purge-versions.js must not throw inside the batch loop on resp.Errors — ' +
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

// ── T4-3: discoverPrefixKeys must use a worker pool, not bare Promise.all ──────────────
// Promise.all(prefixes.map(...)) on 30+ folders launches unlimited concurrent ListObjectsV2
// crawls — can saturate the HTTP/2 connection pool and trigger 503 throttling.

describe('delete-queue.js — discoverPrefixKeys concurrency is capped (T4-3)', () => {
  const source = readFileSync(resolve(ROOT, 'src/lib/delete-queue.js'), 'utf8');

  test('does not use bare Promise.all(prefixes.map for discovery', () => {
    assert.ok(
      !source.includes('Promise.all(prefixes.map'),
      'delete-queue.js must not use bare Promise.all(prefixes.map) — deleting 30+ folders ' +
      'launches unlimited concurrent ListObjectsV2 crawls that can saturate the ' +
      'connection pool and trigger provider throttling (T4-3)'
    );
  });
});

// ── T4-5: stale claims in docs/QUESTIONS.md must be corrected ────────────────────────
// Three factual errors: "No delete" shipped; "N=2" is actually N=3; D1 still listed as open.

describe('docs/QUESTIONS.md — stale claims absent (T4-5)', () => {
  const questions = readFileSync(resolve(ROOT, 'docs/QUESTIONS.md'), 'utf8');

  test('"No delete, rename, copy — out of scope" claim is removed', () => {
    assert.ok(
      !questions.includes('No delete, rename, copy'),
      'docs/QUESTIONS.md must not claim "No delete, rename, copy" — all three shipped in v1.14.0+'
    );
  });

  test('"N=2 upload concurrency default" claim is corrected', () => {
    assert.ok(
      !questions.includes('N=2 upload concurrency'),
      'docs/QUESTIONS.md claims N=2 upload concurrency default — actual default is N=3 ' +
      '(DEFAULT_FILE_CONCURRENCY = 3 in UploadQueue.jsx)'
    );
  });
});

// ── T5-5: Browser.jsx must not use a module-level mutable for session-first-mount ─────
// Module-level let _sessionFirstMount is shared across all component instances and
// persists for the module lifetime — pollutes test isolation, wrong if multiple instances.

describe('Browser.jsx — no module-level mutable _sessionFirstMount (T5-5)', () => {
  const source = src('components/Browser.jsx');

  test('_sessionFirstMount is not declared as a module-level let', () => {
    assert.ok(
      !/^let _sessionFirstMount/m.test(source),
      'Browser.jsx must not use a module-level let _sessionFirstMount — ' +
      'module-level mutables are shared across instances and pollute test isolation; ' +
      'derive from browserKey (passed as prop from App.jsx) instead'
    );
  });
});

// ── T5-6: Browser.jsx must distinguish empty-bucket from empty-prefix ─────────────────
// Showing "This prefix is empty." at the root of an empty bucket is misleading.
// The root empty state is an onboarding moment — it should invite the user to upload.

describe('Browser.jsx — empty-bucket and empty-prefix have distinct copy (T5-6)', () => {
  const source = src('components/Browser.jsx');

  test('root empty state renders bucket-specific copy (not just "This prefix is empty.")', () => {
    assert.ok(
      /This bucket is empty|bucket is empty/i.test(source),
      'Browser.jsx must render distinct copy when the root of a bucket is empty — ' +
      '"This prefix is empty." shown at the root is misleading; use onboarding copy ' +
      'that tells the user the bucket has no objects and invites an upload'
    );
  });
});

// ── T5-7: single-file delete confirmation must show the filename ──────────────────────
// When deleting a single file, the modal only showed "Delete 1 file?" — the user can't
// confirm which file without looking away from the dialog. The confirmation moved from
// DeleteQueue.jsx onto DeleteConfirmModal.jsx; the filename-display invariant is now
// asserted by the rendering test test/components/delete-confirm-modal.test.jsx (Task 5),
// so the source regex that guarded DeleteQueue.jsx is retired here.

// ── T5-8: CapabilityPanel must explain the ? (unknown) state inline ───────────────────
// A tooltip title "Not yet tested" is insufficient — inline hint needed explaining that
// permissions are probed automatically as the user performs each operation.

describe('CapabilityPanel.jsx — inline hint text for unknown (?) state (T5-8)', () => {
  const source = src('components/CapabilityPanel.jsx');

  test('has inline hint explaining permissions are detected automatically', () => {
    assert.ok(
      /detected automatically|as you use.*feature|as you use each/i.test(source),
      'CapabilityPanel.jsx must include an inline hint explaining the ? state — ' +
      '"Not yet tested" as a tooltip title is not visible enough; users need an ' +
      'inline note that permissions are detected automatically as they use features'
    );
  });
});

// ── T5-10: BUG-023 and BUG-024 regression guards ─────────────────────────────────────
// These are regression tests for bugs already fixed in v1.14.0. They pass immediately.
// Their purpose is to catch any future removal of the fix.
//
// BUG-023: handleCancelBatch did not call deleteResumeRecord — re-dragging a cancelled
// folder showed all files as "Paused" because stale IndexedDB resume records survived.
// BUG-024: enqueueUpload's async gap (awaiting loadResumeRecord) allowed a cancel that
// fired during the gap to be overwritten — items returned to "paused" after "aborted".

describe('UploadQueue.jsx — BUG-023 regression: handleCancelBatch calls deleteResumeRecord', () => {
  const source = src('components/UploadQueue.jsx');

  test('handleCancelBatch calls deleteResumeRecord to clean up stale IndexedDB records', () => {
    const fnStart = source.indexOf('function handleCancelBatch(');
    assert.ok(fnStart !== -1, 'handleCancelBatch must exist in UploadQueue.jsx');
    const fnEnd = source.indexOf('\n  function ', fnStart + 1);
    const fn = source.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000);
    assert.ok(
      fn.includes('deleteResumeRecord'),
      'handleCancelBatch must call deleteResumeRecord — otherwise re-dragging a cancelled ' +
      'folder shows all files as "Paused" due to surviving stale IndexedDB records (BUG-023)'
    );
  });
});

describe('UploadQueue.jsx — BUG-024 regression: cancellation guard after loadResumeRecord', () => {
  const source = src('components/UploadQueue.jsx');

  test('enqueueUpload has cancellation guard immediately after await loadResumeRecord', () => {
    assert.ok(
      /await loadResumeRecord[\s\S]{0,500}cancelledBatchesRef\.current\.has/.test(source),
      'enqueueUpload must check cancelledBatchesRef.current.has after await loadResumeRecord — ' +
      'without this guard a cancel fired during the async gap overwrites "aborted" ' +
      'with "paused" when the promise resolves (BUG-024)'
    );
  });
});

// ── T5-11: GuideWasabi must warn about dotted-bucket SSL caveat ───────────────────────
// Virtual-hosted style (bucket.s3.wasabisys.com) on dotted bucket names (e.g. my.bucket)
// causes SSL SNI failures — the wildcard cert *.s3.wasabisys.com does not cover
// my.bucket.s3.wasabisys.com. Users must either avoid dots in bucket names or use path-style.

describe('SetupGuide.jsx — Wasabi dotted-bucket SSL caveat present (T5-11)', () => {
  const source = src('components/SetupGuide.jsx');

  test('GuideWasabi warns about dotted bucket names causing SSL issues', () => {
    const guideStart = source.indexOf('function GuideWasabi');
    const guideEnd   = source.indexOf('\nfunction ', guideStart + 1);
    const guide = source.slice(guideStart, guideEnd > guideStart ? guideEnd : undefined);
    assert.ok(
      /dotted|dot.*name|path.?style.*bucket|bucket.*dot|avoid.*dot/i.test(guide),
      'GuideWasabi must warn that bucket names containing dots cause SSL SNI failures ' +
      'with virtual-hosted style — the wildcard cert *.s3.wasabisys.com does not cover ' +
      'dotted subdomain names like my.bucket.s3.wasabisys.com'
    );
  });
});

// ── T5-12: provider.js requiresPathStyle comment must not overstate B2 requirement ────
// B2 supports both path-style and virtual-hosted URLs. We force path-style because users
// supply a plain regional endpoint, not a bucket-prefixed one. The current comment
// incorrectly says "B2 and MinIO require path-style URLs."

describe('provider.js — requiresPathStyle B2 comment accuracy (T5-12)', () => {
  const source = readFileSync(resolve(ROOT, 'src/lib/provider.js'), 'utf8');

  test('comment does not claim B2 requires path-style (B2 supports both)', () => {
    assert.ok(
      !/B2 and MinIO require path-style URLs/.test(source),
      'provider.js comment overstates: B2 supports both path-style and virtual-hosted URLs. ' +
      'We force path-style because users supply a plain regional endpoint, not a bucket-prefixed one. ' +
      'MinIO genuinely requires path-style. Update the comment to reflect this distinction.'
    );
  });
});

// ── T5-13: provider.js defaultMaxKeys comment must not claim B2 Class C is billed ────
// B2 Class C operations (ListObjectsV2) are free for PAYG accounts — all B2 API calls
// are included in storage fees. Reframe the 200 default as a UX choice.

describe('provider.js — defaultMaxKeys B2 comment accuracy (T5-13)', () => {
  const source = readFileSync(resolve(ROOT, 'src/lib/provider.js'), 'utf8');

  test('comment does not claim B2 Class C ListObjectsV2 is billed per call', () => {
    assert.ok(
      !/billed per call/.test(source),
      'provider.js comment is factually wrong: B2 Class C operations are free for PAYG accounts. ' +
      'Reframe the 200 default as a UX choice (smaller pages make browsing feel snappier), ' +
      'not a billing-avoidance measure.'
    );
  });
});

// ── T4-1: Browser.jsx must not contain inline preview state (extracted to usePreview hook) ──
// Having all preview state (10+ useState calls) inline in Browser.jsx makes the component
// unwieldy and the preview logic untestable in isolation. The hook belongs in src/lib/.

describe('Browser.jsx — preview state extracted to usePreview hook (T4-1)', () => {
  const source = src('components/Browser.jsx');

  test('Browser.jsx does not declare const [previewItem, inline', () => {
    assert.ok(
      !source.includes('const [previewItem,'),
      'Browser.jsx must not declare previewItem state inline — preview state must be ' +
      'extracted to src/lib/usePreview.js so the logic is testable and Browser stays focused'
    );
  });

  test('Browser.jsx imports usePreview from lib', () => {
    assert.ok(
      /usePreview/.test(source),
      'Browser.jsx must import and use usePreview — the preview hook must be wired in'
    );
  });
});

// ── T4-2: usePreview hook must have a gen-ref cancellation guard ──────────────────────
// handlePreview is async (HeadObject + getSignedUrl + fetch). If the user opens preview
// for file A then immediately file B, A's async callbacks can overwrite B's preview state.
// The fix: increment a genRef on each call; guard every post-await setState with
// `if (gen !== genRef.current) return;`

describe('src/lib/usePreview.js — gen-ref cancellation guard (T4-2)', () => {
  const hookPath = resolve(ROOT, 'src/lib/usePreview.js');
  const hookSrc  = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';

  test('src/lib/usePreview.js exists', () => {
    assert.ok(existsSync(hookPath), 'src/lib/usePreview.js must exist — extract preview logic from Browser.jsx');
  });

  test('usePreview.js contains a generation ref for cancellation', () => {
    assert.ok(
      /genRef|previewGenRef/.test(hookSrc),
      'usePreview.js must use a genRef to guard against stale async callbacks — ' +
      'without it, opening preview for file B while A is loading overwrites B\'s state'
    );
  });

  test('usePreview.js guards setState calls with gen !== check', () => {
    assert.ok(
      /gen !== /.test(hookSrc),
      'usePreview.js must check `if (gen !== genRef.current) return` after every await — ' +
      'this is the cancellation guard that prevents stale preview state'
    );
  });
});

// ── T4-6: All standalone <label> elements must have htmlFor ──────────────────────────
// Screen readers associate labels with inputs via htmlFor. A bare <label>Text</label>
// paired with a separate <input> has no programmatic association — clicking the label
// does not focus the input and screen readers cannot link them.
//
// Note: labels that WRAP their input (<label><input/>text</label>) don't need htmlFor
// and typically have style= attributes; the bare <label> pattern catches the unfixed ones.

describe('CredentialForm.jsx — all standalone labels have htmlFor (T4-6)', () => {
  const source = src('components/CredentialForm.jsx');

  test('no bare <label> without attributes', () => {
    assert.ok(
      !source.includes('<label>'),
      'CredentialForm.jsx must not contain bare <label> — every standalone label must have ' +
      'htmlFor so screen readers and click-to-focus work correctly (T4-6)'
    );
  });
});

describe('SettingsPanel.jsx — all standalone labels have htmlFor (T4-6)', () => {
  const source = src('components/SettingsPanel.jsx');

  test('no bare <label> without attributes (standalone labels need htmlFor)', () => {
    // Wrapping labels (<label style=...><input />text</label>) are OK without htmlFor.
    // This checks for bare <label> — the unfixed standalone form labels.
    assert.ok(
      !source.includes('<label>'),
      'SettingsPanel.jsx must not contain bare <label> — every standalone label must have ' +
      'htmlFor so screen readers and click-to-focus work correctly (T4-6)'
    );
  });
});

// ── T5-9: Progress bars must have ARIA role and value attributes ──────────────────────
// A <div class="progress-bar-wrap"> with a width-based inner div is visually correct
// but invisible to assistive technologies. role="progressbar" + aria-valuenow/min/max
// expose the upload progress to screen readers and OS accessibility APIs.

describe('BatchSummary.jsx — progress bars have ARIA attributes (T5-9)', () => {
  const source = src('components/BatchSummary.jsx');

  test('progress-bar-wrap has aria-valuenow', () => {
    assert.ok(
      source.includes('aria-valuenow'),
      'BatchSummary.jsx progress-bar-wrap must have aria-valuenow — without it, screen ' +
      'readers cannot report upload progress (T5-9)'
    );
  });

  test('progress-bar-wrap has role="progressbar"', () => {
    assert.ok(
      source.includes('role="progressbar"'),
      'BatchSummary.jsx progress-bar-wrap must have role="progressbar" — exposes the ' +
      'upload bar to the accessibility tree (T5-9)'
    );
  });
});

// ── Drop handler synchronisation (v1.15.1) ────────────────────────────────────────────
// Both drop handlers were async and awaited collectFileEntries before returning.
// For large folder drops (1000+ files), the handler stays live and blocks the next drop
// event — the browser does not fire a new drop event until the handler resolves.
// Fix: capture FileSystemEntry objects sync (safe — dataTransfer items must be read
// before any await), then fire collectFileEntries as a detached .then(). The handler
// returns immediately, allowing the next drop to be captured right away.
// The parallel traversal fix in collectFileEntries (Promise.all over top-level entries)
// means independent subtrees are walked concurrently, reducing total traversal time.

describe('Browser.jsx — handleTableDrop is not async (drop-sync)', () => {
  const source = src('components/Browser.jsx');

  test('handleTableDrop is declared as a plain (non-async) function', () => {
    assert.ok(
      !/async function handleTableDrop/.test(source),
      'Browser.jsx handleTableDrop must not be async — an async handler blocks the drop ' +
      'event until collectFileEntries resolves; with 1000+ file folders the next drop ' +
      'is not captured until the first traversal completes. Capture entries sync, then ' +
      'fire collectFileEntries as a detached .then().'
    );
  });
});

describe('UploadQueue.jsx — handleDrop is not async (drop-sync)', () => {
  const source = src('components/UploadQueue.jsx');

  test('handleDrop is declared as a plain (non-async) function', () => {
    assert.ok(
      !/async function handleDrop/.test(source),
      'UploadQueue.jsx handleDrop must not be async — an async handler blocks the drop ' +
      'event until collectFileEntries resolves; rapid consecutive folder drops are not ' +
      'captured promptly. Capture entries sync, fire collectFileEntries as a detached .then().'
    );
  });
});

// pendingDrops was introduced in v1.15.1 and removed in v1.15.3 when the dedicated
// UploadQueue drop zone was eliminated. The window-wide overlay (v1.15.2) provides
// immediate visual feedback during traversal; a zone-local counter is no longer needed.

// ── Window-wide drag-and-drop overlay (v1.15.2) ───────────────────────────────────────
// Dragging files only over specific zones (Browser table, UploadQueue zone) means users
// must aim precisely. The window-wide overlay activates on any file drag over the viewport,
// shows a full-screen visual cue, and routes the drop to addFilesRef — the same destination
// as zone-specific drops.
//
// Design: document-level dragenter/dragleave/dragover listeners (useEffect in App.jsx)
// manage a counter and windowDragOver state. A fixed overlay (z-index 500, below modals at
// z-index 1000) is rendered when windowDragOver is true and session === 'connected'. The
// overlay captures the drop (ondrop) and fires collectFileEntries as a detached .then().
// Modal suppression: dragenter checks document.querySelector('.modal-overlay'); if a modal
// is open, the overlay is not activated.

describe('useWindowDragDrop.js — uses the shared drop resolver (window-drop, BUG-041)', () => {
  const source = src('hooks/useWindowDragDrop.js');

  test('useWindowDragDrop imports resolveDroppedFiles from file-entries', () => {
    assert.ok(
      /resolveDroppedFiles/.test(source),
      'useWindowDragDrop.js must resolve drops via resolveDroppedFiles — the shared resolver ' +
      'traverses FileSystemEntry trees AND falls back to dataTransfer.files when the entries ' +
      'yield nothing (BUG-041: WebKit returns truthy entries whose .file() errors NotFoundError; ' +
      'without the fallback such drops die silently)'
    );
  });
});

describe('Browser.jsx — uses the shared drop resolver (table-drop, BUG-041)', () => {
  const source = src('components/Browser.jsx');

  test('Browser imports resolveDroppedFiles from file-entries', () => {
    assert.ok(
      /resolveDroppedFiles/.test(source),
      'Browser.jsx handleTableDrop must resolve drops via resolveDroppedFiles (see the ' +
      'useWindowDragDrop invariant above for the BUG-041 fallback rationale)'
    );
  });
});

describe('App.jsx — window-drop overlay: windowDragOver state (window-drop)', () => {
  const source = src('components/App.jsx');

  test('App.jsx declares windowDragOver state', () => {
    assert.ok(
      /windowDragOver/.test(source),
      'App.jsx must declare windowDragOver state — it drives whether the full-screen ' +
      'drop overlay is rendered; set true on dragenter (files + connected + no modal), ' +
      'false on dragleave counter reaching zero or drop completing'
    );
  });
});

describe('useWindowDragDrop.js — document dragenter listener (window-drop)', () => {
  const source = src('hooks/useWindowDragDrop.js');

  test('useWindowDragDrop registers a dragenter event listener on document', () => {
    assert.ok(
      /addEventListener\s*\(\s*['"]dragenter['"]/.test(source),
      "useWindowDragDrop.js must register a document-level 'dragenter' listener — this is what " +
      'activates the window-drop overlay when any file is dragged over the viewport'
    );
  });
});

describe('App.jsx — window-drop overlay: overlay element rendered (window-drop)', () => {
  const source = src('components/App.jsx');

  test('App.jsx renders a window-drop-overlay element', () => {
    assert.ok(
      /window-drop-overlay/.test(source),
      'App.jsx must render a window-drop-overlay element — the full-screen fixed overlay ' +
      'that gives the user visual feedback and captures drops from anywhere on the page'
    );
  });
});

// ── v1.15.3: upload UI hidden when denied, drop zone removed, empty-state hint ──────────
// Three related changes shipped together:
//
// 1. Upload UI is hidden entirely (not just disabled/greyed) when capabilities.upload ===
//    'denied'. Greying out sends a confusing signal; hiding removes it from the user's
//    mental model until they have the necessary permissions.
//
// 2. The dedicated "Drop files or folders here" zone is removed. The window-wide overlay
//    (v1.15.2) covers the same surface area more conveniently. The zone was the only reason
//    UploadQueue needed its own drag event handlers — those are removed too.
//
// 3. An empty-state hint tells first-time users how to initiate an upload now that there
//    is no visible drop target. Placed where the queue will appear, so it gives way
//    naturally the moment the first upload starts.
//
// 4. The window overlay respects the upload capability: dragenter ignores the event when
//    upload is denied, and the overlay render is also gated on it.
//
// 5. Detached .then() calls (handleWindowDrop, handleTableDrop) get a .catch() to prevent
//    silent promise rejection if collectFileEntries throws unexpectedly.

describe('UploadQueue.jsx — dedicated drop zone removed (v1.15.3)', () => {
  const source = src('components/UploadQueue.jsx');

  test('upload-zone CSS class is no longer referenced in UploadQueue.jsx', () => {
    assert.ok(
      !source.includes('upload-zone'),
      'UploadQueue.jsx must not contain the upload-zone element — the window-wide overlay ' +
      '(v1.15.2) covers the same surface; the dedicated zone is redundant and adds visual noise'
    );
  });
});

describe('UploadQueue.jsx — no "Upload not permitted" warning banner (v1.15.3)', () => {
  const source = src('components/UploadQueue.jsx');

  test('"Upload not permitted" banner text is absent', () => {
    assert.ok(
      !source.includes('Upload not permitted'),
      'UploadQueue.jsx must not show an "Upload not permitted" banner — when upload is ' +
      'denied the entire upload initiation UI is hidden rather than shown in a degraded state'
    );
  });
});

describe('UploadQueue.jsx — empty-state drag-anywhere hint (v1.15.3)', () => {
  const source = src('components/UploadQueue.jsx');

  test('empty queue state shows instruction to drag anywhere in window', () => {
    assert.ok(
      /drag.*anywhere|anywhere.*drag/i.test(source),
      'UploadQueue.jsx must include an empty-state hint explaining that files can be ' +
      'dragged anywhere in the window — without it users have no cue that drag-and-drop ' +
      'is available now that the dedicated drop zone is removed'
    );
  });
});

describe('App.jsx — window overlay gated on upload capability (v1.15.3)', () => {
  const source = src('components/App.jsx');

  test("dragenter handler skips when capabilities.upload is 'denied'", () => {
    assert.ok(
      /capabilities\.upload/.test(source),
      "App.jsx must check capabilities.upload in the window-drop path — the overlay " +
      "must not activate when upload is definitively denied, matching UploadQueue's canUpload guard"
    );
  });
});

describe('useWindowDragDrop.js — handleWindowDrop has error handling (v1.15.3)', () => {
  const source = src('hooks/useWindowDragDrop.js');

  test('collectFileEntries .then() in handleWindowDrop is followed by .catch()', () => {
    // Find handleWindowDrop body and assert .catch( appears after collectFileEntries
    const fnStart = source.indexOf('function handleWindowDrop');
    assert.ok(fnStart !== -1, 'handleWindowDrop must exist in useWindowDragDrop.js');
    const fnBody = source.slice(fnStart, fnStart + 800);
    assert.ok(
      /\.catch\(/.test(fnBody),
      'handleWindowDrop must chain .catch() onto the collectFileEntries .then() — ' +
      'an unhandled rejection from collectFileEntries silently swallows the drop with no user feedback'
    );
  });
});

describe('Browser.jsx — handleTableDrop has error handling (v1.15.3)', () => {
  const source = src('components/Browser.jsx');

  test('collectFileEntries .then() in handleTableDrop is followed by .catch()', () => {
    const fnStart = source.indexOf('function handleTableDrop');
    assert.ok(fnStart !== -1, 'handleTableDrop must exist in Browser.jsx');
    const fnBody = source.slice(fnStart, fnStart + 800);
    assert.ok(
      /\.catch\(/.test(fnBody),
      'handleTableDrop must chain .catch() onto the collectFileEntries .then() — ' +
      'an unhandled rejection from collectFileEntries silently swallows the drop with no user feedback'
    );
  });
});

// ── BUG-026: _initExtractedRegion must not bail on initial.regionOverride ────────────────
// When a profile is loaded, its stored regionOverride causes _initExtractedRegion to return
// null early, making userEditedRef.current.region always true and disabling endpoint→region
// inference for all subsequent edits. Changing the endpoint left the region permanently stale.
// Fix: only bail when initial.endpoint is absent; always compute the extraction so the
// stored value can be compared to the extracted one.

describe('CredentialForm.jsx — _initExtractedRegion does not bail on regionOverride (BUG-026)', () => {
  const source = src('components/CredentialForm.jsx');

  test('_initExtractedRegion IIFE does not short-circuit on initial.regionOverride', () => {
    // The bad pattern: `if (initial.regionOverride || !initial.endpoint) return null`
    // The good pattern: `if (!initial.endpoint) return null`  (no regionOverride guard)
    assert.ok(
      !/if\s*\(\s*initial\.regionOverride\s*\|\|/.test(source),
      'CredentialForm.jsx _initExtractedRegion must not bail on initial.regionOverride — ' +
      'that made the region always "user-edited" for loaded profiles, silently sending the ' +
      'wrong region to the S3 client after any endpoint change (BUG-026)'
    );
  });
});

// ── BUG-027: handleDisconnect must call setLiveFormData ───────────────────────────────────
// handleDisconnect cleared credentials to empty but not liveFormData. Combined with
// selectedProfileId not being reset, the highlighted profile row became un-clickable
// (same key → no CredentialForm remount), leaving the splash screen with blank fields
// and a selected profile that couldn't repopulate the form.
// Fix: handleDisconnect calls setLiveFormData (and sets credentials from the profile).

describe('App.jsx — handleDisconnect calls setLiveFormData (BUG-027)', () => {
  const source = src('components/App.jsx');

  test('handleDisconnect body includes setLiveFormData', () => {
    const fnStart = source.indexOf('function handleDisconnect');
    assert.ok(fnStart !== -1, 'handleDisconnect must exist in App.jsx');
    const fnEnd   = source.indexOf('\n  function ', fnStart + 1);
    const fn = source.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 600);
    assert.ok(
      fn.includes('setLiveFormData'),
      'handleDisconnect must call setLiveFormData — without it, the "Save/Update profile" ' +
      'button reflects stale pre-disconnect data, and the profile row is un-clickable ' +
      'because the form never sees the reset credentials (BUG-027)'
    );
  });
});

// ── Simplification pass structural guards ─────────────────────────────────────
// These assertions verify that code simplified during the 2026-06 cleanup pass
// stays organized correctly. They catch accidental drift back to the old patterns.

describe('UploadQueue.jsx — uses shared hooks and helpers', () => {
  const source = src('components/UploadQueue.jsx');

  test('imports useDoubleClickSafety hook (double-click pattern not duplicated inline)', () => {
    assert.ok(
      source.includes("from '../hooks/useDoubleClickSafety.js'"),
      'UploadQueue.jsx must import useDoubleClickSafety — the prime/confirm pattern must not be written inline again'
    );
  });

  test('UploadItem.jsx imports useInterpolatedProgress hook (rAF animation not duplicated inline)', () => {
    const uploadItemSource = src('components/UploadItem.jsx');
    assert.ok(
      uploadItemSource.includes("from '../hooks/useInterpolatedProgress.js'"),
      'UploadItem.jsx must import useInterpolatedProgress — the rAF byte animation must not be written inline again'
    );
  });

  test('imports upload status predicates (inline status chains not duplicated)', () => {
    assert.ok(
      source.includes("from '../lib/upload-status.js'"),
      'UploadQueue.jsx must import status predicates (isActive, isFailed, …) from upload-status.js'
    );
  });

  test('imports abortMultipartSession (abort+cleanup sequence not duplicated inline)', () => {
    assert.ok(
      source.includes("from '../lib/upload-cleanup.js'"),
      'UploadQueue.jsx must import abortMultipartSession — abort+deleteResumeRecord must not be copy-pasted again'
    );
  });

  test('imports constants from constants.js (thresholds not defined inline)', () => {
    assert.ok(
      source.includes("from '../lib/constants.js'"),
      'UploadQueue.jsx must import MULTIPART_THRESHOLD and other constants from constants.js'
    );
  });

});

describe('Browser.jsx — uses shared utilities', () => {
  const source = src('components/Browser.jsx');

  test('BatchCopyLinkPopover does not exist as a separate function (merged into CopyLinkPopover)', () => {
    assert.ok(
      !source.includes('function BatchCopyLinkPopover'),
      'BatchCopyLinkPopover was merged into CopyLinkPopover — it must not be re-introduced as a separate function'
    );
  });

  test('imports validateObjectName (name validation not duplicated inline)', () => {
    assert.ok(
      source.includes("from '../lib/validate-object-name.js'"),
      'Browser.jsx must import validateObjectName from validate-object-name.js'
    );
  });

  test('imports constants from constants.js', () => {
    assert.ok(
      source.includes("from '../lib/constants.js'"),
      'Browser.jsx must import PRESIGN_EXPIRES and other constants from constants.js'
    );
  });
});

describe('constants.js — all centralized thresholds present', () => {
  const source = src('lib/constants.js');
  test('exports MULTIPART_THRESHOLD', () => { assert.ok(source.includes('MULTIPART_THRESHOLD')); });
  test('exports PRESIGN_EXPIRES',     () => { assert.ok(source.includes('PRESIGN_EXPIRES')); });
  test('exports COPY_LINK_PRESETS',   () => { assert.ok(source.includes('COPY_LINK_PRESETS')); });
  test('exports COPY_MULTIPART_THRESHOLD', () => {
    assert.ok(
      source.includes('COPY_MULTIPART_THRESHOLD'),
      'constants.js must export COPY_MULTIPART_THRESHOLD — the 5 GiB ceiling above which ' +
      'a move switches from single-request CopyObject to multipart UploadPartCopy'
    );
  });
});

// ── Move feature: multipart server-side copy uses UploadPartCopy (T1-2 defense-in-depth) ──
// UploadPartCopyCommand is a genuinely new SDK import — used nowhere else in src/. The
// T1-2 auto-scan guarantees it is imported wherever `new UploadPartCopyCommand(` appears,
// but this pins that the multipart-copy path actually uses it (and inclusive byte ranges),
// so a refactor cannot silently drop the >5 GiB copy path.

describe('move-multipart.js — uses UploadPartCopy with CopySourceRange', () => {
  const source = src('lib/move-multipart.js');

  test('references UploadPartCopyCommand', () => {
    assert.ok(
      source.includes('UploadPartCopyCommand'),
      'move-multipart.js must use UploadPartCopyCommand — it is the only server-side copy ' +
      'path for objects above the 5 GiB single-request CopyObject cap'
    );
  });

  test('sets CopySourceRange for byte-range part copies', () => {
    assert.ok(
      source.includes('CopySourceRange'),
      'move-multipart.js must set CopySourceRange on each UploadPartCopy — without per-part ' +
      'byte ranges the multipart copy is incorrect'
    );
  });

  test('aborts the multipart session on failure (no orphaned upload, source never deleted)', () => {
    assert.ok(
      source.includes('AbortMultipartUploadCommand'),
      'move-multipart.js must abort the multipart upload on any failure so a partial copy ' +
      'does not linger and the source is never deleted'
    );
  });
});

describe('constants.js — FILE_MTIME_KEY exported', () => {
  const source = src('lib/constants.js');
  test('exports FILE_MTIME_KEY', () => {
    assert.ok(
      source.includes('FILE_MTIME_KEY'),
      'constants.js must export FILE_MTIME_KEY — the S3 Metadata key used to store ' +
      'the original file modification time; a shared constant prevents typos across ' +
      'UploadQueue.jsx, Browser.jsx, and DownloadPage.jsx'
    );
  });
});

describe('Browser.jsx — file-mtime formatted in properties modal', () => {
  const source = src('components/Browser.jsx');

  test('properties modal special-cases FILE_MTIME_KEY as a formatted date row', () => {
    assert.ok(
      source.includes('FILE_MTIME_KEY') || source.includes('file-mtime'),
      'Browser.jsx properties modal must special-case FILE_MTIME_KEY — ' +
      'without this, the mtime appears as a raw ISO string under "x-amz-meta-file-mtime" ' +
      'rather than as a labelled, human-readable date row'
    );
  });

  test('FILE_MTIME_KEY row excluded from generic custom metadata loop', () => {
    assert.ok(
      /custom\.filter|k !== FILE_MTIME_KEY|k !== 'file-mtime'/.test(source),
      'Browser.jsx must exclude FILE_MTIME_KEY from the generic x-amz-meta-* loop — ' +
      'otherwise the mtime appears twice: once formatted and once as a raw string'
    );
  });
});

describe('upload-status.js — all predicates present', () => {
  const source = src('lib/upload-status.js');
  test('exports isActive',  () => { assert.ok(source.includes('export const isActive')); });
  test('exports isFailed',  () => { assert.ok(source.includes('export const isFailed')); });
  test('exports isSettled', () => { assert.ok(source.includes('export const isSettled')); });
  test('exports isPaused',  () => { assert.ok(source.includes('export const isPaused')); });
});

describe('indexeddb.js — is a barrel re-export (no new logic)', () => {
  const source = src('lib/indexeddb.js');

  test('does not define openDB directly (openDB lives in indexeddb-core.js)', () => {
    assert.ok(
      !source.includes('function openDB'),
      'indexeddb.js must not define openDB — it is a barrel; openDB lives in indexeddb-core.js'
    );
  });

  test('re-exports saveResumeRecord from resume-records.js', () => {
    assert.ok(source.includes("from './resume-records.js'"));
  });

  test('re-exports uploadExpiryWarningMs from file-identity.js', () => {
    assert.ok(source.includes("from './file-identity.js'"));
  });
});

describe('UploadQueue.jsx — object metadata set on both upload paths', () => {
  const source = src('components/UploadQueue.jsx');

  // Both upload paths build their S3 Metadata via buildUploadMetadata(file, hashValue),
  // which always stamps the original file mtime (FILE_MTIME_KEY) and, when a hash is
  // available, Bucketer's content-hash stamp (a duplicate-detection candidate filter).
  // upload-metadata.test.js pins that the mtime is always present and the hash key is
  // omitted when absent.
  function uploadSmallBody() {
    const fnStart = source.indexOf('async function uploadSmall(');
    assert.ok(fnStart !== -1, 'uploadSmall must exist in UploadQueue.jsx');
    const fnEnd = source.indexOf('\n  async function ', fnStart + 1);
    return source.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 800);
  }

  test('uploadSmall PutObjectCommand sets Metadata via buildUploadMetadata', () => {
    assert.ok(
      uploadSmallBody().includes('buildUploadMetadata('),
      'uploadSmall must set PutObjectCommand Metadata via buildUploadMetadata — the original ' +
      'file modification time is discarded without this; once lost, it cannot be recovered'
    );
  });

  test('uploadSmall stamps the content hash (buildContentHashValue)', () => {
    assert.ok(
      uploadSmallBody().includes('buildContentHashValue('),
      'uploadSmall must stamp the content hash so the object is a cheap duplicate-detection ' +
      'candidate on a later scan'
    );
  });

  test('uploadMultipart CreateMultipartUploadCommand sets Metadata via buildUploadMetadata', () => {
    const fnStart = source.indexOf('async function uploadMultipart(');
    assert.ok(fnStart !== -1, 'uploadMultipart must exist in UploadQueue.jsx');
    // CreateMultipartUploadCommand is the first S3 call in this function
    const createStart = source.indexOf('CreateMultipartUploadCommand', fnStart);
    assert.ok(createStart !== -1, 'CreateMultipartUploadCommand must exist in uploadMultipart');
    const callEnd = source.indexOf('})', createStart);
    const call = source.slice(createStart, callEnd + 2);
    assert.ok(
      call.includes('buildUploadMetadata('),
      'uploadMultipart CreateMultipartUploadCommand must set Metadata via buildUploadMetadata — ' +
      'multipart metadata must be set at creation, not in UploadPartCommand'
    );
  });

  test('uploadMultipart computes the hash once and stamps it', () => {
    const fnStart = source.indexOf('async function uploadMultipart(');
    const fnEnd = source.indexOf('\n  async function ', fnStart + 1);
    const fn = source.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 4000);
    assert.ok(
      fn.includes('computeFileHash(file)') && fn.includes('buildContentHashValue('),
      'uploadMultipart must compute the content hash once and stamp it (reusing it for the ' +
      'resume record), so the object is a cheap duplicate-detection candidate on a later scan'
    );
  });
});

describe('Browser.jsx — File Modified column with background HeadObject loading', () => {
  const source = src('components/Browser.jsx');

  test('declares fileMtimeCacheRef for session-local HeadObject cache', () => {
    assert.ok(
      source.includes('fileMtimeCacheRef'),
      'Browser.jsx must declare fileMtimeCacheRef — a useRef Map that caches file-mtime ' +
      'HeadObject results for the current session, preventing redundant re-fetches on pagination'
    );
  });

  test('has HeadObjectCommand call inside mtime-loading useEffect', () => {
    assert.ok(
      /fileMtimeCacheRef[\s\S]{0,2000}HeadObjectCommand|HeadObjectCommand[\s\S]{0,500}fileMtimeCacheRef/.test(source),
      'Browser.jsx must call HeadObjectCommand inside the mtime-loading useEffect — ' +
      'the File Modified column requires HeadObject since ListObjectsV2 does not return custom metadata'
    );
  });

  test('renders col-file-modified table column', () => {
    assert.ok(
      source.includes('col-file-modified'),
      'Browser.jsx must include a "File Modified" column in the file table'
    );
  });
});

describe('Browser.jsx — file-mtime loading is opt-in (default off)', () => {
  const source = src('components/Browser.jsx');

  test('declares mtimeLoadEnabled state initialized from loadFileMtimeAutoLoad', () => {
    assert.ok(
      source.includes('mtimeLoadEnabled') && source.includes('loadFileMtimeAutoLoad'),
      'Browser.jsx must declare mtimeLoadEnabled state initialised from loadFileMtimeAutoLoad — ' +
      'the File Modified column must be opt-in; HeadObject requests must not fire until ' +
      'the user clicks the column header or enables the setting'
    );
  });

  test('HeadObject mtime effect is gated on mtimeLoadEnabled', () => {
    assert.ok(
      /if\s*\(!mtimeLoadEnabled/.test(source),
      'Browser.jsx mtime loading useEffect must bail with `if (!mtimeLoadEnabled ...) return` — ' +
      'without this guard, HeadObject calls fire automatically for every listed file, ' +
      'incurring one API call per file per page load without user consent'
    );
  });

  test('col-file-modified header has onClick to enable loading', () => {
    assert.ok(
      /col-file-modified[\s\S]{0,300}onClick|onClick[\s\S]{0,100}setMtimeLoadEnabled/.test(source),
      'Browser.jsx must wire an onClick to the col-file-modified header — clicking it ' +
      'is the primary way to opt in to loading file modification times'
    );
  });
});

// ── BUG-029: onUploadsComplete must not remount Browser ────────────────────────
// Wiring onUploadsComplete to setBrowserKey forced a full Browser remount when
// the upload queue drained. The remount reset prefix to root (because the
// post-mount initial-state branch ignores isFirstMount=false), nuked the URL
// hash prefix param via replaceState, and reset selection / filter / listing
// cache. Net effect: every upload teleported the user back to the bucket root,
// regardless of which folder they were viewing — including folders they had
// nothing to do with the upload (e.g. uploaded to A, navigated to B mid-upload,
// got reset to root). Fix: pass the set of completed parent prefixes from
// UploadQueue, invalidate just those cache entries, and refetch only if the
// user is still in one of them.

describe('App.jsx — onUploadsComplete must not remount Browser (BUG-029)', () => {
  const source = src('components/App.jsx');

  test('onUploadsComplete handler does not call setBrowserKey', () => {
    const m = source.match(/onUploadsComplete\s*=\s*\{([^}]+)\}/);
    assert.ok(m, 'App.jsx must wire onUploadsComplete on the UploadQueue component');
    assert.ok(
      !/setBrowserKey/.test(m[1]),
      `onUploadsComplete handler must not call setBrowserKey — that triggers a full ` +
      `Browser remount which resets prefix, URL hash, selection, and filter. ` +
      `Current handler: ${m[1].trim()}`
    );
  });

  test('onUploadsComplete handler delegates to browserActionsRef.onUploadsDrained', () => {
    const m = source.match(/onUploadsComplete\s*=\s*\{([^}]+)\}/);
    assert.ok(m, 'App.jsx must wire onUploadsComplete on the UploadQueue component');
    assert.ok(
      /browserActionsRef[\s\S]*onUploadsDrained/.test(m[1]),
      `onUploadsComplete handler must delegate to browserActionsRef.current.onUploadsDrained — ` +
      `that method does targeted cache invalidation per affected prefix and refetches only ` +
      `when the user is in one of them. Current handler: ${m[1].trim()}`
    );
  });
});

describe('Browser.jsx — onUploadsDrained action exposed via onMount (BUG-029)', () => {
  const source = src('components/Browser.jsx');

  test('onMount payload includes onUploadsDrained', () => {
    assert.ok(
      /onMount\?\.\(\s*\{[^}]*onUploadsDrained[^}]*\}\s*\)/.test(source),
      'Browser.jsx must expose onUploadsDrained via the onMount actions object — ' +
      'App.jsx calls it through browserActionsRef.current after each upload batch drains'
    );
  });

  test('onUploadsDrained function is defined and uses prefixRef + invalidateCache + fetchPage', () => {
    const m = source.match(/function\s+onUploadsDrained\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(m, 'Browser.jsx must define an onUploadsDrained function');
    const body = m[1];
    assert.ok(/invalidateCache/.test(body), 'onUploadsDrained must invalidate cache for each completed prefix');
    assert.ok(/fetchPage/.test(body),       'onUploadsDrained must refetch the current prefix when affected');
    assert.ok(/prefixRef/.test(body),       'onUploadsDrained must read prefixRef (live prefix) not the captured closure');
  });
});

describe('UploadQueue.jsx — onUploadsComplete passes drained prefix set (BUG-029)', () => {
  const source = src('components/UploadQueue.jsx');

  test('drainedPrefixesRef accumulator declared', () => {
    assert.ok(
      /drainedPrefixesRef\s*=\s*useRef\(\s*new Set\(\)\s*\)/.test(source),
      'UploadQueue.jsx must declare drainedPrefixesRef as a useRef(new Set()) — ' +
      'this accumulates parent prefixes of successful uploads since the last drain fire'
    );
  });

  test('drain effect passes the accumulator and resets it', () => {
    assert.ok(
      /onUploadsComplete\?\.\(\s*drained\s*\)/.test(source),
      'UploadQueue.jsx drain effect must call onUploadsComplete?.(drained) so App can route the affected-prefixes set to Browser'
    );
    assert.ok(
      /drainedPrefixesRef\.current\s*=\s*new Set\(\)/.test(source),
      'UploadQueue.jsx drain effect must reset drainedPrefixesRef to a fresh Set so the next batch starts clean'
    );
  });

  test('success path records parentPrefix(destinationKey)', () => {
    assert.ok(
      /drainedPrefixesRef\.current\.add\(\s*parentPrefix\(destinationKey\)\s*\)/.test(source),
      'UploadQueue.jsx must call drainedPrefixesRef.current.add(parentPrefix(destinationKey)) ' +
      'right after marking an item status:"done" — this is the seam between per-file completion ' +
      'and per-batch drain notification'
    );
  });
});

describe('DuplicatesModal.jsx — buttons declare an explicit type (BUG-006)', () => {
  const source = src('components/DuplicatesModal.jsx');

  test('every <button> sets an explicit type attribute', () => {
    const buttons = source.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length > 0, 'DuplicatesModal.jsx should contain buttons');
    for (const b of buttons) {
      assert.ok(/\btype=/.test(b), `button without an explicit type would default to submit: ${b}`);
    }
  });

  test('Delete others and Move others are rendered disabled in iteration 1', () => {
    // Destructive actions must not be operable until the detection/verification workflow
    // passes UAT (iteration 2), and even then only for verified groups.
    for (const cls of ['dup-delete', 'dup-move']) {
      const idx = source.indexOf(cls);
      assert.ok(idx !== -1, `${cls} button must exist`);
      const tag = source.slice(source.lastIndexOf('<button', idx), source.indexOf('>', idx) + 1);
      assert.ok(/\bdisabled\b/.test(tag), `${cls} must be rendered disabled in iteration 1: ${tag}`);
    }
  });
});

// ── Drag-and-drop move wiring (v1.26.0) ───────────────────────────────────────────────
// Dragging an object row onto a folder row or breadcrumb crumb moves it. Two regressions
// to guard: (1) internal object drags must be told apart from OS file drags by the 'Files'
// DataTransfer type, or every internal drag wrongly raises the "Drop files to upload"
// overlay; (2) the rows must actually be draggable and wired to the move handlers.

describe('Browser.jsx — drag-and-drop move wiring (v1.26.0)', () => {
  const source = src('components/Browser.jsx');

  test('imports the pure drag helpers from move-drag.js', () => {
    assert.ok(
      source.includes("from '../lib/move-drag.js'") && /dragPayload/.test(source) && /dropAccepted/.test(source),
      'Browser.jsx must import dragPayload/dropAccepted — the drag payload and drop-validity decisions ' +
      'live in src/lib/move-drag.js so they are unit-testable without a DragEvent'
    );
  });

  test('handleTableDragEnter gates the upload overlay on the Files type', () => {
    const fnStart = source.indexOf('function handleTableDragEnter');
    assert.ok(fnStart !== -1, 'handleTableDragEnter must exist');
    const fn = source.slice(fnStart, fnStart + 400);
    assert.ok(
      /types\?\.includes\('Files'\)/.test(fn),
      'handleTableDragEnter must return early unless the drag carries OS files — otherwise an ' +
      'internal object-move drag wrongly raises the "Drop files to upload" overlay'
    );
  });

  test('file and folder rows are draggable and wired to handleRowDragStart', () => {
    const draggableGated = source.match(/draggable=\{canMove && renamingKey/g) || [];
    assert.equal(draggableGated.length, 2, 'both folder and file rows must be draggable, gated off while renaming that row');
    assert.ok(/onDragStart=\{e => handleRowDragStart/.test(source), 'rows must wire onDragStart to handleRowDragStart');
  });

  test('folder rows are drop targets wired to handleInternalDrop', () => {
    assert.ok(
      /onDrop=\{e => handleInternalDrop\(cp/.test(source),
      'folder rows must accept an internal drop via handleInternalDrop(cp, e)'
    );
  });

  test('Breadcrumb is wired as a move drop target', () => {
    assert.ok(
      /onMoveDrop=\{handleInternalDrop\}/.test(source) && /moveHoverTarget=\{dndHoverTarget\}/.test(source),
      'Breadcrumb must receive onMoveDrop + moveHoverTarget so crumbs become move-up drop targets'
    );
  });
});
