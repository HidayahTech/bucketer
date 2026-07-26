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

const LS_KEY_CREDENTIALS = 's3b_credentials';
const LS_KEY_CONNECTIONS = 's3b_connections';

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
// Returns true when the deletion happened, false when it was refused.
export function deleteCredentialRecord(id) {
  const { connections } = loadConnectionRecords();
  if (connections.some(c => c.credentialId === id)) return false;
  const data = loadCredentialRecords();
  data.credentials = data.credentials.filter(c => c.id !== id);
  saveCredentialData(data);
  return true;
}

export function saveConnectionRecord(conn) {
  // eslint-disable-next-line no-unused-vars
  const { secretKey: _dropped, ...safeConn } = conn;
  const data = loadConnectionRecords();
  const idx = data.connections.findIndex(c => c.id === safeConn.id);
  if (idx >= 0) data.connections[idx] = { ...data.connections[idx], ...safeConn };
  else data.connections.push({ ...safeConn });
  saveConnectionData(data);
}

export function deleteConnectionRecord(id) {
  const data = loadConnectionRecords();
  data.connections = data.connections.filter(c => c.id !== id);
  saveConnectionData(data);
}

// Removes both records outright. Used by wipeAllAppData and the storage inspector.
export function deleteAllConnectionData() {
  safeRemoveRaw(LS_KEY_CREDENTIALS);
  safeRemoveRaw(LS_KEY_CONNECTIONS);
}

export const CONNECTION_STORAGE_KEYS = [LS_KEY_CREDENTIALS, LS_KEY_CONNECTIONS];
