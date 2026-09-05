// Tests for AccountsManager — the account→buckets tree that replaces the flat
// ProfilePicker on the splash. Connections sharing a credentialId are one account.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { AccountsManager } from '../../src/components/AccountsManager.jsx';

// Resolved-connection shape (see resolveConnection in connections.js).
const B2_PHOTOS  = { id: 1, name: 'B2 — photos',        bucket: 'photos',        credentialId: 'credB2',  endpoint: 'https://s3.us-west-002.backblazeb2.com', keyId: '0042abcdef', provider: 'b2' };
const B2_BACKUPS = { id: 2, name: 'B2 — backups',       bucket: 'backups',       credentialId: 'credB2',  endpoint: 'https://s3.us-west-002.backblazeb2.com', keyId: '0042abcdef', provider: 'b2' };
const AWS_ASSETS = { id: 3, name: 'AWS — client-assets', bucket: 'client-assets', credentialId: 'credAWS', endpoint: 'https://s3.amazonaws.com',                keyId: 'AKIA7f2ZZZ',  provider: 'aws' };

const SAVEABLE_FORM = { endpoint: 'https://s3.us-west-002.backblazeb2.com', bucket: 'my-bucket', keyId: 'abc123', secretKey: 'secret' };

function defaultProps(overrides = {}) {
  return {
    connections: [], selectedId: null,
    onSelect: () => {}, onDelete: () => {}, onSave: () => {}, onAddBucket: () => {},
    currentFormData: SAVEABLE_FORM, ...overrides,
  };
}

describe('AccountsManager — grouping', () => {
  test('connections sharing a credentialId render under one account group', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS],
    })));
    const groups = queryAll('.account-group');
    assert.equal(groups.length, 2, 'two distinct credentials → two account groups');
    cleanup();
  });

  test('an account group lists every bucket sharing its credential', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS],
    })));
    const groups = queryAll('.account-group');
    const b2Group = groups.find(g => g.textContent.includes('photos'));
    const bucketRows = [...b2Group.querySelectorAll('.bucket-row')];
    assert.equal(bucketRows.length, 2, 'the B2 account has two buckets');
    assert.ok(b2Group.textContent.includes('photos'));
    assert.ok(b2Group.textContent.includes('backups'));
    cleanup();
  });
});

describe('AccountsManager — account header', () => {
  test('header shows the provider label and a masked key id, not the full key', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS],
    })));
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
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS], selectedId: 1,
      onSelect: id => { picked = id; },
    })));
    fire(queryAll('.bucket-row')[1], 'click'); // backups (id=2)
    assert.equal(picked, 2);
    cleanup();
  });

  test('the active connection bucket row is marked selected', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS], selectedId: 1,
    })));
    const selected = queryAll('.bucket-row').filter(r => r.classList.contains('bucket-row-selected'));
    assert.equal(selected.length, 1, 'exactly one bucket row is selected');
    assert.ok(selected[0].textContent.includes('photos'));
    cleanup();
  });
});

describe('AccountsManager — expansion', () => {
  test('the account without the active bucket is collapsed', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS, AWS_ASSETS], selectedId: 1,
    })));
    const groups = queryAll('.account-group');
    const awsGroup = groups.find(g => g.textContent.includes('AWS S3'));
    const b2Group  = groups.find(g => g.textContent.includes('Backblaze B2'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 0, 'inactive account is collapsed');
    assert.equal(b2Group.querySelectorAll('.bucket-row').length, 2, 'active account is expanded');
    cleanup();
  });

  test('clicking a collapsed account header expands it', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, AWS_ASSETS], selectedId: 1,
    })));
    const awsGroup = queryAll('.account-group').find(g => g.textContent.includes('AWS S3'));
    assert.equal(awsGroup.querySelectorAll('.bucket-row').length, 0, 'collapsed initially');
    fire(awsGroup.querySelector('.account-header'), 'click');
    const awsAfter = queryAll('.account-group').find(g => g.textContent.includes('AWS S3'));
    assert.equal(awsAfter.querySelectorAll('.bucket-row').length, 1, 'expanded after header click');
    cleanup();
  });
});

describe('AccountsManager — delete flow', () => {
  test('clicking a bucket delete button shows an inline confirm', () => {
    const { queryAll, query, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS], selectedId: 1,
    })));
    fire(queryAll('.bucket-row-delete')[0], 'click');
    assert.ok(query('.bucket-delete-confirm'), 'inline confirm should appear');
    cleanup();
  });

  test('confirming delete calls onDelete with the connection id', () => {
    let deleted = null;
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS], selectedId: 1,
      onDelete: id => { deleted = id; },
    })));
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
    const { query, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS], onSave: name => { saved = name; },
    })));
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
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, AWS_ASSETS],
      onAddBucket: id => { added = id; },
    })));
    const b2Group = queryAll('.account-group').find(g => g.textContent.includes('Backblaze B2'));
    fire(b2Group.querySelector('.account-add-bucket'), 'click');
    assert.equal(added, 'credB2');
    cleanup();
  });

  test('clicking "+ bucket" does not toggle the account collapse', () => {
    const { queryAll, cleanup } = mount(h(AccountsManager, defaultProps({
      connections: [B2_PHOTOS, B2_BACKUPS], selectedId: 1,
    })));
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
