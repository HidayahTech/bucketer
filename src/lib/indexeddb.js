// Persistent upload state via IndexedDB (§4.15, REQ-8).
//
// Two object stores:
//   s3browser_uploads:   multipart resume records — survives tab close, browser restart
//   bucketer_upload_log: upload history with auto-increment ID
//
// Resume records are keyed by provider:endpoint:bucket:destinationKey and are saved
// BEFORE any parts are uploaded. This is the critical invariant: if the browser crashes
// on part 1, the record already exists and the user can recover. If it were saved after
// the first part, a crash before that save would leave an orphaned multipart session.

const DB_NAME = 's3browser';
const STORE = 's3browser_uploads';
const LOG_STORE = 'bucketer_upload_log';
const DB_VERSION = 2;

// UploadId expiry by provider:
// - R2: auto-expires after 7 days (documented)
// - B2: no automatic expiry — incomplete uploads persist indefinitely until
//       AbortMultipartUpload is called or a lifecycle rule triggers (Q1 resolved)
// - Others: unknown, use R2's value as a conservative default
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function uploadExpiryWarningMs(provider) {
  if (provider === 'b2') return null; // B2 sessions don't expire automatically
  return SEVEN_DAYS_MS; // R2 and others: warn after 7 days
}

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(LOG_STORE)) db.createObjectStore(LOG_STORE, { autoIncrement: true });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function recordKey({ provider, endpoint, bucket, destinationKey }) {
  return `${provider}:${endpoint}:${bucket}:${destinationKey}`;
}

// Must be called BEFORE any UploadPartCommand so a crash mid-upload is recoverable.
export async function saveResumeRecord(params) {
  // params: { provider, endpoint, bucket, destinationKey, uploadId, partSize, fileIdentity, startedAt }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(params, recordKey(params));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadResumeRecord({ provider, endpoint, bucket, destinationKey }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(recordKey({ provider, endpoint, bucket, destinationKey }));
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteResumeRecord({ provider, endpoint, bucket, destinationKey }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(recordKey({ provider, endpoint, bucket, destinationKey }));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// SHA-256 of the first and last 64 KB of the file (§4.15 file identity). Partial hash
// is fast enough for interactive use without reading the entire file. Returns null if
// SubtleCrypto is unavailable (some Safari / Private Browsing contexts) — resume still
// works using name/size/mtime without the content hash.
export async function computeFileHash(file) {
  try {
    const CHUNK = 64 * 1024;
    const parts = [];
    parts.push(file.slice(0, CHUNK));
    if (file.size > CHUNK) {
      parts.push(file.slice(Math.max(file.size - CHUNK, CHUNK)));
    }
    const buf = await new Blob(parts).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // SubtleCrypto unavailable (e.g. Safari + file://)
  }
}

// Build a verifiable identity for a File. On resume, fileIdentityMatches() confirms the
// user re-selected the same file — not one that was renamed, resized, or replaced since
// the upload started. The optional contentHash (stored separately by the caller) provides
// extra certainty when name/size/mtime happen to collide.
export function buildFileIdentity(file) {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

export function fileIdentityMatches(identity, file) {
  return (
    identity.name === file.name &&
    identity.size === file.size &&
    identity.lastModified === file.lastModified
  );
}

// BUG-008: contentHash must be added to fileIdentity BEFORE saveResumeRecord is called.
// Adding it after means a crash between save and hash write leaves a record without a hash,
// so a content-changed file would not be detected on resume.
export async function buildFileIdentityWithHash(file) {
  const identity = buildFileIdentity(file);
  const hash = await computeFileHash(file);
  if (hash) identity.contentHash = hash;
  return identity;
}

// Concurrent tab conflict detection (§4.15). Two tabs uploading to the same destination
// key would overwrite each other's parts and corrupt resume state. Each tab registers
// its in-flight uploads in localStorage under a tab-unique ID. isUploadActiveElsewhere()
// returns true when a different tab's ID is present, triggering a user-visible warning.
// Best-effort: private mode disables detection gracefully.
const TAB_ID = Math.random().toString(36).slice(2);
const ACTIVE_KEY = 's3b_active_uploads';

function getActiveUploads() {
  try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '{}'); } catch { return {}; }
}

export function markUploadActive(destinationKey) {
  try {
    const active = getActiveUploads();
    active[destinationKey] = TAB_ID;
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
  } catch { /* */ }
}

export function markUploadInactive(destinationKey) {
  try {
    const active = getActiveUploads();
    if (active[destinationKey] === TAB_ID) {
      delete active[destinationKey];
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    }
  } catch { /* */ }
}

export function isUploadActiveElsewhere(destinationKey) {
  try {
    const active = getActiveUploads();
    return active[destinationKey] !== undefined && active[destinationKey] !== TAB_ID;
  } catch { return false; }
}

// ── Upload log (persisted history) ────────────────────────────────────────────
// Each entry: { fileName, destinationKey, fileSize, status, startedAt,
//               completedAt, durationSec, avgSpeedBps, errorMessage }

export async function saveUploadLogEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite');
    tx.objectStore(LOG_STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadUploadLog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readonly');
    const req = tx.objectStore(LOG_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []).reverse()); // newest first
    req.onerror = () => reject(req.error);
  });
}

export async function clearUploadLog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite');
    tx.objectStore(LOG_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
