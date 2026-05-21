// Resumable upload state via IndexedDB (§4.15)
// Store: s3browser_uploads
// Key: {provider}:{endpoint}:{bucket}:{destinationKey}

const DB_NAME = 's3browser';
const STORE = 's3browser_uploads';
const DB_VERSION = 1;

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
      e.target.result.createObjectStore(STORE);
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function recordKey({ provider, endpoint, bucket, destinationKey }) {
  return `${provider}:${endpoint}:${bucket}:${destinationKey}`;
}

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

// Compute a fast partial hash (first + last 64 KB via SubtleCrypto) for file identity (§4.15)
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

// Concurrent tab conflict detection (§4.15)
// Store active upload key in localStorage with a tab-unique ID; other tabs can check it.
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
