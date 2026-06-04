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
