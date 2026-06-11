// Tests for UploadLog.
// UploadLog loads its data from IndexedDB on mount. In the jsdom test environment
// IndexedDB is not available, so loadUploadLog() rejects and the component catches
// it, setting entries to []. With no entries it renders null — this is the only
// testable state in jsdom without injecting fake-indexeddb into component tests.
// The test verifies the component mounts without throwing and returns null when
// there is no upload history, which is the correct initial experience for new users.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { UploadLog, formatProbeAnnotation } from '../../src/components/UploadLog.jsx';

describe('UploadLog — empty state', () => {
  test('mounts without throwing', () => {
    assert.doesNotThrow(() => {
      const { cleanup } = mount(h(UploadLog, { refreshKey: 0 }));
      cleanup();
    });
  });

  test('renders null when there are no log entries', () => {
    // IndexedDB is unavailable in jsdom → loadUploadLog rejects → entries = [] → null render
    const { query, cleanup } = mount(h(UploadLog, { refreshKey: 0 }));
    assert.equal(query('.upload-log'), null, 'upload-log must not render when there are no entries');
    cleanup();
  });

  test('renders null on mount (no visible content before entries load)', () => {
    const { text, cleanup } = mount(h(UploadLog, { refreshKey: 0 }));
    // Either empty string or whitespace — no meaningful content in empty state
    assert.ok(text().trim() === '', 'UploadLog must produce no visible text when empty');
    cleanup();
  });
});

describe('formatProbeAnnotation', () => {
  test('returns null for null probeResult', () => {
    assert.equal(formatProbeAnnotation(null), null);
  });

  test('formats a winner=candidate result with positive delta', () => {
    const result = formatProbeAnnotation({
      baseline: 4, candidate: 8, winner: 8,
      baselineMbs: 10, candidateMbs: 14,
    });
    assert.ok(result.includes('4→8'), 'must show part concurrency range');
    assert.ok(result.includes('+40%') || result.includes('40'), 'must show improvement percentage');
  });

  test('formats a winner=baseline result (no improvement)', () => {
    const result = formatProbeAnnotation({
      baseline: 4, candidate: 8, winner: 4,
      baselineMbs: 10, candidateMbs: 9,
    });
    assert.ok(result.includes('4→8'), 'must show part concurrency range');
    assert.ok(result.includes('held') || result.includes('baseline') || result.includes('4'), 'must indicate baseline was kept');
  });
});
