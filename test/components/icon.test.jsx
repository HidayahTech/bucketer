// Icon (look B, v1.65.0): inline SVG replacing emoji glyphs on controls (REPORT A3).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { Icon, fileIconName } from '../../src/components/Icon.jsx';

describe('Icon', () => {
  test('renders a decorative svg (aria-hidden, not focusable)', () => {
    const { query, cleanup } = mount(h(Icon, { name: 'trash' }));
    const svg = query('svg');
    assert.ok(svg, 'an svg is rendered');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('focusable'), 'false');
    assert.equal(svg.getAttribute('data-icon'), 'trash');
    assert.ok(svg.querySelector('path'), 'the icon has a shape');
    cleanup();
  });

  test('an unknown name renders nothing rather than a broken box', () => {
    const { query, cleanup } = mount(h(Icon, { name: 'no-such-icon' }));
    assert.equal(query('svg'), null);
    cleanup();
  });

  test('size sets width and height', () => {
    const { query, cleanup } = mount(h(Icon, { name: 'x', size: 20 }));
    assert.equal(query('svg').getAttribute('width'), '20');
    assert.equal(query('svg').getAttribute('height'), '20');
    cleanup();
  });
});

describe('fileIconName', () => {
  test('maps extensions to type icons, case-insensitively, by the last path segment', () => {
    assert.equal(fileIconName('photos/2026/Beach.JPG'), 'image');
    assert.equal(fileIconName('clip.mp4'), 'video');
    assert.equal(fileIconName('backup.tar.gz'), 'archive');
    assert.equal(fileIconName('report-q3.pdf'), 'file-text');
    assert.equal(fileIconName('song.mp3'), 'file', 'audio has no dedicated icon');
    assert.equal(fileIconName('Makefile'), 'file', 'no extension → generic file');
    assert.equal(fileIconName('dir.jpg/readme'), 'file', 'a dotted folder name does not count');
  });
});
