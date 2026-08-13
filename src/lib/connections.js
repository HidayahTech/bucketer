// Copyright (C) 2026 HidayahTech, LLC
// Credential and connection persistence — the bipartite model that replaces the
// flat profile record.
//
// WHY TWO RECORDS: a credential (endpoint + key ID + provider + region) can
// reach many buckets, and a bucket can be reached by many credentials — a
// read-only key for browsing and a read-write key for changes are two distinct,
// separately-named things pointing at the same bucket. A single flat record
// cannot express that without duplicating the credential.
//
// The nameable unit the user clicks is the CONNECTION — the (credential, bucket)
// pairing. That is what today's profile already is, so resolveConnection()
// projects a connection back into a profile-shaped object and existing UI keeps
// working unchanged.
//
// Secret keys are NEVER stored here. They live in sessionStorage (storage.js)
// and, from Phase 2, encrypted in the vault keyed by credential id.
//
// All storage access goes through safe wrappers — private browsing throws on
// every read and write, and the app must degrade rather than crash.

import { PROVIDER_LABELS } from './provider.js';
import { deleteVaultEntry } from './vault.js';

const LS_KEY_CREDENTIALS = 's3b_credentials';
const LS_KEY_CONNECTIONS = 's3b_connections';
// Sentinel with two purposes, both keyed off the same underlying fact:
//
//   1. migrateProfilesToConnections() uses it to know it has already converted
//      s3b_profiles, so it does not run the conversion loop again. Deliberately
//      NOT "connections.length > 0" for that purpose — that emptied out whenever
//      the user deleted their last connection, which made the next mount treat
//      storage as "not yet migrated" and rebuild every deleted connection
//      straight back out of the (never-deleted) s3b_profiles record.
//
//   2. saveConnectionRecord() also sets it, recording durably that this user is
//      on the connection model the instant any connection is created (via
//      migration's loop or via handleSaveProfile), so App's legacy flat-key
//      migration gate (hasMigratedConnections()) does not have to re-derive that
//      fact from the connection list — which deleteConnectionRecord can empty
//      just as easily, reintroducing the same resurrection bug one level up.
//
// Name kept as s3b_connections_migrated even though its meaning has widened to
// "the connection model is in use" — renaming a storage key mid-branch is a
// migration problem of its own for no benefit. See hasMigratedConnections()
// below for the up-to-date meaning.
const LS_KEY_MIGRATED = 's3b_connections_migrated';

const CREDENTIALS_VERSION = 1;
const CONNECTIONS_VERSION = 2;

function safeGetRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetRaw(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode — in-memory state continues */ }
}
function safeRemoveRaw(key) {
  try { localStorage.removeItem(key); } catch { /* */ }
}

// Monotonic id generator. Deliberately NOT crypto.randomUUID(): that requires a
// secure context, and Bucketer supports being opened from file:// (see
// FileBanner.jsx). The sequence counter guarantees uniqueness even when several
// ids are minted inside the same millisecond, which migration does.
// ⚠️ CREDENTIAL IDS ONLY — do not use this for connection ids without reading this.
//
// Connection ids are NUMBERS: new ones are Date.now() (App.jsx handleSaveProfile) and
// migrated ones reuse the numeric profile.id. The selected-connection pointer is read
// through loadLastProfileId() (storage.js), which coerces with Number(). Give a
// connection a string id from here and that coercion yields NaN, so the pointer can
// never match it again — the connection becomes permanently unselectable, silently.
//
// Either keep connection ids numeric, or change loadLastProfileId() to stop coercing
// and migrate the stored pointer. Do not mix the two.
let _seq = 0;
export function newId(prefix) {
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

function emptyCredentials() {
  return { version: CREDENTIALS_VERSION, credentials: [] };
}
function emptyConnections() {
  return { version: CONNECTIONS_VERSION, connections: [] };
}

export function loadCredentialRecords() {
  try {
    const raw = safeGetRaw(LS_KEY_CREDENTIALS);
    if (!raw) return emptyCredentials();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.credentials)) return emptyCredentials();
    return parsed;
  } catch {
    return emptyCredentials();
  }
}

export function loadConnectionRecords() {
  try {
    const raw = safeGetRaw(LS_KEY_CONNECTIONS);
    if (!raw) return emptyConnections();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.connections)) return emptyConnections();
    return parsed;
  } catch {
    return emptyConnections();
  }
}

function saveCredentialData(data) {
  safeSetRaw(LS_KEY_CREDENTIALS, JSON.stringify(data));
}
function saveConnectionData(data) {
  safeSetRaw(LS_KEY_CONNECTIONS, JSON.stringify(data));
}

// secretKey is stripped defensively — callers pass whole form objects, and a
// secret must never reach localStorage. Mirrors saveProfile in storage.js.
export function saveCredentialRecord(cred) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...safeCred } = cred;
  const data = loadCredentialRecords();
  const idx = data.credentials.findIndex(c => c.id === safeCred.id);
  if (idx >= 0) data.credentials[idx] = { ...data.credentials[idx], ...safeCred };
  else data.credentials.push({ ...safeCred });
  saveCredentialData(data);
}

// Refuses to delete a credential that connections still reference. An orphaned
// credentialId is a corruption class nothing can repair — the endpoint and key
// ID are gone — so it must never be created in the first place.
// Returns true when the deletion happened, false when it was refused. The
// vault entry cascade below must fire only on the true path: a still-shared
// credential's ciphertext must survive a refused deletion.
export function deleteCredentialRecord(id) {
  const { connections } = loadConnectionRecords();
  if (connections.some(c => c.credentialId === id)) return false;
  const data = loadCredentialRecords();
  data.credentials = data.credentials.filter(c => c.id !== id);
  saveCredentialData(data);
  deleteVaultEntry(id);
  return true;
}

export function saveConnectionRecord(conn) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...incoming } = conn;
  // Filter out undefined values: they would override stored values via spread, but
  // callers pass partial objects where an absent key means "leave it alone".
  const safeConn = Object.fromEntries(
    Object.entries(incoming).filter(([, v]) => v !== undefined)
  );
  const data = loadConnectionRecords();
  const idx = data.connections.findIndex(c => c.id === safeConn.id);
  const previousCredentialId = idx >= 0 ? data.connections[idx].credentialId : null;
  if (idx >= 0) data.connections[idx] = { ...data.connections[idx], ...safeConn };
  else data.connections.push({ ...safeConn });
  saveConnectionData(data);
  // Record, durably, that this user is on the connection model — the moment any
  // connection is created, however it got there (migration's loop or
  // handleSaveProfile). This must be a recorded FACT, not derived from the
  // connection list's current emptiness: deleteConnectionRecord can empty that
  // list again, and re-deriving "not yet on the connection model" from an empty
  // list is exactly what let the legacy flat-key chain resurrect a phantom
  // connection after a user saved one and then deleted it (see
  // hasMigratedConnections() for the full explanation).
  safeSetRaw(LS_KEY_MIGRATED, '1');
  // If this is an update and the credential changed, garbage-collect the old one.
  // The new connection record is already persisted at this point, so
  // deleteCredentialRecord's reference check will see the updated link and
  // correctly decide whether anything still uses the old credential (#53).
  // Check 'credentialId' in safeConn separately: partial updates are a load-bearing
  // feature (e.g. omitting capabilities to leave it untouched). An absent key means
  // "leave it alone", not "it changed to undefined". Explicit undefined would orphan
  // the connection, so we must guard against that case.
  if (previousCredentialId !== null
      && 'credentialId' in safeConn
      && safeConn.credentialId !== undefined
      && previousCredentialId !== safeConn.credentialId) {
    deleteCredentialRecord(previousCredentialId);
  }
}

// Also garbage-collects the connection's credential: an explicitly deleted
// connection must not leave its endpoint/key/provider/region behind forever with
// no UI able to remove it (this compounds in Phase 2, where the vault will key
// encrypted secrets by credential id). deleteCredentialRecord already refuses when
// another connection still references the credential, which is exactly the
// shared-credential case, so no extra guard is needed here.
export function deleteConnectionRecord(id) {
  const data = loadConnectionRecords();
  const conn = data.connections.find(c => c.id === id);
  data.connections = data.connections.filter(c => c.id !== id);
  saveConnectionData(data);
  if (conn) deleteCredentialRecord(conn.credentialId);
}

// Removes every key this module owns outright. Used by wipeAllAppData and the
// storage inspector. Iterates CONNECTION_STORAGE_KEYS rather than naming keys
// individually so a key added to that list (e.g. the migration marker) cannot be
// forgotten here — leaving a marker behind after a wipe would permanently disable
// migration for that user.
export function deleteAllConnectionData() {
  CONNECTION_STORAGE_KEYS.forEach(k => safeRemoveRaw(k));
}

export const CONNECTION_STORAGE_KEYS = [LS_KEY_CREDENTIALS, LS_KEY_CONNECTIONS, LS_KEY_MIGRATED];

// Normalizes the four fields that identify a credential, so that cosmetic
// differences (a trailing slash, stray whitespace, null vs '' provider) do not
// produce two credentials for what is really one key. Endpoint normalization
// matches what CredentialForm.handleSubmit does before saving.
export function credentialFingerprint({ endpoint, keyId, provider, regionOverride }) {
  const e = (endpoint || '').trim().replace(/\/$/, '');
  const k = keyId || '';
  const p = provider || '';
  const r = (regionOverride || '').trim();
  // JSON.stringify of the tuple, not a join on a separator character. Any
  // separator that can also occur inside a field lets distinct tuples collide:
  // ['a','b c'] and ['a b','c'] join identically. Migration feeds legacy records
  // straight in without form validation, so this cannot assume well-formed input.
  return JSON.stringify([e, k, p, r]);
}

const LABEL_KEY_ID_MAX = 6;

export function defaultCredentialLabel({ provider, keyId }) {
  const id = keyId || '';
  const shortId = id.length > LABEL_KEY_ID_MAX ? `${id.slice(0, LABEL_KEY_ID_MAX)}…` : id;
  const label = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : null;
  return label ? `${label} — ${shortId}` : shortId;
}

export function defaultConnectionName({ provider, bucket }) {
  const label = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : null;
  return label && bucket ? `${label} — ${bucket}` : (bucket || '');
}

// Returns the existing credential matching these fields, or creates and persists
// a new one. This is what makes N connections on one key store that key once.
export function findOrCreateCredential({ endpoint, keyId, provider, regionOverride, label }) {
  const fingerprint = credentialFingerprint({ endpoint, keyId, provider, regionOverride });
  const { credentials } = loadCredentialRecords();
  const existing = credentials.find(c => credentialFingerprint(c) === fingerprint);
  if (existing) return existing;

  const cred = {
    id:             newId('cred'),
    label:          label || defaultCredentialLabel({ provider, keyId }),
    endpoint:       (endpoint || '').trim().replace(/\/$/, ''),
    keyId:          keyId || '',
    provider:       provider || null,
    regionOverride: (regionOverride || '').trim(),
  };
  saveCredentialRecord(cred);
  return cred;
}

// Joins a connection to its credential. The returned shape is deliberately
// field-compatible with the old profile object so existing UI (ProfilePicker,
// App's connect path) consumes it unchanged.
//
// Returns null when the connection is unknown OR its credential is missing. An
// orphaned credentialId is a corruption class migration cannot repair, so it is
// treated as "not there" rather than surfaced as a half-built object.
export function resolveConnection(id) {
  const { connections } = loadConnectionRecords();
  const conn = connections.find(c => c.id === id);
  if (!conn) return null;
  const { credentials } = loadCredentialRecords();
  const cred = credentials.find(c => c.id === conn.credentialId);
  if (!cred) return null;
  return {
    id:             conn.id,
    name:           conn.name,
    bucket:         conn.bucket,
    basePrefix:     conn.basePrefix || '',
    capabilities:   conn.capabilities || null,
    credentialId:   cred.id,
    endpoint:       cred.endpoint,
    keyId:          cred.keyId,
    provider:       cred.provider,
    regionOverride: cred.regionOverride,
  };
}

export function listResolvedConnections() {
  const { connections } = loadConnectionRecords();
  return connections
    .map(c => resolveConnection(c.id))
    .filter(Boolean);
}

const LS_KEY_PROFILES = 's3b_profiles';

// Exposed so callers outside this module can decide for themselves whether
// connection migration has already happened, rather than inferring it from a
// record (s3b_profiles) that connections-model code paths no longer maintain.
// App's mount effect uses this to gate the legacy flat-key migration chain.
//
// Two different questions, deliberately not the same predicate:
//
//   migrateProfilesToConnections() asks "have I already converted s3b_profiles?"
//   and must stay marker-only — treating an empty connection list as "unmigrated"
//   is what resurrected deleted connections from the never-deleted s3b_profiles.
//
//   This asks "is this user already on the connection model?" — true from the
//   instant saveConnectionRecord() first records it (the marker check below),
//   which is now the load-bearing answer.
//
// The connections.length fallback below is NOT equivalent to the marker and is
// deliberately secondary: it is NOT monotonic — it stops being true the moment
// the last connection is deleted, even though the user unambiguously remains on
// the connection model. Relying on it alone (as an earlier version of this fix
// did) let deleteConnectionRecord silently flip this predicate back to false,
// which made the legacy chain run again and synthesise a phantom profile from
// stale flat keys — the same resurrection bug as the original Critical,
// relocated to this gate instead of migrateProfilesToConnections(). It is kept
// only as a fallback for connection records written by a build that predates
// saveConnectionRecord() setting the marker.
export function hasMigratedConnections() {
  if (safeGetRaw(LS_KEY_MIGRATED)) return true;
  return loadConnectionRecords().connections.length > 0;
}

// Idempotent — converts the legacy flat profile record into credentials +
// connections. Safe to call on every mount; returns immediately once the
// migration marker (LS_KEY_MIGRATED) is set.
//
// s3b_profiles is READ but deliberately NOT deleted: it is the rollback path for
// one release. A later release removes it.
//
// Profile ids become connection ids so the existing s3b_last_profile_id pointer
// keeps resolving without a second migration.
export function migrateProfilesToConnections() {
  if (safeGetRaw(LS_KEY_MIGRATED)) return;

  // A build from before the marker existed may already have migrated. Adopt that
  // state rather than re-running against s3b_profiles, which is never deleted —
  // otherwise a later delete of every connection would look identical to "not yet
  // migrated" and resurrect them all from the stale legacy record.
  if (loadConnectionRecords().connections.length > 0) {
    safeSetRaw(LS_KEY_MIGRATED, '1');
    return;
  }

  let profiles = [];
  try {
    const raw = safeGetRaw(LS_KEY_PROFILES);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) return;
    profiles = parsed.profiles;
  } catch {
    return; // corrupt legacy record — nothing to migrate
  }

  for (const profile of profiles) {
    try {
      // A profile without a bucket cannot become a usable connection. Skipping is
      // preferable to creating a row that fails the moment it is clicked.
      if (!profile || !profile.bucket) continue;

      const cred = findOrCreateCredential({
        endpoint:       profile.endpoint,
        keyId:          profile.keyId,
        provider:       profile.provider,
        regionOverride: profile.regionOverride,
      });

      saveConnectionRecord({
        id:           profile.id,
        name:         profile.name || defaultConnectionName({ provider: profile.provider, bucket: profile.bucket }),
        credentialId: cred.id,
        bucket:       profile.bucket,
        capabilities: null,
      });
    } catch {
      // One malformed record must not strand the profiles after it. The guard at
      // the top of this function only checks the migration marker, so a throw
      // mid-loop would make every later profile permanently unreachable.
      continue;
    }
  }

  // Only reached once every profile has been attempted. saveConnectionRecord()
  // now sets this marker itself the moment any connection is created, so this
  // write is redundant whenever at least one profile actually converted — but it
  // is still the ONLY thing that sets the marker when every profile was skipped
  // (no bucket) or the profiles array was empty: saveConnectionRecord() is never
  // called in that case, and without this write migration would be re-attempted
  // (and re-produce nothing) on every future mount instead of being recorded as
  // complete. An early return above (missing/corrupt s3b_profiles) deliberately
  // leaves the marker unset so a later mount can retry rather than being locked
  // into "migrated nothing" forever.
  safeSetRaw(LS_KEY_MIGRATED, '1');
}

const CAPABILITY_OPS = ['list', 'download', 'upload', 'delete'];

export function defaultCapabilities() {
  return { list: 'unknown', download: 'unknown', upload: 'unknown', delete: 'unknown' };
}

function isValidCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return false;
  return CAPABILITY_OPS.every(op => typeof caps[op] === 'string');
}

// Capabilities live on the connection record rather than in one global key, so
// that state learned against one bucket is never applied to another.
//
// An unknown connection id returns defaults rather than throwing: ad-hoc
// credentials with no saved connection are a supported case, and the caller
// holds their capabilities in memory for the session only.
export function loadConnectionCapabilities(id) {
  const { connections } = loadConnectionRecords();
  const conn = connections.find(c => c.id === id);
  if (!conn || !isValidCapabilities(conn.capabilities)) return defaultCapabilities();
  return { ...defaultCapabilities(), ...conn.capabilities };
}

export function saveConnectionCapabilities(id, caps) {
  const data = loadConnectionRecords();
  const idx = data.connections.findIndex(c => c.id === id);
  if (idx < 0) return; // ad-hoc connection — nothing to persist against
  data.connections[idx] = { ...data.connections[idx], capabilities: { ...caps } };
  saveConnectionData(data);
}

export function clearAllConnectionCapabilities() {
  const data = loadConnectionRecords();
  if (!data.connections.length) return;
  data.connections = data.connections.map(c => ({ ...c, capabilities: null }));
  saveConnectionData(data);
}

// Clears provider fields that failed validation. The validity rule lives in
// storage.js (isValidProvider) and is passed in, so the rule is encoded in
// exactly one place rather than duplicated across both modules.
export function repairCredentialProviders(isValidProvider) {
  const data = loadCredentialRecords();
  let dirty = false;
  for (const cred of data.credentials) {
    if (cred.provider && !isValidProvider(cred.provider)) {
      cred.provider = null;
      dirty = true;
    }
  }
  if (dirty) saveCredentialData(data);
}
