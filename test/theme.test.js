// #14 — manual dark-mode preference: 'system' | 'light' | 'dark'.
// Pure logic for cycling the preference and reflecting it on the document root.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_PREFS, nextThemePref, applyThemeToRoot } from '../src/lib/theme.js';

describe('nextThemePref (#14)', () => {
  test('cycles system → light → dark → system', () => {
    assert.equal(nextThemePref('system'), 'light');
    assert.equal(nextThemePref('light'), 'dark');
    assert.equal(nextThemePref('dark'), 'system');
  });

  test('an unknown preference falls back to system', () => {
    assert.equal(nextThemePref('bogus'), 'system');
    assert.equal(nextThemePref(undefined), 'system');
  });

  test('THEME_PREFS lists the three preferences in cycle order', () => {
    assert.deepEqual(THEME_PREFS, ['system', 'light', 'dark']);
  });
});

describe('applyThemeToRoot (#14)', () => {
  function fakeRoot() {
    return {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
    };
  }

  test('light / dark set data-theme on the root', () => {
    const root = fakeRoot();
    applyThemeToRoot('dark', root);
    assert.equal(root.attrs['data-theme'], 'dark');
    applyThemeToRoot('light', root);
    assert.equal(root.attrs['data-theme'], 'light');
  });

  test('system clears data-theme so the CSS media query governs', () => {
    const root = fakeRoot();
    root.setAttribute('data-theme', 'dark');
    applyThemeToRoot('system', root);
    assert.equal(root.attrs['data-theme'], undefined);
  });

  test('a missing root is a no-op (does not throw)', () => {
    assert.doesNotThrow(() => applyThemeToRoot('dark', null));
  });
});
