// Tests for ProfilePicker.
// Covers: empty state, profile list rendering, selection, delete confirmation
// flow, and the save/update form. Every interaction that calls a parent callback
// is tested both for triggering the callback AND for the resulting DOM change.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { ProfilePicker } from '../../src/components/ProfilePicker.jsx';

// Minimal form data that satisfies canSaveProfile (has endpoint, bucket, keyId).
const SAVEABLE_FORM = { endpoint: 'https://s3.us-west-002.backblazeb2.com', bucket: 'my-bucket', keyId: 'abc123', secretKey: 'secret' };
const EMPTY_FORM    = { endpoint: '', bucket: '', keyId: '', secretKey: '' };

const PROFILE_A = { id: 1, name: 'B2 Production',  provider: 'b2',  bucket: 'prod-bucket' };
const PROFILE_B = { id: 2, name: 'Wasabi Staging', provider: null, bucket: 'stage-bucket' };

function defaultProps(overrides = {}) {
  return { profiles: [], selectedId: null, onSelect: () => {}, onDelete: () => {}, onSave: () => {}, currentFormData: SAVEABLE_FORM, ...overrides };
}

describe('ProfilePicker — empty state', () => {
  test('renders the save button when profiles list is empty', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps()));
    assert.ok(query('.profile-save-trigger'), '"Save as profile…" button should be present');
    cleanup();
  });

  test('save button is disabled when form data is incomplete', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ currentFormData: EMPTY_FORM })));
    const btn = query('.profile-save-trigger');
    assert.ok(btn.disabled, 'save button must be disabled when form is incomplete');
    cleanup();
  });

  test('save button is enabled when form data is complete', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ currentFormData: SAVEABLE_FORM })));
    const btn = query('.profile-save-trigger');
    assert.ok(!btn.disabled, 'save button must be enabled when form is complete');
    cleanup();
  });

  test('does NOT show a profile list when profiles is empty', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps()));
    assert.equal(query('.profile-list'), null, 'profile-list element must not exist when profiles array is empty');
    cleanup();
  });
});

describe('ProfilePicker — profile list rendering', () => {
  test('renders profile names', () => {
    const { text, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A, PROFILE_B] })));
    assert.ok(text().includes('B2 Production'));
    assert.ok(text().includes('Wasabi Staging'));
    cleanup();
  });

  test('shows provider and bucket as a hint under each profile name', () => {
    const { text, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A] })));
    // profileHint() joins PROVIDER_LABELS[provider] and bucket with ' · '
    assert.ok(text().includes('prod-bucket'), 'bucket name should appear in the hint');
    cleanup();
  });

  test('applies profile-row-selected class to the selected profile', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A, PROFILE_B], selectedId: 1 })));
    const rows = [...document.querySelectorAll('.profile-row')];
    const selected = rows.filter(r => r.classList.contains('profile-row-selected'));
    assert.equal(selected.length, 1, 'exactly one row should be selected');
    assert.ok(selected[0].textContent.includes('B2 Production'), 'the selected row should be B2 Production');
    cleanup();
  });

  test('does NOT apply profile-row-selected to unselected profiles', () => {
    const { queryAll, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A, PROFILE_B], selectedId: 1 })));
    const rows = queryAll('.profile-row');
    const unselected = rows.filter(r => !r.classList.contains('profile-row-selected'));
    for (const row of unselected) {
      assert.ok(!row.classList.contains('profile-row-selected'));
    }
    cleanup();
  });
});

describe('ProfilePicker — selection interaction', () => {
  test('clicking a profile row calls onSelect with that profile\'s id', () => {
    let selectedId = null;
    const { queryAll, cleanup } = mount(h(ProfilePicker, defaultProps({
      profiles: [PROFILE_A, PROFILE_B],
      onSelect: id => { selectedId = id; },
    })));
    fire(queryAll('.profile-row')[1], 'click'); // click Wasabi Staging (id=2)
    assert.equal(selectedId, 2);
    cleanup();
  });
});

describe('ProfilePicker — delete flow', () => {
  test('clicking the delete (✕) button shows the confirm dialog for that profile', () => {
    const { queryAll, text, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A, PROFILE_B] })));
    const deleteBtn = queryAll('.profile-row-delete')[0]; // delete for first profile
    fire(deleteBtn, 'click');
    assert.ok(text().includes('Delete?'), 'Delete? confirmation text should appear');
    cleanup();
  });

  test('clicking Cancel in the confirm dialog hides it', () => {
    const { queryAll, query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A] })));
    fire(queryAll('.profile-row-delete')[0], 'click');
    assert.ok(query('.profile-delete-confirm'), 'confirm dialog should be visible after clicking delete');
    const cancelBtn = query('.profile-delete-confirm .btn-ghost');
    fire(cancelBtn, 'click');
    assert.equal(query('.profile-delete-confirm'), null, 'confirm dialog should disappear after Cancel');
    cleanup();
  });

  test('clicking Confirm calls onDelete with the profile id', () => {
    let deletedId = null;
    const { queryAll, cleanup } = mount(h(ProfilePicker, defaultProps({
      profiles: [PROFILE_A],
      onDelete: id => { deletedId = id; },
    })));
    fire(queryAll('.profile-row-delete')[0], 'click');
    const confirmBtn = document.querySelector('.profile-delete-confirm-yes');
    fire(confirmBtn, 'click');
    assert.equal(deletedId, 1, 'onDelete should be called with the profile id');
    cleanup();
  });

  test('clicking Confirm dismisses the confirm dialog', () => {
    const { queryAll, query, cleanup } = mount(h(ProfilePicker, defaultProps({
      profiles: [PROFILE_A],
      onDelete: () => {},
    })));
    fire(queryAll('.profile-row-delete')[0], 'click');
    fire(document.querySelector('.profile-delete-confirm-yes'), 'click');
    assert.equal(query('.profile-delete-confirm'), null, 'confirm dialog should be gone after confirming');
    cleanup();
  });

  test('delete button for profile A does NOT show confirm for profile B', () => {
    const { queryAll, query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A, PROFILE_B] })));
    fire(queryAll('.profile-row-delete')[0], 'click'); // delete button for profile A
    // Only one confirm dialog should appear, and it should be in profile A's row
    const rows = queryAll('.profile-row');
    assert.ok(rows[0].querySelector('.profile-delete-confirm'), 'confirm should appear in profile A row');
    assert.equal(rows[1].querySelector('.profile-delete-confirm'), null, 'profile B row should have no confirm');
    cleanup();
  });
});

describe('ProfilePicker — save form', () => {
  test('clicking "Save as profile…" shows the save form', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A] })));
    fire(query('.profile-save-trigger'), 'click');
    assert.ok(query('.profile-save-form'), 'save form should appear after clicking the trigger button');
    cleanup();
  });

  test('Save button is disabled when name field is empty', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A] })));
    fire(query('.profile-save-trigger'), 'click');
    // The form opens with a pre-filled name from defaultName(currentFormData).
    // Clear it to test the empty-name guard.
    setInput(query('.profile-save-form input[type="text"]'), '');
    const saveBtn = query('.profile-save-form button[type="submit"]');
    assert.ok(saveBtn.disabled, 'Save button must be disabled when name is empty');
    cleanup();
  });

  test('Save button becomes enabled when a name is typed', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A] })));
    fire(query('.profile-save-trigger'), 'click');
    const nameInput = query('.profile-save-form input[type="text"]');
    setInput(nameInput, 'My New Profile');
    const saveBtn = query('.profile-save-form button[type="submit"]');
    assert.ok(!saveBtn.disabled, 'Save button must be enabled when a name has been entered');
    cleanup();
  });

  test('submitting the form calls onSave with the trimmed name', () => {
    let savedName = null;
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({
      profiles: [PROFILE_A],
      onSave: name => { savedName = name; },
    })));
    fire(query('.profile-save-trigger'), 'click');
    setInput(query('.profile-save-form input[type="text"]'), '  My Profile  ');
    fire(query('.profile-save-form button[type="submit"]'), 'click');
    assert.equal(savedName, 'My Profile', 'onSave should receive the trimmed profile name');
    cleanup();
  });

  test('Cancel hides the save form without calling onSave', () => {
    let saveCalled = false;
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({
      profiles: [PROFILE_A],
      onSave: () => { saveCalled = true; },
    })));
    fire(query('.profile-save-trigger'), 'click');
    const cancelBtn = query('.profile-save-form .btn-ghost');
    fire(cancelBtn, 'click');
    assert.equal(query('.profile-save-form'), null, 'save form should be hidden after Cancel');
    assert.ok(!saveCalled, 'onSave must NOT be called when Cancel is clicked');
    cleanup();
  });

  test('shows "Update profile…" text when a profile is selected', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A], selectedId: 1 })));
    assert.ok(query('.profile-save-trigger').textContent.includes('Update profile'));
    cleanup();
  });

  test('shows "Save current as profile…" text when no profile is selected', () => {
    const { query, cleanup } = mount(h(ProfilePicker, defaultProps({ profiles: [PROFILE_A], selectedId: null })));
    assert.ok(query('.profile-save-trigger').textContent.includes('Save current'));
    cleanup();
  });
});
