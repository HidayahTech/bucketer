// Unit tests for connection-link.js (#69): folder labels, toast copy, and the shared
// key-ID modifier. Browser globals are stubbed; no DOM needed.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const loc = { protocol: 'https:', origin: 'https://app.example.com', pathname: '/', hash: '' };
global.window = {
  get location() {
    return loc;
  },
};
const store = new Map();
global.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let copied = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (t) => (copied = t) } },
});

const {
  relativeFolderLabel,
  isLinkableFolder,
  linkCopiedMessage,
  getIncludeKeyId,
  setIncludeKeyId,
  copyConnectionLink,
} = await import('../src/lib/connection-link.js');
const { toastStore } = await import('../src/lib/toast.js');

describe('relativeFolderLabel', () => {
  test('shows the folder relative to the floor', () => {
    assert.equal(relativeFolderLabel('team/alice/reports/', 'team/alice/'), 'reports/');
    assert.equal(relativeFolderLabel('clients/acme/sub/', ''), 'clients/acme/sub/');
  });

  test('left-truncates long paths at a segment boundary with an ellipsis', () => {
    const label = relativeFolderLabel('a-very-long-top-level/another-long-segment/final/', '', 20);
    assert.ok(label.startsWith('…/'), label);
    assert.ok(label.endsWith('final/'), label);
    assert.ok(label.length <= 22, label);
  });

  test('a floor the prefix is not under is ignored (defensive)', () => {
    assert.equal(relativeFolderLabel('other/x/', 'team/alice/'), 'other/x/');
  });
});

describe('isLinkableFolder', () => {
  test('false at the root and at the floor, true below the floor', () => {
    assert.equal(isLinkableFolder('', ''), false);
    assert.equal(isLinkableFolder('team/alice/', 'team/alice/'), false);
    assert.equal(isLinkableFolder('team/alice', 'team/alice/'), false, 'normalized before comparing');
    assert.equal(isLinkableFolder('team/alice/2026/', 'team/alice/'), true);
    assert.equal(isLinkableFolder('docs/', ''), true);
  });
});

describe('linkCopiedMessage', () => {
  test('names the folder that travelled', () => {
    assert.equal(
      linkCopiedMessage({ prefix: 'clients/acme/sub/', bucket: 'b' }),
      'Link copied — opens at clients/acme/sub/',
    );
  });

  test('names the bucket top, or the floor when scoped', () => {
    assert.equal(
      linkCopiedMessage({ prefix: '', bucket: 'test-bucket' }),
      'Link copied — opens at the top of test-bucket',
    );
    assert.equal(
      linkCopiedMessage({ prefix: 'team/alice/', floor: 'team/alice/', bucket: 'b' }),
      'Link copied — opens at the top of team/alice/',
    );
  });

  test('adds the key-ID line only when the modifier is on', () => {
    const on = linkCopiedMessage({ prefix: 'x/', bucket: 'b', includeKeyId: true });
    assert.ok(on.includes('Includes your access key ID. The recipient still needs the secret key.'));
    assert.ok(!linkCopiedMessage({ prefix: 'x/', bucket: 'b' }).includes('access key ID'));
  });
});

describe('include-key-ID modifier', () => {
  beforeEach(() => store.clear());

  test('defaults off, persists on for the session, clears', () => {
    assert.equal(getIncludeKeyId(), false);
    setIncludeKeyId(true);
    assert.equal(getIncludeKeyId(), true);
    setIncludeKeyId(false);
    assert.equal(getIncludeKeyId(), false);
  });
});

describe('copyConnectionLink', () => {
  beforeEach(() => {
    copied = null;
    loc.protocol = 'https:';
  });

  test('builds from state, copies, and toasts what travelled', async () => {
    const url = await copyConnectionLink({
      credentials: { endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'AKID1', basePrefix: '' },
      prefix: 'docs/',
    });
    assert.equal(copied, url);
    const p = new URLSearchParams(url.split('#')[1]);
    assert.equal(p.get('prefix'), 'docs/');
    assert.equal(p.get('keyId'), null, 'key ID stays out unless asked');
    assert.equal(toastStore.get().at(-1).message, 'Link copied — opens at docs/');
  });

  test('includes the key ID on request and says so', async () => {
    const url = await copyConnectionLink({
      credentials: { endpoint: 'https://s3.example.com', bucket: 'b', keyId: 'AKID1' },
      prefix: 'docs/',
      includeKeyId: true,
    });
    assert.ok(url.includes('keyId=AKID1'));
    assert.ok(toastStore.get().at(-1).message.includes('Includes your access key ID'));
  });

  test('returns null and copies nothing from file://', async () => {
    loc.protocol = 'file:';
    const url = await copyConnectionLink({
      credentials: { endpoint: 'https://s3.example.com', bucket: 'b' },
      prefix: 'x/',
    });
    assert.equal(url, null);
    assert.equal(copied, null);
  });
});
