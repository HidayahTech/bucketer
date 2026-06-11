// Copyright (C) 2026 HidayahTech, LLC
// Persistent upload history log (IndexedDB).
//
// WHY THIS FILE EXISTS: the upload log is an append-only history store that is
// conceptually separate from the resume record store — resume records are mutable
// operational state while the log is immutable audit history. Keeping them in
// separate files prevents accidental cross-contamination of the two stores.
//
// WHAT BELONGS HERE: functions that append to and read from the bucketer_upload_log
// object store (auto-increment ID, newest-first on read).
//
// WHAT DOES NOT BELONG HERE: resume record CRUD (resume-records.js), file identity
// (file-identity.js), or cross-tab tracking (active-uploads.js).
//
// Each entry: { fileName, destinationKey, fileSize, status, startedAt,
//               completedAt, durationSec, avgSpeedBps, errorMessage,
//               concurrencyMode, peakPartConcurrency, probeResult }

import { openDB, LOG_STORE } from './indexeddb-core.js';

export async function saveUploadLogEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite');
    tx.objectStore(LOG_STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadUploadLog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(LOG_STORE, 'readonly');
    const req = tx.objectStore(LOG_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []).reverse()); // newest first
    req.onerror   = () => reject(req.error);
  });
}

export async function clearUploadLog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite');
    tx.objectStore(LOG_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}
