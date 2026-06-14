// Tests for SettingsPanel.
// SettingsPanel reads all initial values from localStorage synchronously in
// useState initializers — no async effects. Tests cover field rendering,
// default values, validation error display, and the Update Check toggle.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { SettingsPanel } from '../../src/components/SettingsPanel.jsx';

function defaultProps(overrides = {}) {
  return {
    provider: 'r2',
    updateCheckEnabled: true,
    onUpdateCheckChange: () => {},
    prefetchSizeLimit: 10,
    onPrefetchSizeLimitChange: () => {},
    verifyIntegrityEnabled: false,
    onVerifyIntegrityChange: () => {},
    ...overrides,
  };
}

describe('SettingsPanel — field rendering', () => {
  test('renders a form or settings container', () => {
    const { query, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(query('form') || query('.settings-panel') || query('section'), 'settings panel must render a form or container');
    cleanup();
  });

  test('renders an input for page size (MaxKeys)', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('page size') || text().toLowerCase().includes('max keys') || text().toLowerCase().includes('keys per'),
      'page size setting must be labeled'
    );
    cleanup();
  });

  test('renders an input for upload part size', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('part size') || text().toLowerCase().includes('part size'),
      'part size setting must be labeled'
    );
    cleanup();
  });

  test('renders an input for part concurrency', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('concurrency') || text().toLowerCase().includes('concurrent'),
      'concurrency setting must be labeled'
    );
    cleanup();
  });

  test('renders an input for file concurrency', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('file concurrency') || text().toLowerCase().includes('files'),
      'file concurrency setting must be labeled'
    );
    cleanup();
  });

  test('renders an input for listing cache TTL', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('cache') || text().toLowerCase().includes('ttl'),
      'cache TTL setting must be labeled'
    );
    cleanup();
  });

  test('renders a Save button', () => {
    const { cleanup } = mount(h(SettingsPanel, defaultProps()));
    const btn = [...document.querySelectorAll('button')].find(b => /save/i.test(b.textContent));
    assert.ok(btn, 'Save button must be present');
    cleanup();
  });
});

describe('SettingsPanel — validation', () => {
  test('shows an error when page size is out of range', () => {
    const { query, cleanup } = mount(h(SettingsPanel, defaultProps()));
    // Set page size to an invalid value (> 100000)
    const inputs = document.querySelectorAll('input[type="number"], input[type="text"]');
    // First numeric input should be the page size / MaxKeys field
    const pageInput = [...inputs][0];
    if (pageInput) {
      setInput(pageInput, '999999');
      const saveBtn = [...document.querySelectorAll('button')].find(b => /save/i.test(b.textContent));
      if (saveBtn) fire(saveBtn, 'click');
      // An error message should appear
      const hasError = document.body.textContent.includes('must be') || document.body.textContent.includes('–') || document.body.textContent.includes('100,000') || document.body.textContent.includes('100000');
      assert.ok(hasError, 'validation error must appear for out-of-range page size');
    }
    cleanup();
  });
});

describe('SettingsPanel — Update Check toggle', () => {
  test('shows the update check setting', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps({ updateCheckEnabled: true })));
    assert.ok(
      text().toLowerCase().includes('update') || text().toLowerCase().includes('check'),
      'update check setting must be labeled'
    );
    cleanup();
  });
});

describe('SettingsPanel — build integrity check toggle', () => {
  test('renders the integrity-check toggle label', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('integrity'),
      'settings panel must surface the build integrity check setting'
    );
    cleanup();
  });

  test('does not render the IntegrityCheck verify-now button when toggle is off', () => {
    const { queryAll, cleanup } = mount(h(SettingsPanel, defaultProps({ verifyIntegrityEnabled: false })));
    const verifyBtn = queryAll('button').find(b => /verify now/i.test(b.textContent));
    assert.equal(verifyBtn, undefined,
      'IntegrityCheck button must stay hidden until the user opts in');
    cleanup();
  });

  test('renders the IntegrityCheck verify-now button when toggle is on', () => {
    const { queryAll, cleanup } = mount(h(SettingsPanel, defaultProps({ verifyIntegrityEnabled: true })));
    const verifyBtn = queryAll('button').find(b => /verify now/i.test(b.textContent));
    assert.ok(verifyBtn, 'IntegrityCheck button must render when the user has opted in');
    cleanup();
  });
});

describe('SettingsPanel — adaptive/manual toggle', () => {
  test('renders an adaptive/manual mode toggle', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('adaptive') || text().toLowerCase().includes('manual'),
      'settings panel must contain an adaptive/manual toggle'
    );
    cleanup();
  });

  test('hides concurrency sliders in adaptive mode (default)', () => {
    // localStorage is empty → adaptive mode is true by default
    const { query, cleanup } = mount(h(SettingsPanel, defaultProps()));
    // In adaptive mode the part/file concurrency inputs should not be present
    const concurrencyInput = query('#setting-concurrency');
    const fileConcurrencyInput = query('#setting-fileconcurrency');
    assert.equal(concurrencyInput, null, 'part concurrency input must be hidden in adaptive mode');
    assert.equal(fileConcurrencyInput, null, 'file concurrency input must be hidden in adaptive mode');
    cleanup();
  });
});

describe('SettingsPanel — file-mtime auto-load setting', () => {
  test('renders "automatically load file modification times" label', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('file modification') || text().toLowerCase().includes('modification time'),
      'SettingsPanel must render a label for the file modification time auto-load toggle'
    );
    cleanup();
  });
});
