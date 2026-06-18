// Copyright (C) 2026 HidayahTech, LLC
// Durable storage for duplicate-scan results (IndexedDB bucketer_dedup_scans store).
//
// WHY THIS FILE EXISTS: scanning a large bucket (tens of thousands of objects) costs many
// HeadObject calls and real time. Persisting the result per (endpoint, bucket) lets the
// report restore instantly on reopen instead of forcing a full re-scan. One record per
// bucket — the latest scan replaces the previous one.
//
// Persistence is best-effort: when IndexedDB is unavailable (jsdom, private browsing, an
// upgrade error) the functions return null/false rather than throwing, so durability never
// breaks the feature itself.

import { openDB, DEDUP_STORE } from './indexeddb-core.js';

const available = () => typeof indexedDB !== 'undefined';

function scanKey(endpoint, bucket) {
  return `${endpoint || ''}|${bucket || ''}`;
}

// Persist a scan result: { endpoint, bucket, scope, prefix, scannedAt, objectCount, groups }.
// Returns true on success, false if IndexedDB was unavailable or the write failed.
export async function saveScanResult(record) {
  if (!available()) return false;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(DEDUP_STORE, 'readwrite');
      tx.objectStore(DEDUP_STORE).put(record, scanKey(record.endpoint, record.bucket));
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// Load the saved scan for (endpoint, bucket), or null if none / unavailable.
export async function loadScanResult(endpoint, bucket) {
  if (!available()) return null;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx  = db.transaction(DEDUP_STORE, 'readonly');
      const req = tx.objectStore(DEDUP_STORE).get(scanKey(endpoint, bucket));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Discard the saved scan for (endpoint, bucket). Best-effort.
export async function deleteScanResult(endpoint, bucket) {
  if (!available()) return false;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(DEDUP_STORE, 'readwrite');
      tx.objectStore(DEDUP_STORE).delete(scanKey(endpoint, bucket));
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  } catch {
    return false;
  }
}
