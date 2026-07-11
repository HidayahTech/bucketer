// Tests for ShareLinkMenu — the header two-item copy-link menu.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { ShareLinkMenu } from '../../src/components/ShareLinkMenu.jsx';
import { toastStore } from '../../src/lib/toast.js';

// jsdom may define navigator.clipboard as read-only; install a writable stub.
let clipboardText = null;
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (t) => { clipboardText = t; } },
});

const CREDS = {
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'AKID999',
  provider: 'b2',
  regionOverride: 'us-west-002',
};

const buttons = (queryAll) => Array.from(queryAll('button'));
const findButton = (queryAll, label) => buttons(queryAll).find(b => b.textContent.includes(label));
const flush = () => new Promise(r => setTimeout(r, 0));

describe('ShareLinkMenu', () => {
  test('renders the "Copy link" trigger with the menu closed', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS }));
    try {
      assert.ok(findButton(queryAll, 'Copy link'), 'trigger button present');
      assert.equal(query('.share-link-menu'), null, 'menu closed initially');
    } finally { cleanup(); }
  });

  test('clicking the trigger opens both menu items', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.ok(query('.share-link-menu'), 'menu opens');
      assert.ok(findButton(queryAll, 'Connection only'), 'config-only item present');
      assert.ok(findButton(queryAll, 'Include access key ID'), 'key-ID item present');
    } finally { cleanup(); }
  });

  test('"Include access key ID" is disabled when no keyId is set', () => {
    const { queryAll, cleanup } = mount(h(ShareLinkMenu, { credentials: { ...CREDS, keyId: '' } }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.ok(findButton(queryAll, 'Include access key ID').disabled, 'must be disabled without a keyId');
    } finally { cleanup(); }
  });

  test('"Connection only" copies a link with no keyId and the plain toast', async () => {
    clipboardText = null;
    const { queryAll, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      fire(findButton(queryAll, 'Connection only'), 'click');
      await flush();
      assert.ok(clipboardText && !clipboardText.includes('keyId'), 'config-only link omits keyId');
      assert.ok(!clipboardText.includes('AKID999'), 'config-only link omits the key value');
      assert.equal(toastStore.get().at(-1).message, 'Share link copied to clipboard');
    } finally { cleanup(); }
  });

  test('"Include access key ID" copies a link with keyId and the key-ID toast', async () => {
    clipboardText = null;
    const { queryAll, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      fire(findButton(queryAll, 'Include access key ID'), 'click');
      await flush();
      assert.ok(clipboardText.includes('keyId=AKID999'), 'key-ID link includes the key ID');
      assert.ok(!clipboardText.includes('secret'), 'key-ID link never includes a secret');
      assert.equal(
        toastStore.get().at(-1).message,
        'Link with access key ID copied — recipient still needs the secret key',
      );
    } finally { cleanup(); }
  });
});
