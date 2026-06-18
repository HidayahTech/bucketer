// Copyright (C) 2026 HidayahTech, LLC
// Shared IndexedDB database initializer.
//
// WHY THIS FILE EXISTS: the openDB() function and schema constants are needed by
// every IndexedDB module (resume-records, file-identity, active-uploads, upload-log).
// Centralizing here prevents each module from duplicating the upgrade logic and
// ensures the schema version is bumped in exactly one place.
//
// WHAT BELONGS HERE: DB_NAME, DB_VERSION, store names, and the openDB() factory.
//
// WHAT DOES NOT BELONG HERE: business logic, domain functions, or anything that
// reads/writes a specific object store. Those belong in the domain modules.

export const DB_NAME    = 's3browser';
export const DB_VERSION = 3;

export const STORE       = 's3browser_uploads';
export const LOG_STORE   = 'bucketer_upload_log';
export const DEDUP_STORE = 'bucketer_dedup_scans';

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))       db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(LOG_STORE))   db.createObjectStore(LOG_STORE, { autoIncrement: true });
      if (!db.objectStoreNames.contains(DEDUP_STORE)) db.createObjectStore(DEDUP_STORE);
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

// Closes and clears the cached connection. Required before deleteDatabase().
export function closeDB() {
  if (_db) { _db.close(); _db = null; }
}
