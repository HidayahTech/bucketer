// Resumable upload state via IndexedDB (§4.15)
// Store: s3browser_uploads
// Key: {provider}:{endpoint}:{bucket}:{destinationKey}

const DB_NAME = 's3browser';
const STORE = 's3browser_uploads';
const DB_VERSION = 1;

// Warning threshold for UploadId expiry — B2 unconfirmed, using R2's 7-day value (Q1 in QUESTIONS.md)
export const UPLOAD_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

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
