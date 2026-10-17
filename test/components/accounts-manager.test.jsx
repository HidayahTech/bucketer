// Tests for AccountsManager — the account→buckets tree that replaces the flat
// ProfilePicker on the splash. Connections sharing a credentialId are one account.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { AccountsManager } from '../../src/components/AccountsManager.jsx';

// Resolved-connection shape (see resolveConnection in connections.js).
const B2_PHOTOS = {
  id: 1,
  name: 'B2 — photos',
  bucket: 'photos',
  credentialId: 'credB2',
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  keyId: '0042abcdef',
  provider: 'b2',
};
const B2_BACKUPS = {
  id: 2,
  name: 'B2 — backups',
  bucket: 'backups',
  credentialId: 'credB2',
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  keyId: '0042abcdef',
  provider: 'b2',
};
const AWS_ASSETS = {
  id: 3,
  name: 'AWS — client-assets',
  bucket: 'client-assets',
  credentialId: 'credAWS',
  endpoint: 'https://s3.amazonaws.com',
  keyId: 'AKIA7f2ZZZ',
  provider: 'aws',
};

const SAVEABLE_FORM = {
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'abc123',
  secretKey: 'secret',
};

function defaultProps(overrides = {}) {
  return {
    connections: [],
    selectedId: null,
    onSelect: () => {},
    onDelete: () => {},
    onSave: () => {},
    onAddBucket: () => {},
    currentFormData: SAVEABLE_FORM,
    ...overrides,
  };
}

describe('AccountsManager — grouping', () => {
  test('connections sharing a credentialId render under one account group', () => {
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS],
        }),
      ),
    );
    const groups = queryAll('.account-group');
    assert.equal(groups.length, 2, 'two distinct credentials → two account groups');
    cleanup();
  });

  test('an account group lists every bucket sharing its credential', () => {
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS],
        }),
      ),
    );
    const groups = queryAll('.account-group');
    const b2Group = groups.find((g) => g.textContent.includes('photos'));
    const bucketRows = [...b2Group.querySelectorAll('.bucket-row')];
    assert.equal(bucketRows.length, 2, 'the B2 account has two buckets');
    assert.ok(b2Group.textContent.includes('photos'));
    assert.ok(b2Group.textContent.includes('backups'));
    cleanup();
  });
});

describe('AccountsManager — account header', () => {
  test('header shows the provider label and a masked key id, not the full key', () => {
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
        }),
      ),
    );
    const header = queryAll('.account-header')[0];
    assert.ok(header, 'an account header should render');
    assert.ok(header.textContent.includes('Backblaze B2'), 'provider label shown');
    assert.ok(header.textContent.includes('cdef'), 'the key id tail is shown');
    assert.ok(!header.textContent.includes('0042abcdef'), 'the full key id is NOT shown');
    cleanup();
  });
});

describe('AccountsManager — bucket selection', () => {
  test('clicking a bucket row calls onSelect with that connection id', () => {
    let picked = null;
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
          onSelect: (id) => {
            picked = id;
          },
        }),
      ),
    );
    fire(queryAll('.bucket-row')[1], 'click'); // backups (id=2)
    assert.equal(picked, 2);
    cleanup();
  });

  test('the active connection bucket row is marked selected', () => {
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
        }),
      ),
    );
    const selected = queryAll('.bucket-row').filter((r) => r.classList.contains('bucket-row-selected'));
    assert.equal(selected.length, 1, 'exactly one bucket row is selected');
    assert.ok(selected[0].textContent.includes('photos'));
    cleanup();
  });

  // K1: a saved bucket must be pickable from the keyboard — a native button gets Tab + Enter/Space.
  test('each bucket name is a button that selects the bucket', () => {
    let picked = null;
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
          onSelect: (id) => {
            picked = id;
          },
        }),
      ),
    );
    const names = queryAll('.bucket-row .bucket-name');
    assert.ok(
      names.every((n) => n.tagName === 'BUTTON'),
      'bucket names must be <button>s',
    );
    fire(names[1], 'click');
    assert.equal(picked, 2);
    assert.equal(names[0].getAttribute('aria-current'), 'true', 'the active bucket is marked current');
    cleanup();
  });
});

// 4b step 6 (v1.66.0 ux-review, known item): collapsing every account but the active one hid
// the buckets the drawer exists to switch to. Small lists (≤ 8 buckets) open every account;
// above that, the active account opens and a collapsed header says how many it hides.
const MORE_AWS = Array.from({ length: 6 }, (_, i) => ({ ...AWS_ASSETS, id: 10 + i, bucket: `aws-${i}` }));
const NINE = [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS, ...MORE_AWS];

describe('AccountsManager — expansion', () => {
  test('with eight buckets or fewer, every account is open, the inactive one too', () => {
    const { queryAll, cleanup } = mount(
      h(AccountsManager, defaultProps({ connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS], selectedId: 1 })),
    );
    const awsGroup = queryAll('.account-group').find((g) => g.textContent.includes('AWS S3'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 1, 'inactive account is open');
    cleanup();
  });

  test('above eight buckets, the account without the active bucket is collapsed and says how many it holds', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({ connections: NINE, selectedId: 1 })));
    const groups = queryAll('.account-group');
    const awsGroup = groups.find((g) => g.textContent.includes('AWS S3'));
    const b2Group = groups.find((g) => g.textContent.includes('Backblaze B2'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 0, 'inactive account is collapsed');
    assert.match(awsGroup.querySelector('.account-toggle').textContent, /7 buckets/);
    assert.equal(b2Group.querySelectorAll('.bucket-row').length, 2, 'active account is expanded');
    cleanup();
  });

  test('clicking a collapsed account header expands it', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({ connections: NINE, selectedId: 1 })));
    const awsGroup = queryAll('.account-group').find((g) => g.textContent.includes('AWS S3'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 0, 'collapsed initially');
    fire(awsGroup.querySelector('.account-header'), 'click');
    const awsAfter = queryAll('.account-group').find((g) => g.textContent.includes('AWS S3'));
    assert.equal(awsAfter.querySelectorAll('.bucket-row').length, 7, 'expanded after header click');
    cleanup();
  });

  test('the account toggle is a button carrying aria-expanded, and activating it expands the account', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({ connections: NINE, selectedId: 1 })));
    const awsToggle = () =>
      queryAll('.account-group')
        .find((g) => g.textContent.includes('AWS S3'))
        .querySelector('button.account-toggle');
    assert.equal(awsToggle().getAttribute('aria-expanded'), 'false', 'collapsed account reports aria-expanded=false');
    fire(awsToggle(), 'click');
    assert.equal(awsToggle().getAttribute('aria-expanded'), 'true', 'expanded after the toggle button is activated');
    const awsGroup = queryAll('.account-group').find((g) => g.textContent.includes('AWS S3'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 7, 'its buckets are now listed');
    cleanup();
  });
});

describe('AccountsManager — delete flow', () => {
  test('clicking a bucket delete button shows an inline confirm', () => {
    const { queryAll, query, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
        }),
      ),
    );
    fire(queryAll('.bucket-row-delete')[0], 'click');
    assert.ok(query('.bucket-delete-confirm'), 'inline confirm should appear');
    cleanup();
  });

  test('on the splash the confirm says Forget and that files are not touched, never Delete', () => {
    const { queryAll, query, cleanup } = mount(
      h(AccountsManager, defaultProps({ connections: [B2_PHOTOS, B2_BACKUPS], variant: 'splash' })),
    );
    fire(queryAll('.bucket-row-delete')[0], 'click');
    const text = query('.bucket-delete-confirm').textContent;
    assert.ok(text.includes('Forget?'), `confirm asks to forget; got "${text}"`);
    assert.ok(text.includes('Your files are not touched.'), 'confirm says the files are safe');
    assert.ok(!text.includes('Delete'), 'confirm never says Delete');
    cleanup();
  });

  test('confirming delete calls onDelete with the connection id', () => {
    let deleted = null;
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
          onDelete: (id) => {
            deleted = id;
          },
        }),
      ),
    );
    fire(queryAll('.bucket-row-delete')[1], 'click'); // backups (id=2)
    fire(document.querySelector('.bucket-delete-confirm-yes'), 'click');
    assert.equal(deleted, 2);
    cleanup();
  });
});

describe('AccountsManager — save current', () => {
  test('renders an enabled save trigger when the form is saveable', () => {
    const { query, cleanup } = mount(h(AccountsManager, defaultProps({ connections: [B2_PHOTOS] })));
    const trigger = query('.bucket-save-trigger');
    assert.ok(trigger, 'save trigger should render');
    assert.ok(!trigger.disabled, 'enabled when the current form is saveable');
    cleanup();
  });

  test('submitting the save form calls onSave with the trimmed name', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS],
          onSave: (name) => {
            saved = name;
          },
        }),
      ),
    );
    fire(query('.bucket-save-trigger'), 'click');
    setInput(query('.bucket-save-form input[type="text"]'), '  My Bucket  ');
    fire(query('.bucket-save-form button[type="submit"]'), 'click');
    assert.equal(saved, 'My Bucket');
    cleanup();
  });
});

describe('AccountsManager — add bucket to an account', () => {
  test('clicking "+ bucket" calls onAddBucket with the account credentialId', () => {
    let added = null;
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, AWS_ASSETS],
          onAddBucket: (id) => {
            added = id;
          },
        }),
      ),
    );
    const b2Group = queryAll('.account-group').find((g) => g.textContent.includes('Backblaze B2'));
    // 4b step 9 (ux-review finding 8): "+ bucket" was cryptic; its meaning lived in a hover title.
    assert.equal(b2Group.querySelector('.account-add-bucket').textContent, 'Add bucket for this key');
    fire(b2Group.querySelector('.account-add-bucket'), 'click');
    assert.equal(added, 'credB2');
    cleanup();
  });

  test('clicking "+ bucket" does not toggle the account collapse', () => {
    const { queryAll, cleanup } = mount(
      h(
        AccountsManager,
        defaultProps({
          connections: [B2_PHOTOS, B2_BACKUPS],
          selectedId: 1,
        }),
      ),
    );
    assert.equal(queryAll('.account-group')[0].querySelectorAll('.bucket-row').length, 2, 'expanded before');
    fire(queryAll('.account-group')[0].querySelector('.account-add-bucket'), 'click');
    assert.equal(queryAll('.account-group')[0].querySelectorAll('.bucket-row').length, 2, 'still expanded (no toggle)');
    cleanup();
  });
});

describe('AccountsManager — empty state', () => {
  test('with no connections, renders the save trigger and no account groups', () => {
    const { query, queryAll, cleanup } = mount(h(AccountsManager, defaultProps({ connections: [] })));
    assert.ok(query('.bucket-save-trigger'), 'save trigger present so a first bucket can be saved');
    assert.equal(queryAll('.account-group').length, 0, 'no account groups when there are no connections');
    cleanup();
  });
});

// Accounts A (v1.66.0): on the splash the tree is "Your buckets" — every remembered bucket,
// most recent first, each naming its storage address and last use, with Forget all (REPORT C1/C6/C8).
describe('AccountsManager — splash "Your buckets"', () => {
  const now = Date.now();
  const used = (c, lastUsedAt) => ({ ...c, lastUsedAt });

  test('heads the list "Your buckets" with the count on this device', () => {
    const { text, cleanup } = mount(
      h(AccountsManager, defaultProps({ variant: 'splash', connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS] })),
    );
    assert.ok(text().includes('Your buckets'));
    assert.ok(text().includes('3 on this device'));
    cleanup();
  });

  test('orders accounts and buckets by last use, most recent first', () => {
    const conns = [used(B2_PHOTOS, now - 5 * 86400000), used(B2_BACKUPS, now - 60000), used(AWS_ASSETS, now - 3600000)];
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({ variant: 'splash', connections: conns })));
    assert.deepEqual(
      queryAll('.bucket-name').map((b) => b.textContent),
      ['backups', 'photos', 'client-assets'],
      'the B2 account (backups used a minute ago) comes first; inside it backups before photos',
    );
    cleanup();
  });

  test('each bucket shows its storage address and when it was last used', () => {
    const { query, cleanup } = mount(
      h(AccountsManager, defaultProps({ variant: 'splash', connections: [used(B2_PHOTOS, now - 3 * 86400000)] })),
    );
    const row = query('.bucket-row');
    assert.ok(row.textContent.includes('s3.us-west-002.backblazeb2.com'));
    assert.ok(row.textContent.includes('Last used 3 days ago'));
    cleanup();
  });

  test('says what is and is not kept, and offers Forget all behind a confirmation', () => {
    let forgot = 0;
    const { text, query, cleanup } = mount(
      h(AccountsManager, defaultProps({ variant: 'splash', connections: [B2_PHOTOS], onForgetAll: () => forgot++ })),
    );
    assert.ok(text().includes('Never the secret'));
    fire(query('.forget-all-trigger'), 'click');
    assert.equal(forgot, 0, 'the first click only asks');
    fire(query('.forget-all-confirm'), 'click');
    assert.equal(forgot, 1);
    cleanup();
  });

  test('the sidebar variant keeps its compact rows and has no Forget all', () => {
    const { text, query, cleanup } = mount(h(AccountsManager, defaultProps({ connections: [B2_PHOTOS] })));
    assert.ok(!text().includes('Your buckets'));
    assert.equal(query('.forget-all-trigger'), null);
    cleanup();
  });
});
