// Copyright (C) 2026 HidayahTech, LLC
// Barrel re-export for backwards compatibility.
//
// WHY THIS FILE EXISTS: UploadQueue.jsx and other components import from 'indexeddb.js'.
// Rather than updating every import site at once, this barrel re-exports everything from
// the focused domain modules so existing code continues to work. When a component is
// refactored, it should update its import to the specific module (e.g. resume-records.js)
// so that the dependency graph becomes explicit.
//
// DO NOT add new logic here. New functions go in the appropriate domain module:
//   resume-records.js — multipart resume record CRUD
//   file-identity.js  — file hashing and identity matching
//   active-uploads.js — cross-tab active upload tracking
//   upload-log.js     — upload history log
//   indexeddb-core.js — shared DB init (openDB, store names)

export {
  saveResumeRecord,
  loadResumeRecord,
  deleteResumeRecord,
  loadAllResumeRecords,
  clearAllResumeRecords,
} from './resume-records.js';

export {
  uploadExpiryWarningMs,
  computeFileHash,
  buildFileIdentity,
  fileIdentityMatches,
  buildFileIdentityWithHash,
} from './file-identity.js';

export {
  markUploadActive,
  markUploadInactive,
  isUploadActiveElsewhere,
  loadActiveUploads,
  clearActiveUploads,
} from './active-uploads.js';

export {
  saveUploadLogEntry,
  loadUploadLog,
  clearUploadLog,
} from './upload-log.js';

// deleteDatabase closes the cached connection first — must be imported from core.
import { closeDB } from './indexeddb-core.js';
import { DB_NAME }  from './indexeddb-core.js';

export async function deleteDatabase() {
  closeDB();
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror   = resolve;
    req.onblocked = resolve;
  });
}
