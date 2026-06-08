// Copyright (C) 2026 HidayahTech, LLC
// Cross-tab active upload tracking (§4.15).
//
// WHY THIS FILE EXISTS: concurrent tab conflict detection is a distinct concern from
// resume record persistence and file identity — it uses localStorage (not IndexedDB)
// and a tab-unique ID. Separating it prevents this localStorage-specific pattern from
// obscuring the IndexedDB schema in resume-records.js.
//
// WHAT BELONGS HERE: functions that register and query in-flight uploads via localStorage
// so that two tabs uploading to the same destination key warn each other.
//
// WHAT DOES NOT BELONG HERE: resume record CRUD (resume-records.js), file hashing
// (file-identity.js), or upload history (upload-log.js).
//
// Best-effort: private mode silently disables detection rather than crashing.

const TAB_ID    = Math.random().toString(36).slice(2);
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

export function loadActiveUploads() {
  return getActiveUploads();
}

export function clearActiveUploads() {
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* */ }
}
