// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/browser-capability.js.
//
// The governing rule, from docs/review-download-parity: capability is decided by asking the
// browser what it supports, never by what it calls itself. Browser identity strings are
// trivially altered and change meaning between releases; the API either exists or it does
// not. These tests exist largely to keep a user-agent check from creeping in later.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCapabilities, availableTiers, selectTier, tierLabel, TIERS,
} from '../src/lib/browser-capability.js';

// Minimal window stand-ins. Each names the real engine it mirrors, measured 2026-07-31.
const chromiumDesktop = {
  showDirectoryPicker: () => {}, showSaveFilePicker: () => {},
  FileSystemFileHandle: { prototype: { createWritable: () => {} } },
  navigator: { storage: { getDirectory: () => {}, estimate: () => {} } },
  Response: { prototype: { body: null } },
};

const firefoxDesktop = {
  // No pickers — Mozilla's standards position is negative — but OPFS is present.
  FileSystemFileHandle: { prototype: { createWritable: () => {} } },
  navigator: { storage: { getDirectory: () => {}, estimate: () => {} } },
  Response: { prototype: { body: null } },
};

const noStorage = {
  navigator: {},
  Response: { prototype: { body: null } },
};

describe('detectCapabilities', () => {
  test('sees a full-capability engine', () => {
    const c = detectCapabilities(chromiumDesktop);
    assert.equal(c.directoryPicker, true);
    assert.equal(c.writableFiles, true);
    assert.equal(c.opfs, true);
    assert.equal(c.streamingFetch, true);
  });

  test('sees an engine with private storage but no pickers', () => {
    const c = detectCapabilities(firefoxDesktop);
    assert.equal(c.directoryPicker, false);
    assert.equal(c.opfs, true);
  });

  test('sees an engine with neither', () => {
    const c = detectCapabilities(noStorage);
    assert.equal(c.directoryPicker, false);
    assert.equal(c.opfs, false);
  });

  test('never throws on a bare object', () => {
    assert.doesNotThrow(() => detectCapabilities({}));
  });

  // Reading a getter off a prototype invokes it with the wrong receiver and throws
  // "Illegal invocation" in a real browser. Presence must be tested without reading.
  test('does not read prototype getters', () => {
    const win = {
      navigator: {},
      Response: { prototype: {} },
    };
    Object.defineProperty(win.Response.prototype, 'body', {
      get() { throw new TypeError('Illegal invocation'); },
      configurable: true,
    });
    assert.doesNotThrow(() => detectCapabilities(win));
    assert.equal(detectCapabilities(win).streamingFetch, true);
  });
});

describe('availableTiers', () => {
  test('the handoff tier is always available', () => {
    assert.equal(availableTiers(detectCapabilities(noStorage)).includes(TIERS.HANDOFF), true);
  });

  test('a full engine offers all three, best first', () => {
    assert.deepEqual(availableTiers(detectCapabilities(chromiumDesktop)),
      [TIERS.MANAGED_FOLDER, TIERS.STAGED, TIERS.HANDOFF]);
  });

  test('private storage without pickers offers two', () => {
    assert.deepEqual(availableTiers(detectCapabilities(firefoxDesktop)),
      [TIERS.STAGED, TIERS.HANDOFF]);
  });
});

describe('selectTier', () => {
  const chromium = detectCapabilities(chromiumDesktop);
  const firefox = detectCapabilities(firefoxDesktop);
  const bare = detectCapabilities(noStorage);
  const GiB = 1024 ** 3;

  test('prefers a real folder when the browser can write one', () => {
    assert.equal(selectTier(chromium, { largestFileBytes: 500 * GiB }), TIERS.MANAGED_FOLDER);
  });

  test('a chosen folder has no quota ceiling, so size never demotes it', () => {
    assert.equal(selectTier(chromium, { largestFileBytes: 900 * GiB, quotaBytes: 10 * GiB }),
      TIERS.MANAGED_FOLDER);
  });

  test('falls to staging when there is no picker', () => {
    assert.equal(selectTier(firefox, { largestFileBytes: 2 * GiB, quotaBytes: 40 * GiB }),
      TIERS.STAGED);
  });

  // Staging holds one file at a time, so the ceiling is the largest single file, not the
  // job total. A 500 GB job of small files stages perfectly well.
  test('judges staging on the largest file, not the job total', () => {
    assert.equal(
      selectTier(firefox, { largestFileBytes: 1 * GiB, totalBytes: 500 * GiB, quotaBytes: 10 * GiB }),
      TIERS.STAGED);
  });

  test('hands off when the largest file will not fit in the quota', () => {
    assert.equal(selectTier(firefox, { largestFileBytes: 40 * GiB, quotaBytes: 10 * GiB }),
      TIERS.HANDOFF);
  });

  test('stages optimistically when the quota is unknown', () => {
    // A quota failure is catchable at runtime and can fall back; refusing up front would
    // deny the better mechanism to every browser that does not report a quota.
    assert.equal(selectTier(firefox, { largestFileBytes: 2 * GiB }), TIERS.STAGED);
  });

  test('hands off when nothing else is available', () => {
    assert.equal(selectTier(bare, { largestFileBytes: 1 }), TIERS.HANDOFF);
  });

  test('an explicit preference is honoured when that tier is available', () => {
    assert.equal(selectTier(chromium, { largestFileBytes: 1, prefer: TIERS.HANDOFF }),
      TIERS.HANDOFF);
  });

  test('an explicit preference is ignored when that tier is not available', () => {
    assert.equal(selectTier(bare, { largestFileBytes: 1, prefer: TIERS.MANAGED_FOLDER }),
      TIERS.HANDOFF);
  });
});

describe('tierLabel', () => {
  test('every tier has a label', () => {
    for (const t of Object.values(TIERS)) {
      assert.equal(typeof tierLabel(t), 'string');
      assert.ok(tierLabel(t).length > 0);
    }
  });
});

// The mobile signal is advisory only. Capability is decided by feature detection; this
// exists so the UI can warn about backgrounding and memory, which are not detectable.
describe('mobile hint', () => {
  test('is read from the structured hint when present', () => {
    const win = { ...chromiumDesktop, navigator: { ...chromiumDesktop.navigator, userAgentData: { mobile: true } } };
    assert.equal(detectCapabilities(win).likelyMobile, true);
  });

  test('falls back to a coarse-pointer media query', () => {
    const win = { ...firefoxDesktop, matchMedia: (q) => ({ matches: q.includes('coarse') }) };
    assert.equal(detectCapabilities(win).likelyMobile, true);
  });

  test('is false when nothing indicates it', () => {
    assert.equal(detectCapabilities(chromiumDesktop).likelyMobile, false);
  });

  test('SECURITY OF REASONING: the hint never changes which tiers are available', () => {
    const desktop = detectCapabilities(chromiumDesktop);
    const mobile = detectCapabilities({
      ...chromiumDesktop,
      navigator: { ...chromiumDesktop.navigator, userAgentData: { mobile: true } },
    });
    assert.deepEqual(availableTiers(mobile), availableTiers(desktop));
  });
});
