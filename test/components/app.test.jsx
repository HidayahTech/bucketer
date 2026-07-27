// Tests for App.jsx — session state machine.
// Tests the disconnected state (no credentials in localStorage) which is the
// initial experience for new users. The connected and connecting states require
// a real S3 probe, so they are covered by E2E tests, not here.
//
// App.jsx reads credentials from localStorage on mount and automatically starts
// connecting if valid credentials are found. These tests clear localStorage before
// mounting to ensure the disconnected state renders predictably.
import '../helpers/with-dom.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { App } from '../../src/components/App.jsx';
import { saveConnectionCapabilities } from '../../src/lib/connections.js';

const CRED_KEYS = [
  's3b_endpoint', 's3b_bucket', 's3b_key_id', 's3b_provider',
  's3b_region_override', 's3b_capabilities', 's3b_profiles',
  's3b_last_profile_id', 's3b_connections', 's3b_credentials',
  's3b_connections_migrated',
];

function clearAppStorage() {
  CRED_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem('s3b_secret_key');
}

describe('App — disconnected state', () => {
  before(() => clearAppStorage());

  test('renders without throwing when no credentials are stored', () => {
    clearAppStorage();
    assert.doesNotThrow(() => {
      const { cleanup } = mount(h(App, {}));
      cleanup();
    });
  });

  test('shows the credential form (splash screen) when no credentials are stored', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    // The credential form is shown in the disconnected state
    const form = query('form') || query('.cred-form') || query('[id="cred-endpoint"]');
    assert.ok(form, 'credential form must be shown when no credentials are stored');
    cleanup();
    clearAppStorage();
  });

  test('does NOT show the Browser file listing when disconnected', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    assert.equal(query('.browser-table') || query('.file-table'), null, 'file browser must not render in disconnected state');
    cleanup();
    clearAppStorage();
  });

  test('shows the Connect button in the credential form', () => {
    clearAppStorage();
    const { cleanup } = mount(h(App, {}));
    const submitBtn = document.querySelector('button[type="submit"]');
    assert.ok(submitBtn, 'Connect submit button must be present in disconnected state');
    assert.ok(submitBtn.textContent.includes('Connect'), 'submit button must say "Connect"');
    cleanup();
    clearAppStorage();
  });
});

describe('App — shared-link pre-fill banner', () => {
  test('with a key ID in the URL, banner prompts for only the Secret Key', () => {
    clearAppStorage();
    window.location.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket&keyId=AKID999';
    const { text, cleanup } = mount(h(App, {}));
    try {
      assert.ok(text().includes('enter your Secret Key to connect'),
        'banner must prompt for only the Secret Key when the link supplied a key ID');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  test('without a key ID in the URL, banner prompts for Key ID and Secret Key', () => {
    clearAppStorage();
    window.location.hash = '#endpoint=https%3A%2F%2Fs3.example.com&bucket=my-bucket';
    const { text, cleanup } = mount(h(App, {}));
    try {
      assert.ok(text().includes('enter your Key ID and Secret Key'),
        'banner must prompt for both fields when the link omitted the key ID');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });
});

// Task 5 code review finding: handleSaveProfile read liveFormData.bucket/keyId raw
// instead of trimming them (as the old saveProfile path did), so a bucket or key ID
// picked up via ProfilePicker's inline "Save as profile…" — which writes straight
// from CredentialForm's onFormChange, bypassing credentialErrors()/handleSubmit's
// trim — could persist with stray whitespace and silently fail to reconnect later.
describe('App — saving a profile trims whitespace-padded fields', () => {
  test('bucket and key ID are trimmed before being persisted to s3b_connections/s3b_credentials', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'https://s3.us-east-1.amazonaws.com');
      setInput(query('#cred-bucket'), '  test-bucket  ');
      setInput(query('#cred-keyid'), '  AKIDEXAMPLE1234  ');

      const saveTrigger = query('.profile-save-trigger');
      assert.ok(saveTrigger, '"Save as profile…" trigger must be present');
      assert.ok(!saveTrigger.disabled, 'trigger must be enabled once endpoint/bucket/keyId are valid (trimmed)');
      fire(saveTrigger, 'click');

      const submitBtn = query('.profile-save-form button[type="submit"]');
      assert.ok(submitBtn, 'save-form submit button must appear after clicking the trigger');
      fire(submitBtn, 'click');

      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{}');
      const { credentials } = JSON.parse(localStorage.getItem('s3b_credentials') || '{}');
      assert.equal(connections?.length, 1, 'exactly one connection must be persisted');
      assert.equal(credentials?.length, 1, 'exactly one credential must be persisted');
      assert.equal(connections[0].bucket, 'test-bucket', 'bucket must be trimmed before persisting');
      assert.equal(credentials[0].keyId, 'AKIDEXAMPLE1234', 'key ID must be trimmed before persisting');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Task 5 code review finding: handleSaveProfile read capabilities off App's `connections`
// React state, which is only refreshed by the mount effect and by handleSaveProfile/
// handleDeleteProfile themselves. handleCapabilityChange and handleRefreshPermissions write
// straight to localStorage without ever updating that state array. So an update to an
// already-selected connection (e.g. renaming it) could read a stale, pre-capability-change
// snapshot and write it back, silently reverting whatever had just been learned.
describe('App — saving a profile does not clobber capabilities written directly to storage', () => {
  test('renaming an existing connection preserves capabilities saved via saveConnectionCapabilities', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      // Create one connection first, exactly as in the trim regression test above.
      setInput(query('#cred-endpoint'), 'https://s3.us-east-1.amazonaws.com');
      setInput(query('#cred-bucket'), 'test-bucket');
      setInput(query('#cred-keyid'), 'AKIDEXAMPLE1234');
      fire(query('.profile-save-trigger'), 'click');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      const beforeId = JSON.parse(localStorage.getItem('s3b_connections')).connections[0].id;

      // Simulate a capability learned during a session (e.g. a failed delete flips
      // 'delete' to 'denied'). In the real app this is written by handleCapabilityChange
      // / handleRefreshPermissions directly to localStorage — App's `connections` state
      // is never refreshed as a side effect of that write, so it still holds the
      // pre-change (capabilities: null) snapshot captured at the save above.
      const learned = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'denied' };
      saveConnectionCapabilities(beforeId, learned);

      // Now save again against the same still-selected connection (e.g. a rename).
      // The button now reads "Update profile…" because a connection is selected.
      fire(query('.profile-save-trigger'), 'click');
      setInput(query('.profile-save-form input[type="text"]'), 'Renamed connection');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      const after = JSON.parse(localStorage.getItem('s3b_connections'));
      const conn = after.connections.find(c => c.id === beforeId);
      assert.equal(after.connections.length, 1, 'the rename must update in place, not create a second connection');
      assert.equal(conn.name, 'Renamed connection', 'the rename must still take effect');
      assert.deepEqual(
        conn.capabilities,
        learned,
        'capabilities written directly to storage must survive a later profile save'
      );
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Regression: the `credentials` useState initializer runs BEFORE the mount effect's
// migrateProfilesToConnections(), so on a legacy user's first post-upgrade load,
// resolveConnection(lastId) finds nothing yet and the form falls back to empty flat
// credential keys. setCredentials was previously only reached inside the
// handleConnect(...) branch, gated on a secretKey that migration never has — so the
// form stayed blank even though the profile showed selected in the picker. Unit tests
// on storage.js/connections.js in isolation cannot catch this: it is purely about
// App.jsx's mount-effect ordering.
describe('App — first load after migration pre-fills the form (regression)', () => {
  test('endpoint/bucket/keyId are populated from the migrated connection, not left blank', async () => {
    clearAppStorage();
    // Exactly the pre-upgrade state: a legacy s3b_profiles record and a pointer to
    // it, but no s3b_connections/s3b_credentials yet (migration hasn't run) and no
    // flat credential keys (no prior direct-credential session either).
    localStorage.setItem('s3b_profiles', JSON.stringify({
      version: 1,
      profiles: [{
        id: 1, name: 'Backups',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        bucket: 'backups', keyId: 'k1', provider: 'b2', regionOverride: 'us-west-004',
      }],
    }));
    localStorage.setItem('s3b_last_profile_id', '1');

    const { query, text, cleanup } = mount(h(App, {}));
    try {
      // The mount effect's work is synchronous, but poll a bounded number of ticks
      // rather than assuming — mirrors the pattern used for StorageModal's async load.
      for (let i = 0; i < 20 && query('#cred-endpoint')?.value !== 'https://s3.us-west-004.backblazeb2.com'; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      assert.equal(query('#cred-endpoint')?.value, 'https://s3.us-west-004.backblazeb2.com',
        'endpoint must be pre-filled from the migrated connection on first load');
      assert.equal(query('#cred-bucket')?.value, 'backups',
        'bucket must be pre-filled from the migrated connection on first load');
      assert.equal(query('#cred-keyid')?.value, 'k1',
        'key ID must be pre-filled from the migrated connection on first load');
      assert.ok(text().includes('Backups'), 'the migrated profile must still show in the picker');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Whole-branch review (2026-07-26), Finding 4 — IMPORTANT: migrateProfilesFromLegacy()
// (converts bare flat credential keys into an s3b_profiles record) was no longer
// called from src/ anywhere, only from its own unit test. migrateProfilesToConnections()
// reads s3b_profiles only, so a user whose storage never reached the profiles stage
// (last opened Bucketer before ~v1.15.0: bare flat keys, no s3b_profiles at all) got
// no connection created on upgrade — the legacy migration chain was severed.
describe('App — legacy flat-key migration chain is restored (Finding 4)', () => {
  test('a user with only flat credential keys (no s3b_profiles) gets a connection created on mount', () => {
    clearAppStorage();
    // Exactly the pre-profiles state: bare flat keys only, no s3b_profiles and no
    // s3b_connections/s3b_credentials yet.
    localStorage.setItem('s3b_endpoint', 'https://s3.us-west-004.backblazeb2.com');
    localStorage.setItem('s3b_bucket', 'legacy-bucket');
    localStorage.setItem('s3b_key_id', 'k1');
    localStorage.setItem('s3b_provider', 'b2');

    const { cleanup } = mount(h(App, {}));
    try {
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{"connections":[]}');
      assert.equal(connections.length, 1,
        'a connection must be created from the flat legacy keys via the restored migration chain');
      assert.equal(connections[0].bucket, 'legacy-bucket');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Whole-branch review (2026-07-26), Finding 5 — IMPORTANT: on an ordinary reload with
// a connection selected, the `credentials` initializer prefers the resolved connection,
// but the mount effect's `else if (conn)` branch preferred flat credentials whenever
// stored.endpoint was set and then forced a form remount to adopt them — flipping the
// pre-fill source away from the connection the picker highlights.
describe("App — the selected connection's values win over stale flat credentials on reload (Finding 5)", () => {
  test('form shows the selected connection\'s endpoint/bucket/keyId, not differing flat credentials left over from a previous connect', async () => {
    clearAppStorage();
    // Connections already exist — an ordinary reload, not first-load-after-migration —
    // so mark migration done and seed connection B directly.
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credB', label: 'B', endpoint: 'https://s3.example-b.com', keyId: 'kB', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 42, name: 'Conn B', credentialId: 'credB', bucket: 'bucket-b', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '42');
    // Flat credentials left over from a DIFFERENT, previously-connected profile (A) —
    // saveCredentials() writes these on every connect, and clearCredentials() only
    // removes them on an explicit disconnect, so they can easily outlive the switch
    // to a different selected connection.
    localStorage.setItem('s3b_endpoint', 'https://s3.example-a.com');
    localStorage.setItem('s3b_bucket', 'bucket-a');
    localStorage.setItem('s3b_key_id', 'kA');

    const { query, cleanup } = mount(h(App, {}));
    try {
      for (let i = 0; i < 20 && query('#cred-endpoint')?.value !== 'https://s3.example-b.com'; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      assert.equal(query('#cred-endpoint')?.value, 'https://s3.example-b.com',
        "the selected connection (B) must win — the mount effect must not override it with stale flat credentials (A)");
      assert.equal(query('#cred-bucket')?.value, 'bucket-b');
      assert.equal(query('#cred-keyid')?.value, 'kB');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Whole-branch review (2026-07-26), Finding 2 — IMPORTANT (operator decision: restore
// pre-branch behaviour): handleConnect used to unconditionally reset capabilities to
// 'unknown' on every connect. The branch changed this to restore the connection's
// stored capabilities instead, making a stale 'denied' durable across reconnects —
// hiding upload/download/delete/move/copy UI even after the user fixed their bucket
// policy at the provider and reloaded.
describe('App — capabilities reset to unknown on every connect (Finding 2)', () => {
  test('connecting resets capabilities to unknown even when the selected connection record holds denied', () => {
    clearAppStorage();
    // 127.0.0.1 on a closed port: createS3Client() constructs successfully (no
    // network I/O at construction time), so the session reaches 'connected'
    // synchronously and CapabilityPanel renders. Browser's own listing probe fires
    // afterward, asynchronously, and fails immediately with ECONNREFUSED on the
    // loopback interface — no real network dependency, no delay.
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'cred1', label: 'Test', endpoint: 'http://127.0.0.1:1', keyId: 'AKIDEXAMPLE1234', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{
        id: 7, name: 'Test conn', credentialId: 'cred1', bucket: 'test-bucket',
        capabilities: { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'denied' },
      }],
    }));
    localStorage.setItem('s3b_last_profile_id', '7');

    const { query, queryAll, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-secretkey'), 'secret123');
      fire(query('button[type="submit"]'), 'click');

      assert.ok(query('.cap-list'), 'connecting must render the sidebar CapabilityPanel');
      assert.equal(queryAll('.cap-denied').length, 0,
        'no capability may read as denied immediately after connecting');
      assert.equal(queryAll('.cap-unknown').length, 4,
        'all four capabilities must reset to unknown on connect, even though the stored connection record has delete: denied');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Coordinator follow-up (2026-07-26), Finding A — CRITICAL: calling
// migrateProfilesFromLegacy() unconditionally (the Finding 4 fix, above) backfires
// for a user already on the connections model. migrateProfilesFromLegacy() decides
// whether it has already run by checking s3b_profiles, but handleSaveProfile never
// writes that record any more — it writes connections and credentials — while
// saveCredentials() rewrites the flat s3b_endpoint/s3b_bucket/s3b_key_id keys on
// every connect. So an established user with a real connection and no s3b_profiles
// gets a phantom profile synthesised from those stale flat keys, and
// saveLastProfileId() (called inside migrateProfilesFromLegacy) overwrites the real
// s3b_last_profile_id pointer with the phantom's Date.now() id — silently
// deselecting the real connection and making saveConnectionCapabilities a
// permanent no-op for it (idx < 0 in connections.js).
describe('App — legacy migration does not hijack an established connections-model user (Finding A)', () => {
  test('a real connection and its last-selected pointer survive mount when only flat credential keys are stale', () => {
    clearAppStorage();
    // Established connections-model user: migration marker set, a real connection,
    // its pointer — and, because saveCredentials() rewrites these on every connect,
    // stale flat credential keys left over from that connect. Deliberately NO
    // s3b_profiles: handleSaveProfile never writes it.
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credX', label: 'X', endpoint: 'https://s3.example-x.com', keyId: 'kX', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 42, name: 'Real conn', credentialId: 'credX', bucket: 'bucket-x', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '42');
    localStorage.setItem('s3b_endpoint', 'https://s3.example-x.com');
    localStorage.setItem('s3b_bucket', 'bucket-x');
    localStorage.setItem('s3b_key_id', 'kX');

    const { cleanup } = mount(h(App, {}));
    try {
      assert.equal(localStorage.getItem('s3b_last_profile_id'), '42',
        'the real connection pointer must survive mount, not be clobbered by a phantom profile id');
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections'));
      assert.ok(connections.some(c => String(c.id) === '42'),
        'the pointer must still resolve to a real connection');
      assert.equal(localStorage.getItem('s3b_profiles'), null,
        'no phantom profile should be synthesised for a user who never had s3b_profiles');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Finding A, second case — guards against over-correcting into skipping the legacy
// chain entirely. This is the same scenario as the Finding 4 test above (a genuine
// pre-profiles user: bare flat keys, no s3b_profiles, no connections, no migration
// marker) restated here explicitly so this fix's two cases are verified side by
// side: gating on the marker must not stop migrateProfilesFromLegacy() from running
// for a user who has never migrated at all.
describe('App — legacy migration still runs for a genuine pre-profiles user (Finding A, case 2)', () => {
  test('a user with only flat credential keys and no migration marker still gets a connection created', () => {
    clearAppStorage();
    localStorage.setItem('s3b_endpoint', 'https://s3.us-west-004.backblazeb2.com');
    localStorage.setItem('s3b_bucket', 'another-legacy-bucket');
    localStorage.setItem('s3b_key_id', 'k2');
    localStorage.setItem('s3b_provider', 'b2');

    const { cleanup } = mount(h(App, {}));
    try {
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{"connections":[]}');
      assert.equal(connections.length, 1,
        'gating migrateProfilesFromLegacy() on the marker must not prevent it from running for an un-migrated user');
      assert.equal(connections[0].bucket, 'another-legacy-bucket');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Coordinator follow-up (2026-07-26, round 3), Finding A case 5 — the marker-only
// predicate above (`if (!hasMigratedConnections()) migrateProfilesFromLegacy();`
// with `hasMigratedConnections()` checking only the marker) still broke the most
// ordinary path of all: a fresh install, connect, save the connection, reload.
// migrateProfilesToConnections()'s own no-profiles early return correctly leaves
// the marker unset (by design — nothing to convert yet), and handleSaveProfile
// creates a real connection via saveConnectionRecord directly without ever
// setting the marker either. So on the next mount the marker is still unset, the
// legacy chain runs, finds no s3b_profiles but live flat keys from
// saveCredentials(), synthesises a phantom profile, and clobbers
// s3b_last_profile_id — while migrateProfilesToConnections() then takes its
// "connections already exist" adopt branch and returns without ever converting
// the phantom, leaving the pointer resolving to nothing. Fixed by widening
// hasMigratedConnections() to also treat any existing connection as "already on
// the connection model," however it got there.
describe('App — a freshly saved connection survives the very next reload (Finding A, case 5)', () => {
  test('connect, save as a new connection, reload: the pointer must not be clobbered by a phantom legacy profile', () => {
    clearAppStorage();
    // No migration marker at all — this precondition is the whole bug. A real
    // connection (as handleSaveProfile would have just created) plus live flat
    // credential keys matching it (as saveCredentials leaves them after connect),
    // and deliberately no s3b_profiles.
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credY', label: 'Y', endpoint: 'https://s3.example-y.com', keyId: 'kY', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 77, name: 'Freshly saved', credentialId: 'credY', bucket: 'bucket-y', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '77');
    localStorage.setItem('s3b_endpoint', 'https://s3.example-y.com');
    localStorage.setItem('s3b_bucket', 'bucket-y');
    localStorage.setItem('s3b_key_id', 'kY');

    const { cleanup } = mount(h(App, {}));
    try {
      assert.equal(localStorage.getItem('s3b_last_profile_id'), '77',
        'the real connection pointer must survive the very next reload, not be clobbered by a phantom profile id');
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections'));
      assert.ok(connections.some(c => String(c.id) === '77'),
        'the pointer must still resolve to the real connection');
      assert.equal(localStorage.getItem('s3b_profiles'), null,
        'no phantom profile should be synthesised — the legacy chain must recognize this user is already on the connection model');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Coordinator follow-up (2026-07-26), Finding B — IMPORTANT: the Finding 2 fix
// reset in-memory capabilities to 'unknown' on every connect but left the stored
// per-connection record untouched. handleCapabilityChange merges new observations
// against in-memory `prev`, and saveConnectionCapabilities blind-overwrites the
// whole stored field — so Browser's initial listing probe, firing almost
// immediately after connect, persists {list: X, download: 'unknown', upload:
// 'unknown', delete: 'unknown'}, silently discarding whatever was accurately known
// about the other three ops.
describe('App — connecting resets the stored capability record, not just in-memory (Finding B)', () => {
  test('a stale denied capability stored against the connection does not survive a reconnect', () => {
    clearAppStorage();
    // Loopback + closed port — see the Finding 2 test above for why this is safe
    // and fast: createS3Client() does no I/O at construction, so session reaches
    // 'connected' synchronously, and the async listing probe fails immediately
    // with ECONNREFUSED with no real network dependency.
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credB2', label: 'B2', endpoint: 'http://127.0.0.1:1', keyId: 'AKIDEXAMPLE9999', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{
        id: 9, name: 'Test conn 2', credentialId: 'credB2', bucket: 'test-bucket-2',
        capabilities: { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'denied' },
      }],
    }));
    localStorage.setItem('s3b_last_profile_id', '9');

    const { query, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-secretkey'), 'secret456');
      fire(query('button[type="submit"]'), 'click');

      const { connections } = JSON.parse(localStorage.getItem('s3b_connections'));
      const stored = connections.find(c => c.id === 9).capabilities;
      assert.deepEqual(stored, { list: 'unknown', download: 'unknown', upload: 'unknown', delete: 'unknown' },
        'the stored capability record must reset to unknown on connect too, not just the in-memory copy');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});
