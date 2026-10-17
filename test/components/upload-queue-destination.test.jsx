// The upload destination since layout A (v1.67.0): UploadTarget names it and edits it, App decides
// whether it crosses a prefix-scoped key's floor (destinationOutsideFloor, unit-tested in
// base-prefix.test.js), UploadMenu is disabled while it does, and UploadQueue still refuses files
// (drops included) while it does (#60: visibly, never a silent autocorrect).
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { UploadTarget } from '../../src/components/UploadTarget.jsx';
import { UploadMenu } from '../../src/components/UploadMenu.jsx';
import { UploadQueue } from '../../src/components/UploadQueue.jsx';

describe('UploadTarget', () => {
  test('names the bucket and folder uploads go to, and exposes the destination for tests', () => {
    const { query, cleanup } = mount(
      h(UploadTarget, { bucket: 'family-photos', destinationPrefix: '2026/trip/', onChange: () => {} }),
    );
    try {
      assert.equal(query('.upload-target-line strong').textContent, 'family-photos / 2026 / trip /');
      assert.equal(query('.upload-target').getAttribute('data-upload-target'), '2026/trip/');
      assert.equal(query('#upload-destination'), null, 'the free-text field is closed by default');
    } finally {
      cleanup();
    }
  });

  test('"Change" opens the free-text destination, and typing reports the new value', () => {
    const typed = [];
    const { query, cleanup } = mount(
      h(UploadTarget, { bucket: 'b', destinationPrefix: '', onChange: (v) => typed.push(v) }),
    );
    try {
      fire(query('.upload-target-change'), 'click');
      assert.equal(query('.upload-target-change').getAttribute('aria-expanded'), 'true');
      setInput(query('#upload-destination'), 'new/place/');
      assert.deepEqual(typed, ['new/place/']);
    } finally {
      cleanup();
    }
  });

  test('outside the floor, the inline error names the base folder', () => {
    const { query, cleanup } = mount(
      h(UploadTarget, {
        bucket: 'b',
        destinationPrefix: 'team/bob/',
        onChange: () => {},
        outsideFloor: true,
        basePrefix: 'team/alice/',
      }),
    );
    try {
      assert.ok(query('.field-error').textContent.includes('team/alice/'));
    } finally {
      cleanup();
    }
  });

  test('inside the floor (or unscoped), no error', () => {
    const { query, cleanup } = mount(h(UploadTarget, { bucket: 'b', destinationPrefix: 'x/', onChange: () => {} }));
    try {
      assert.equal(query('.field-error'), null);
    } finally {
      cleanup();
    }
  });
});

describe('UploadMenu', () => {
  test('disabled while the destination is outside the floor', () => {
    const { query, cleanup } = mount(h(UploadMenu, { onFiles: () => {}, disabled: true, disabledTitle: 'why' }));
    try {
      assert.equal(query('.upload-menu-btn').disabled, true);
      assert.equal(query('.upload-menu-btn').getAttribute('title'), 'why');
    } finally {
      cleanup();
    }
  });

  test('opens Upload files… and Upload a folder…, and keeps the file input the specs drive', () => {
    const { query, queryAll, cleanup } = mount(h(UploadMenu, { onFiles: () => {} }));
    try {
      assert.ok(query('input[data-testid="file-input"]'), 'the hidden file input is always present');
      fire(query('.upload-menu-btn'), 'click');
      const labels = queryAll('.upload-menu button').map((b) => b.textContent);
      assert.deepEqual(labels, ['Upload files…', 'Upload a folder…']);
    } finally {
      cleanup();
    }
  });

  test('chosen files go to onFiles with their names as relative paths', () => {
    const got = [];
    const { query, cleanup } = mount(h(UploadMenu, { onFiles: (entries) => got.push(...entries) }));
    try {
      const input = query('input[data-testid="file-input"]');
      const file = new File(['x'], 'a.txt');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      fire(input, 'change');
      assert.equal(got.length, 1);
      assert.equal(got[0].relativePath, 'a.txt');
    } finally {
      cleanup();
    }
  });
});

describe('UploadQueue — floor guard (#60)', () => {
  function mountQueue(destOutsideFloor) {
    let addFiles = null;
    const activity = [];
    const m = mount(
      h(UploadQueue, {
        client: { send: () => new Promise(() => {}) },
        bucket: 'b',
        provider: 'generic',
        destinationPrefix: 'team/bob/',
        destOutsideFloor,
        credentials: { bucket: 'b', endpoint: 'https://e', basePrefix: 'team/alice/' },
        onCapabilityChange: () => {},
        onUploadsComplete: () => {},
        onLogEntry: () => {},
        onMount: (a) => (addFiles = a.addFiles),
        onActivityChange: (s) => activity.push(s),
      }),
    );
    return { ...m, addFiles: () => addFiles, activity };
  }

  test('outside the floor, added files (drops included) are refused', () => {
    const { addFiles, activity, query, cleanup } = mountQueue(true);
    try {
      addFiles()([{ file: new File(['x'], 'a.txt'), relativePath: 'a.txt' }]);
      assert.equal(query('.upload-queue'), null, 'nothing was queued');
      const last = activity[activity.length - 1];
      assert.equal(last.queued + last.running, 0);
    } finally {
      cleanup();
    }
  });
});
