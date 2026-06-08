// Copyright (C) 2026 HidayahTech, LLC
// Multipart upload resume record persistence (§4.15, REQ-8).
//
// WHY THIS FILE EXISTS: resume records are one of four distinct concerns that lived
// in indexeddb.js. Splitting them out makes it easy to find, test, and reason about
// the resume lifecycle without reading unrelated code (file identity, active-upload
// tracking, upload history).
//
// WHAT BELONGS HERE: CRUD for resume records in the s3browser_uploads object store.
// Records are keyed by provider:endpoint:bucket:destinationKey.
//
// WHAT DOES NOT BELONG HERE: file identity hashing (file-identity.js), cross-tab
// active-upload tracking (active-uploads.js), or upload log entries (upload-log.js).
//
// CRITICAL INVARIANT: saveResumeRecord() must be called BEFORE any UploadPartCommand.
// If the browser crashes on part 1, the record already exists and the user can recover.
// If it were saved after the first part, a crash before that save would leave an
// orphaned multipart session.

import { openDB, STORE } from './indexeddb-core.js';

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
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadResumeRecord({ provider, endpoint, bucket, destinationKey }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(recordKey({ provider, endpoint, bucket, destinationKey }));
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteResumeRecord({ provider, endpoint, bucket, destinationKey }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(recordKey({ provider, endpoint, bucket, destinationKey }));
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadAllResumeRecords() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

export async function clearAllResumeRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}
