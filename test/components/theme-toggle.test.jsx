import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mount, fire } from '../helpers/render.js';
import { ThemeToggle } from '../../src/components/ThemeToggle.jsx';
import { loadThemePref } from '../../src/lib/storage.js';

describe('ThemeToggle (#14)', () => {
  beforeEach(() => {
    localStorage.removeItem('s3b_theme');
    document.documentElement.removeAttribute('data-theme');
  });

  test('starts at the System preference', () => {
    const { query, cleanup } = mount(<ThemeToggle />);
    assert.match(query('button').getAttribute('title'), /system/i);
    cleanup();
  });

  test('cycling clicks go system → light → dark → system, persisting + applying each', () => {
    const { query, cleanup } = mount(<ThemeToggle />);
    const btn = query('button');

    fire(btn, 'click'); // → light
    assert.equal(loadThemePref(), 'light');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light');

    fire(btn, 'click'); // → dark
    assert.equal(loadThemePref(), 'dark');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');

    fire(btn, 'click'); // → system (attribute cleared so the media query governs)
    assert.equal(loadThemePref(), 'system');
    assert.equal(document.documentElement.hasAttribute('data-theme'), false);

    cleanup();
  });

  test('restores the saved preference on mount', () => {
    localStorage.setItem('s3b_theme', 'dark');
    const { query, cleanup } = mount(<ThemeToggle />);
    assert.match(query('button').getAttribute('title'), /dark/i);
    cleanup();
  });
});
