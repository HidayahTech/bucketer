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
import { webcrypto } from 'node:crypto';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { App } from '../../src/components/App.jsx';
import { saveConnectionCapabilities, saveConnectionRecord, findOrCreateCredential, deleteConnectionRecord } from '../../src/lib/connections.js';
import { deleteAllProfiles } from '../../src/lib/storage.js';
import { buildShareUrl, readUrlParams } from '../../src/lib/url-params.js';
import { createVault, rememberSecret, recallSecret, vaultExists, isUnlocked, SS_KEY_VAULT_KEY, VAULT_ENABLED } from '../../src/lib/vault.js';
import { VAULT_USERNAME } from '../../src/components/VaultUnlock.jsx';

// jsdom does not implement SubtleCrypto — patch in Node's real WebCrypto, the same
// technique test/components/vault-unlock.test.jsx uses, so the Task 6 tests below can
// exercise real createVault/rememberSecret/recallSecret end to end through App.jsx.
window.crypto.subtle = webcrypto.subtle;
const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
const PASSPHRASE = 'correct horse battery staple';

const CRED_KEYS = [
  's3b_endpoint', 's3b_bucket', 's3b_key_id', 's3b_provider',
  's3b_region_override', 's3b_capabilities', 's3b_profiles',
  's3b_last_profile_id', 's3b_connections', 's3b_credentials',
  's3b_connections_migrated', 's3b_vault', 's3b_vault_offer_dismissed',
];

function clearAppStorage() {
  CRED_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem('s3b_secret_key');
  sessionStorage.removeItem(SS_KEY_VAULT_KEY);
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

// Coordinator follow-up (2026-07-26, round 4), Finding A — the round-3 predicate
// (hasMigratedConnections() deriving "on the connection model" from
// connections.length as its load-bearing signal) was itself the same sentinel
// conflation as the original Critical, relocated: deleteConnectionRecord empties
// the connection list, and re-deriving "not yet on the connection model" from
// that empty list resurrects a phantom from stale flat keys via the legacy chain
// — this time triggered by the most ordinary sequence of all: connect, save the
// connection under a name, delete it, reload.
//
// The setup below constructs that exact storage state via the real
// connections.js functions (mirroring what handleConnect/handleSaveProfile/
// handleDeleteProfile actually call), then mounts the real App once — that mount
// is "the mount order" under test: App's actual hasMigratedConnections() gate
// ahead of migrateProfilesFromLegacy()/migrateProfilesToConnections().
describe('App — a deleted connection does not resurrect after this sequence: connect, save, delete, reload (Finding A, F1 round 4)', () => {
  test('the connection list stays empty and no phantom profile is synthesised', () => {
    clearAppStorage();
    // "Connect" — saveCredentials() would write these flat keys; write them
    // directly since the connect UI path itself is not what is under test here.
    localStorage.setItem('s3b_endpoint', 'https://s3.example-f1.com');
    localStorage.setItem('s3b_bucket', 'buck-1');
    localStorage.setItem('s3b_key_id', 'kF1');
    // "Save the connection under a name" — the real handleSaveProfile call chain.
    const cred = findOrCreateCredential({ endpoint: 'https://s3.example-f1.com', keyId: 'kF1', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 501, name: 'My Bucket', credentialId: cred.id, bucket: 'buck-1', capabilities: null });
    localStorage.setItem('s3b_last_profile_id', '501');
    // "Delete it" — the real handleDeleteProfile call chain.
    deleteConnectionRecord(501);

    // "Reload."
    const { cleanup } = mount(h(App, {}));
    try {
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{"connections":[]}');
      assert.deepEqual(connections, [],
        'the deleted connection must not be resurrected as a phantom from stale flat keys');
      assert.equal(localStorage.getItem('s3b_profiles'), null,
        'no phantom profile should be synthesised — saveConnectionRecord recorded that this user is already on the connection model');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Finding A, case 4, restated explicitly as its own assertion (previously only
// verified manually via a standalone script) so a future change cannot silently
// remove this pre-branch parity: a full wipe (deleteAllProfiles — clears
// s3b_profiles, s3b_connections/s3b_credentials, and the migration marker, but
// deliberately leaves the flat credential keys behind) followed by a reload must
// still resurrect one connection from those surviving flat keys. This is the
// same behaviour the pre-branch build had and the coordinator explicitly chose
// not to change.
describe('App — post-wipe resurrection from surviving flat keys is preserved (Finding A, case 4 — must not change)', () => {
  test('deleteAllProfiles() followed by a reload still resurrects one connection from the flat keys it leaves behind', () => {
    clearAppStorage();
    const cred = findOrCreateCredential({ endpoint: 'https://s3.example-f1.com', keyId: 'kF1', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 501, name: 'My Bucket', credentialId: cred.id, bucket: 'buck-1', capabilities: null });
    localStorage.setItem('s3b_last_profile_id', '501');
    localStorage.setItem('s3b_endpoint', 'https://s3.example-f1.com');
    localStorage.setItem('s3b_bucket', 'buck-1');
    localStorage.setItem('s3b_key_id', 'kF1');

    deleteAllProfiles(); // clears profiles/connections/credentials/marker; flat keys survive

    const { cleanup } = mount(h(App, {}));
    try {
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections') || '{"connections":[]}');
      assert.equal(connections.length, 1,
        'this is intentional pre-branch parity — a full wipe followed by a reload resurrects a connection from surviving flat keys, and must keep doing so');
      assert.equal(connections[0].bucket, 'buck-1');
    } finally {
      cleanup();
      clearAppStorage();
    }
  });
});

// Coordinator follow-up (2026-07-26, round 5), Finding (Medium) — BUG-046.
// handleSaveProfile's post-save `credentials` sync read back from storage
// (`updated.find(c => c.id === id)`) instead of building from the values already
// in memory. Every write above it goes through a wrapper (safeSetRaw) that
// swallows failure by design — private browsing, blocked site data, quota
// exhaustion, all hazards this codebase explicitly designs for (see
// FileBanner.jsx). When a write silently doesn't land, the read-back finds no
// matching row, `saved` is `undefined`, and `{ ...undefined, secretKey }`
// collapses `credentials`/`liveFormData` to just `{ secretKey }` — blanking
// endpoint/bucket/keyId/provider in the exact form the user just filled in, made
// visible immediately by the remount CredentialForm undergoes on the
// selectedConnectionId key change.
describe('App — a storage write that silently fails does not blank the form (BUG-046)', () => {
  test('endpoint/bucket/key ID survive "Save as profile" when localStorage.setItem throws', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    // jsdom's Storage is a legacy platform object: instance-level assignment
    // (`localStorage.setItem = fn`) does NOT override the method — it silently
    // stores the function as a stringified value under a key literally named
    // "setItem" (confirmed directly: getItem('setItem') then returns it, and the
    // real setItem keeps working). The prototype method must be replaced instead.
    const proto = Object.getPrototypeOf(localStorage);
    const originalSetItem = proto.setItem;
    try {
      setInput(query('#cred-endpoint'), 'https://s3.us-east-1.amazonaws.com');
      setInput(query('#cred-bucket'), 'my-bucket');
      setInput(query('#cred-keyid'), 'AKIDEXAMPLE1234');

      // Simulate Safari private browsing / blocked site data / quota exhaustion —
      // every localStorage write handleSaveProfile makes goes through safeSetRaw,
      // which swallows exactly this.
      proto.setItem = function () { throw new Error('simulated storage failure'); };

      fire(query('.profile-save-trigger'), 'click');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      assert.equal(query('#cred-endpoint')?.value, 'https://s3.us-east-1.amazonaws.com',
        'endpoint must survive a save attempt that silently failed to persist');
      assert.equal(query('#cred-bucket')?.value, 'my-bucket',
        'bucket must survive a save attempt that silently failed to persist');
      assert.equal(query('#cred-keyid')?.value, 'AKIDEXAMPLE1234',
        'key ID must survive a save attempt that silently failed to persist');
    } finally {
      // Restore before cleanup/clearAppStorage — both call localStorage methods,
      // and this stub is on the shared prototype every other test relies on.
      proto.setItem = originalSetItem;
      cleanup();
      clearAppStorage();
    }
  });
});

// Connection share links (#endpoint=…&bucket=…&keyId=…) are produced by
// ShareLinkMenu via buildShareUrl(credentials) and consumed on mount via
// readUrlParams(). The connection model rewrote both ends of that path: the
// credentials the link is built FROM are now assembled from a credential record
// plus a connection record, and the mount effect that applies an incoming link
// gained a branch that re-populates the form after migration.
//
// The "shared-link pre-fill banner" tests above cover a recipient with empty
// storage. These cover the case that actually exercises the rewritten mount
// effect: a link arriving at someone who already has a saved connection.
describe('App — connection share links', () => {
  const SHARED = {
    endpoint:       'https://s3.eu-central-003.backblazeb2.com',
    bucket:         'shared-bucket',
    provider:       'b2',
    regionOverride: 'eu-central-003',
    keyId:          'SHAREDKEY123',
  };

  function setShareHash(creds, opts) {
    const url = buildShareUrl(creds, opts);
    window.location.hash = url.slice(url.indexOf('#'));
  }

  function seedOwnConnection() {
    localStorage.setItem('s3b_profiles', JSON.stringify({ version: 1, profiles: [
      { id: 5, name: 'Mine', endpoint: 'https://s3.us-west-004.backblazeb2.com',
        bucket: 'my-bucket', keyId: 'MYKEY', provider: 'b2', regionOverride: 'us-west-004' },
    ]}));
    localStorage.setItem('s3b_last_profile_id', '5');
  }

  test('every shared field survives buildShareUrl -> readUrlParams', () => {
    clearAppStorage();
    setShareHash(SHARED, { includeKeyId: true });
    try {
      assert.deepEqual(readUrlParams(), SHARED,
        'a link must round-trip endpoint, bucket, provider, region and key ID');
    } finally {
      window.location.hash = ''; clearAppStorage();
    }
  });

  test('the secret key is never encoded into a share link', () => {
    const url = buildShareUrl({ ...SHARED, secretKey: 'TOPSECRET' }, { includeKeyId: true });
    assert.equal(url.includes('TOPSECRET'), false, 'secret key must never reach the URL');
  });

  test('a share link overrides the recipient\'s own saved connection in the form', async () => {
    clearAppStorage();
    seedOwnConnection();
    setShareHash(SHARED, { includeKeyId: true });
    const { query, cleanup } = mount(h(App, {}));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(query('#cred-endpoint')?.value, SHARED.endpoint,
        'endpoint must come from the link, not the saved connection');
      assert.equal(query('#cred-bucket')?.value, SHARED.bucket,
        'bucket must come from the link, not the saved connection');
      assert.equal(query('#cred-keyid')?.value, SHARED.keyId,
        'key ID must come from the link, not the saved connection');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  test('opening a share link does not overwrite the stored connection', async () => {
    clearAppStorage();
    seedOwnConnection();
    setShareHash(SHARED, { includeKeyId: true });
    const { cleanup } = mount(h(App, {}));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const { connections } = JSON.parse(localStorage.getItem('s3b_connections'));
      assert.equal(connections.length, 1, 'the link must not create a second connection');
      assert.equal(connections[0].bucket, 'my-bucket',
        'the recipient\'s stored connection must keep its own bucket');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  // BUG-047. Every deep-link parameter lives in the fragment by design, so opening a
  // share link while Bucketer is already loaded is always a SAME-DOCUMENT navigation:
  // the browser fires hashchange and never reloads, and the mount-time readUrlParams()
  // never runs again. Before the fix the link silently did nothing.
  test('a share link pasted while the app is already open is applied', async () => {
    clearAppStorage();
    window.location.hash = '';
    const { query, cleanup } = mount(h(App, {}));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(query('#cred-endpoint')?.value, '', 'precondition: form starts empty');

      // Exactly what the browser does for a fragment-only navigation.
      setShareHash(SHARED, { includeKeyId: true });
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
      await new Promise(resolve => setTimeout(resolve, 0));

      assert.equal(query('#cred-endpoint')?.value, SHARED.endpoint,
        'endpoint must be applied without a page reload');
      assert.equal(query('#cred-bucket')?.value, SHARED.bucket);
      assert.equal(query('#cred-keyid')?.value, SHARED.keyId);
      assert.equal(query('#cred-region')?.value, SHARED.regionOverride);
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  test('a hashchange carrying no connection details leaves the form alone', async () => {
    clearAppStorage();
    setShareHash(SHARED, { includeKeyId: true });
    const { query, cleanup } = mount(h(App, {}));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      // Folder navigation rewrites the fragment with only a prefix param.
      window.location.hash = '#prefix=some/folder/';
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(query('#cred-endpoint')?.value, SHARED.endpoint,
        'a prefix-only hash must not clear connection details already in the form');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });

  test('a link without a key ID leaves that field empty for the recipient', async () => {
    clearAppStorage();
    setShareHash(SHARED);   // no includeKeyId
    const { query, cleanup } = mount(h(App, {}));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(query('#cred-endpoint')?.value, SHARED.endpoint);
      assert.equal(query('#cred-keyid')?.value, '',
        'a link that omitted the key ID must not pre-fill one');
    } finally {
      cleanup(); window.location.hash = ''; clearAppStorage();
    }
  });
});

// ── Task 6 (vault-phase2): wiring the vault into App.jsx ─────────────────────────────
//
// #cred-endpoint (CredentialForm) vs #vault-passphrase (VaultUnlock) are used to
// distinguish "connect form rendered" from "unlock screen rendered" rather than
// autocomplete attributes — CredentialForm's own Secret Key field already uses
// autocomplete="current-password" (matching VaultUnlock's passphrase field by
// design), so that attribute alone cannot tell the two screens apart once both
// exist in the same file.
describe('App — vault lock screen (Task 6)', { skip: !VAULT_ENABLED && 'vault gated off — see VAULT_ENABLED in src/lib/vault.js' }, () => {
  test('a vault present and locked renders VaultUnlock, not the connect form', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.removeItem(SS_KEY_VAULT_KEY); // createVault leaves it unlocked — start locked
    const { query, cleanup } = mount(h(App, {}));
    try {
      assert.ok(query('#vault-passphrase'),
        'the vault passphrase field must render when a vault exists and is locked');
      assert.equal(query('#cred-endpoint'), null,
        'the connect form must not render while locked');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('no vault renders the connect form exactly as today, not the unlock screen', () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      assert.ok(query('#cred-endpoint'), 'the connect form must render when there is no vault');
      assert.equal(query('#vault-passphrase'), null,
        'the vault unlock screen must not render when there is no vault');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('unlocking reveals the connect form', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.removeItem(SS_KEY_VAULT_KEY);
    const { query, cleanup } = mount(h(App, {}));
    try {
      const passInput = query('#vault-passphrase');
      assert.ok(passInput, 'precondition: starts locked');
      setInput(passInput, PASSPHRASE);
      fire(passInput.closest('form'), 'submit');

      let revealed = false;
      for (let i = 0; i < 60 && !revealed; i++) {
        await new Promise(r => setTimeout(r, 10));
        revealed = !!query('#cred-endpoint');
      }
      assert.ok(revealed, 'the connect form must appear after a successful unlock');
    } finally { cleanup(); clearAppStorage(); }
  });
});

describe('App — vault-backed auto-connect (Task 6)', { skip: !VAULT_ENABLED && 'vault gated off — see VAULT_ENABLED in src/lib/vault.js' }, () => {
  test('a connection whose secret is remembered auto-connects on mount without the user typing anything', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    // Leave sessionStorage's vault key intact — this is the "already unlocked, page
    // reloaded in the same tab" scenario the mount-effect recall path exists for
    // (sessionStorage survives a same-tab reload; it does not survive a fresh tab).
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credV', label: 'V', endpoint: 'http://127.0.0.1:1', keyId: 'AKIDVAULT', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 501, name: 'Vault conn', credentialId: 'credV', bucket: 'vault-bucket', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '501');
    await rememberSecret('credV', 'sekrit-value', window.crypto.subtle);

    const { query, cleanup } = mount(h(App, {}));
    try {
      let connected = false;
      for (let i = 0; i < 80 && !connected; i++) {
        await new Promise(r => setTimeout(r, 10));
        connected = !!query('[data-testid="app-connected"]');
      }
      assert.ok(connected, 'the app must auto-connect using the remembered secret without any typing');
    } finally { cleanup(); clearAppStorage(); }
  });

  // Design doc: "Clicking a connection focuses the passphrase; Enter unlocks and
  // connects into that connection in one motion" — unlocking must not merely reveal
  // the connect form, it must attempt the same recall-and-connect the mount effect
  // does, immediately, for a genuinely fresh tab (no prior sessionStorage) too.
  test('unlocking auto-connects into the selected connection when its secret is remembered (one motion)', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credU', label: 'U', endpoint: 'http://127.0.0.1:1', keyId: 'AKIDUNLOCK', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 777, name: 'Unlock conn', credentialId: 'credU', bucket: 'unlock-bucket', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '777');
    await rememberSecret('credU', 'unlocked-secret', window.crypto.subtle);
    sessionStorage.removeItem(SS_KEY_VAULT_KEY); // re-lock before mounting — fresh-tab scenario

    const { query, cleanup } = mount(h(App, {}));
    try {
      const passInput = query('#vault-passphrase');
      assert.ok(passInput, 'precondition: starts locked');
      setInput(passInput, PASSPHRASE);
      fire(passInput.closest('form'), 'submit');

      let connected = false;
      for (let i = 0; i < 80 && !connected; i++) {
        await new Promise(r => setTimeout(r, 10));
        connected = !!query('[data-testid="app-connected"]');
      }
      assert.ok(connected, 'unlocking must auto-connect into the selected connection in one motion');
    } finally { cleanup(); clearAppStorage(); }
  });
});

describe('App — post-connect vault offer (Task 6)', { skip: !VAULT_ENABLED && 'vault gated off — see VAULT_ENABLED in src/lib/vault.js' }, () => {
  test('the offer appears after the first successful connect when no vault exists', () => {
    clearAppStorage();
    const { query, text, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'offer-bucket');
      setInput(query('#cred-keyid'), 'AKIDOFFER');
      setInput(query('#cred-secretkey'), 'offer-secret');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(/retype it/i.test(text()),
        'the post-connect vault offer must appear after a successful connect with no vault present');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('the offer never appears once a vault already exists', () => {
    clearAppStorage();
    localStorage.setItem('s3b_vault', JSON.stringify({
      version: 1, salt: 'c2FsdA==', iterations: 1, check: { iv: 'aXY=', ct: 'Y3Q=' }, entries: {},
    }));
    // Simulate "already unlocked" directly rather than awaiting createVault — the
    // condition under test (vaultExists()) does not depend on the record being
    // real/decryptable, only present, so an ordinary (non-async) seed keeps this
    // test fast and lock-state-independent of a real derivation.
    sessionStorage.setItem(SS_KEY_VAULT_KEY, 'irrelevant-for-this-test');
    const { query, text, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'offer-bucket-2');
      setInput(query('#cred-keyid'), 'AKIDOFFER2');
      setInput(query('#cred-secretkey'), 'offer-secret-2');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!/retype it/i.test(text()),
        'the offer must never appear once a vault already exists');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('dismissing the offer persists so it never reappears, even after a fresh mount', () => {
    clearAppStorage();
    {
      const { query, text, cleanup } = mount(h(App, {}));
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'dismiss-bucket');
      setInput(query('#cred-keyid'), 'AKIDDISMISS');
      setInput(query('#cred-secretkey'), 'dismiss-secret');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(/retype it/i.test(text()), 'precondition: the offer is showing');
      const closeBtn = query('.banner-close');
      assert.ok(closeBtn, 'the offer banner must use the existing banner-close dismiss control');
      fire(closeBtn, 'click');
      assert.ok(!/retype it/i.test(text()), 'the offer must disappear once dismissed');
      cleanup();
    }
    try {
      const { query, text, cleanup } = mount(h(App, {}));
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'dismiss-bucket-2');
      setInput(query('#cred-keyid'), 'AKIDDISMISS2');
      setInput(query('#cred-secretkey'), 'dismiss-secret-2');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!/retype it/i.test(text()),
        'a dismissed offer must never reappear, even after a fresh App mount');
      cleanup();
    } finally {
      clearAppStorage();
    }
  });

  test('accepting the offer creates the vault and remembers the just-connected secret', async () => {
    clearAppStorage();
    const { query, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'accept-bucket');
      setInput(query('#cred-keyid'), 'AKIDACCEPT');
      setInput(query('#cred-secretkey'), 'accept-secret');
      fire(query('button[type="submit"]'), 'click');

      const userInput = query('#vault-offer-username');
      assert.ok(userInput, 'the offer must include the vault username field so password managers save it correctly matched to the unlock screen');
      assert.equal(userInput.value, VAULT_USERNAME, 'the offer username must be the exact same constant VaultUnlock uses');
      assert.equal(userInput.readOnly, true);

      const passInput = query('input[autocomplete="new-password"]');
      assert.ok(passInput, 'the offer must include a new-password passphrase field so managers offer to generate one');
      setInput(passInput, PASSPHRASE);
      fire(passInput.closest('form'), 'submit');

      let created = false;
      for (let i = 0; i < 80 && !created; i++) {
        await new Promise(r => setTimeout(r, 10));
        created = vaultExists();
      }
      assert.ok(created, 'accepting the offer must create the vault');

      const { credentials } = JSON.parse(localStorage.getItem('s3b_credentials'));
      const cred = credentials.find(c => c.endpoint === 'http://127.0.0.1:1' && c.keyId === 'AKIDACCEPT');
      assert.ok(cred, 'a credential must be persisted for the just-connected values');

      // vaultExists() flips true as soon as createVault's own write lands, but
      // rememberSecret is a SEPARATE await after that inside handleAcceptVaultOffer
      // — poll recallSecret itself rather than assuming it has landed the instant
      // vaultExists() does (the vaultExists() poll above caught this as a real,
      // reproducible flake before this loop was added).
      let recalled = null;
      for (let i = 0; i < 80 && recalled === null; i++) {
        recalled = await recallSecret(cred.id, window.crypto.subtle);
        if (!recalled) await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(recalled, 'accept-secret', 'the just-typed secret must be remembered under the new credential');
    } finally { cleanup(); clearAppStorage(); }
  });
});

// ── Vault kill switch ─────────────────────────────────────────────────────────────
// The vault's creation flow failed its design review (2 Critical + 5 Important, all
// in the post-connect offer's accept flow — docs/superpowers/HANDOFF-2026-07-28-vault-phase2.md).
// Until the redesign lands, VAULT_ENABLED in src/lib/vault.js gates every
// user-reachable entry point. These tests pin the gated behavior; the three Task 6
// suites above skip while the flag is off and re-arm the moment it flips back.
// The re-wrap and disconnect suites below stay active either way: the record layer
// keeps honoring a pre-existing vault, it just can't be created, unlocked, or
// auto-connected from while gated.
describe('App — vault gated off (VAULT_ENABLED=false)', { skip: VAULT_ENABLED && 'vault is enabled — the Task 6 suites cover these paths' }, () => {
  test('a vault present and locked still renders the connect form, never the unlock screen', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    sessionStorage.removeItem(SS_KEY_VAULT_KEY); // start locked, as a returning user would
    const { query, cleanup } = mount(h(App, {}));
    try {
      assert.ok(query('#cred-endpoint'),
        'the connect form must render even when a locked vault exists (C1: no lockout while gated)');
      assert.equal(query('#vault-passphrase'), null,
        'the unlock screen must be unreachable while the vault is gated off');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('a successful connect never shows the vault offer', () => {
    clearAppStorage();
    const { query, text, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'gated-bucket');
      setInput(query('#cred-keyid'), 'AKIDGATED');
      setInput(query('#cred-secretkey'), 'gated-secret');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!/retype it/i.test(text()),
        'the post-connect vault offer must not appear while the vault is gated off');
    } finally { cleanup(); clearAppStorage(); }
  });

  test('a remembered secret does not auto-connect on mount', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    // Same seed as the Task 6 auto-connect test: unlocked vault, remembered secret,
    // last-used connection selected — the strongest possible auto-connect setup.
    localStorage.setItem('s3b_connections_migrated', '1');
    localStorage.setItem('s3b_credentials', JSON.stringify({
      version: 1,
      credentials: [{ id: 'credG', label: 'G', endpoint: 'http://127.0.0.1:1', keyId: 'AKIDGATE2', provider: null, regionOverride: '' }],
    }));
    localStorage.setItem('s3b_connections', JSON.stringify({
      version: 2,
      connections: [{ id: 601, name: 'Gated conn', credentialId: 'credG', bucket: 'gated-bucket-2', capabilities: null }],
    }));
    localStorage.setItem('s3b_last_profile_id', '601');
    await rememberSecret('credG', 'gated-secret-2', window.crypto.subtle);

    const { query, cleanup } = mount(h(App, {}));
    try {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 10));
        assert.equal(query('[data-testid="app-connected"]'), null,
          'the app must not auto-connect from the vault while gated off');
      }
      assert.ok(query('#cred-endpoint'), 'the ordinary connect form must be what renders');
    } finally { cleanup(); clearAppStorage(); }
  });
});

// Task 1 (#53) collects the credential a re-pointed connection stops using. Without
// this Task 6 addition, a secret the user just typed to replace an old key would be
// wrapped under an id that saveConnectionRecord's own cascade deletes moments later —
// remembered, then immediately silently forgotten.
describe('App — re-wrap on credential change while the vault is unlocked (Task 6)', () => {
  test('pointing a saved connection at a new credential while a secret is typed remembers it under the new credential id', async () => {
    clearAppStorage();
    await createVault(PASSPHRASE, window.crypto.subtle, getRandomValues);
    const oldCred = findOrCreateCredential({ endpoint: 'https://s3.old.example.com', keyId: 'kOld', provider: null, regionOverride: '' });
    saveConnectionRecord({ id: 900, name: 'Rewrap conn', credentialId: oldCred.id, bucket: 'buck', capabilities: null });
    localStorage.setItem('s3b_last_profile_id', '900');
    // Deliberately no rememberSecret call for oldCred's entry — nothing to
    // auto-connect with, so the splash form (not the connected view) is what
    // renders and is under test here.

    const { query, cleanup } = mount(h(App, {}));
    try {
      for (let i = 0; i < 20 && query('#cred-endpoint')?.value !== 'https://s3.old.example.com'; i++) {
        await new Promise(r => setTimeout(r, 0));
      }
      assert.equal(query('#cred-endpoint')?.value, 'https://s3.old.example.com',
        'precondition: form pre-filled from the saved connection');

      setInput(query('#cred-endpoint'), 'https://s3.new.example.com');
      setInput(query('#cred-keyid'), 'kNew');
      setInput(query('#cred-secretkey'), 'new-secret');

      fire(query('.profile-save-trigger'), 'click');
      fire(query('.profile-save-form button[type="submit"]'), 'click');

      const { credentials } = JSON.parse(localStorage.getItem('s3b_credentials'));
      const newCred = credentials.find(c => c.endpoint === 'https://s3.new.example.com');
      assert.ok(newCred, 'a new credential must be created for the new endpoint/key');

      let recalled = null;
      for (let i = 0; i < 60 && recalled === null; i++) {
        recalled = await recallSecret(newCred.id, window.crypto.subtle);
        if (!recalled) await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(recalled, 'new-secret',
        'the typed secret must be wrapped under the new credential id, not silently forgotten');
    } finally { cleanup(); clearAppStorage(); }
  });
});

describe('App — disconnect does not lock the vault (Task 6)', () => {
  test('disconnecting leaves the vault unlocked', () => {
    clearAppStorage();
    localStorage.setItem('s3b_vault', JSON.stringify({
      version: 1, salt: 'c2FsdA==', iterations: 1, check: { iv: 'aXY=', ct: 'Y3Q=' }, entries: {},
    }));
    sessionStorage.setItem(SS_KEY_VAULT_KEY, 'irrelevant-for-this-test'); // vault starts unlocked
    const { query, cleanup } = mount(h(App, {}));
    try {
      setInput(query('#cred-endpoint'), 'http://127.0.0.1:1');
      setInput(query('#cred-bucket'), 'disc-bucket');
      setInput(query('#cred-keyid'), 'AKIDDISC');
      setInput(query('#cred-secretkey'), 'disc-secret');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(isUnlocked(), 'precondition: the vault is unlocked while connected');

      const disconnectBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Disconnect');
      assert.ok(disconnectBtn, 'the Disconnect button must be present once connected');
      fire(disconnectBtn, 'click');

      assert.ok(isUnlocked(), 'disconnecting must not lock the vault — only a tab close should end the session');
    } finally { cleanup(); clearAppStorage(); }
  });
});
