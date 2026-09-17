// Tests for ShareLinkMenu — the header copy-link menu (#69: labelled folder choice, key-ID
// modifier). Requires the JSX loader: run via `npm run test:ui`.
import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { ShareLinkMenu } from '../../src/components/ShareLinkMenu.jsx';
import { toastStore } from '../../src/lib/toast.js';
import { setIncludeKeyId } from '../../src/lib/connection-link.js';

// jsdom may define navigator.clipboard as read-only; install a writable stub.
let clipboardText = null;
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (t) => {
      clipboardText = t;
    },
  },
});

const CREDS = {
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'AKID999',
  provider: 'b2',
  regionOverride: 'us-west-002',
};

const buttons = (queryAll) => Array.from(queryAll('button'));
const findButton = (queryAll, label) => buttons(queryAll).find((b) => b.textContent.includes(label));
const flush = () => new Promise((r) => setTimeout(r, 0));
const hashOf = (url) => new URLSearchParams(url.split('#')[1]);

describe('ShareLinkMenu', () => {
  beforeEach(() => {
    clipboardText = null;
    setIncludeKeyId(false);
  });

  test('renders the "Copy link" trigger with the menu closed', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS }));
    try {
      assert.ok(findButton(queryAll, 'Copy link'), 'trigger button present');
      assert.equal(query('.share-link-menu'), null, 'menu closed initially');
    } finally {
      cleanup();
    }
  });

  test('at the root the menu offers only the top-of-bucket item plus the key-ID modifier', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: '' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.ok(query('.share-link-menu'), 'menu opens');
      assert.equal(query('[data-testid="share-link-folder"]'), null, 'no folder item at the root');
      assert.ok(findButton(queryAll, 'top of this bucket'), 'top item present');
      assert.ok(query('.share-link-modifier input[type="checkbox"]'), 'key-ID modifier is a checkbox');
      assert.ok(query('.share-link-menu').textContent.includes('never included'), 'secret disclaimer present');
    } finally {
      cleanup();
    }
  });

  test('inside a folder the folder item comes first and names the folder', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: 'clients/acme/sub/' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      const items = Array.from(query('.share-link-menu').querySelectorAll('button'));
      assert.ok(items[0].textContent.includes('this folder'), 'folder item first');
      assert.ok(items[0].textContent.includes('clients/acme/sub/'), 'names the folder');
      assert.equal(items[0].getAttribute('title'), 'Opens at clients/acme/sub/');
    } finally {
      cleanup();
    }
  });

  test('a scoped connection labels the top item "top of this connection" and shows the folder relative to the floor', () => {
    const { queryAll, cleanup } = mount(
      h(ShareLinkMenu, { credentials: { ...CREDS, basePrefix: 'clients/' }, prefix: 'clients/acme/sub/' }),
    );
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.ok(findButton(queryAll, 'top of this connection'));
      assert.ok(findButton(queryAll, 'this folder (acme/sub/)'), 'relative to the floor');
    } finally {
      cleanup();
    }
  });

  test('at the floor of a scoped connection there is no folder item', () => {
    const { queryAll, query, cleanup } = mount(
      h(ShareLinkMenu, { credentials: { ...CREDS, basePrefix: 'clients/' }, prefix: 'clients/' }),
    );
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.equal(query('[data-testid="share-link-folder"]'), null);
    } finally {
      cleanup();
    }
  });

  test('the key-ID modifier is disabled when no keyId is set', () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: { ...CREDS, keyId: '' } }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.ok(query('.share-link-modifier input').disabled, 'must be disabled without a keyId');
    } finally {
      cleanup();
    }
  });

  test('the folder item copies a link carrying the folder, no keyId, with the folder toast', async () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: 'clients/acme/sub/' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      fire(query('[data-testid="share-link-folder"]'), 'click');
      await flush();
      const p = hashOf(clipboardText);
      assert.equal(p.get('prefix'), 'clients/acme/sub/');
      assert.equal(p.get('keyId'), null);
      assert.ok(!clipboardText.includes('AKID999'));
      assert.equal(toastStore.get().at(-1).message, 'Link copied — opens at clients/acme/sub/');
      assert.equal(query('.share-link-menu'), null, 'menu closes after copying');
    } finally {
      cleanup();
    }
  });

  test('the top item copies a link without the folder and with the top-of-bucket toast', async () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: 'clients/acme/sub/' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      fire(query('[data-testid="share-link-top"]'), 'click');
      await flush();
      assert.equal(hashOf(clipboardText).get('prefix'), null, 'top link carries no folder');
      assert.equal(toastStore.get().at(-1).message, 'Link copied — opens at the top of my-bucket');
    } finally {
      cleanup();
    }
  });

  test('ticking the modifier adds the key ID to either link and the toast says so', async () => {
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: 'clients/acme/sub/' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      const box = query('.share-link-modifier input');
      box.checked = true;
      fire(box, 'change');
      fire(query('[data-testid="share-link-folder"]'), 'click');
      await flush();
      const p = hashOf(clipboardText);
      assert.equal(p.get('keyId'), 'AKID999');
      assert.equal(p.get('prefix'), 'clients/acme/sub/');
      assert.ok(!clipboardText.includes('secret'), 'never a secret');
      const msg = toastStore.get().at(-1).message;
      assert.ok(msg.startsWith('Link copied — opens at clients/acme/sub/'));
      assert.ok(msg.includes('Includes your access key ID. The recipient still needs the secret key.'));
    } finally {
      cleanup();
    }
  });

  test('the modifier choice persists for the session across remounts', async () => {
    setIncludeKeyId(true);
    const { queryAll, query, cleanup } = mount(h(ShareLinkMenu, { credentials: CREDS, prefix: '' }));
    try {
      fire(findButton(queryAll, 'Copy link'), 'click');
      assert.equal(query('.share-link-modifier input').checked, true);
      fire(query('[data-testid="share-link-top"]'), 'click');
      await flush();
      assert.equal(hashOf(clipboardText).get('keyId'), 'AKID999');
    } finally {
      cleanup();
    }
  });
});
