// Durable state for resumable move jobs. One record per job (keyPath 'id'), with the
// resolved work list held inline. See docs/superpowers/specs/2026-08-16-move-resume-design.md.
//
// WHAT BELONGS HERE: CRUD for the bucketer_move_jobs store. Nothing else touches it directly.
//
// CRITICAL INVARIANT: the job record — carrying inflight.uploadId — must be persisted BEFORE
// any UploadPartCopy, so a crash on the first part still leaves the multipart session
// reachable for resume (mirrors resume-records.js).

import { openDB, MOVE_JOB_STORE } from './indexeddb-core.js';

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error('transaction aborted'));
  });
}
function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function saveMoveJob(job) {
  const db = await openDB();
  const tx = db.transaction(MOVE_JOB_STORE, 'readwrite');
  tx.objectStore(MOVE_JOB_STORE).put(job);
  return txDone(tx);
}

export async function loadMoveJob(id) {
  const db = await openDB();
  const tx = db.transaction(MOVE_JOB_STORE, 'readonly');
  return (await reqResult(tx.objectStore(MOVE_JOB_STORE).get(id))) ?? null;
}

export async function loadAllMoveJobs() {
  try {
    const db = await openDB();
    const tx = db.transaction(MOVE_JOB_STORE, 'readonly');
    return (await reqResult(tx.objectStore(MOVE_JOB_STORE).getAll())) ?? [];
  } catch { return []; }
}

// Read-merge-write one row so a partial update never clobbers fields written elsewhere.
export async function updateMoveJob(id, patch) {
  const db = await openDB();
  const tx = db.transaction(MOVE_JOB_STORE, 'readwrite');
  const store = tx.objectStore(MOVE_JOB_STORE);
  const existing = await reqResult(store.get(id));
  if (existing) store.put({ ...existing, ...patch });
  return txDone(tx);
}

export async function deleteMoveJob(id) {
  const db = await openDB();
  const tx = db.transaction(MOVE_JOB_STORE, 'readwrite');
  tx.objectStore(MOVE_JOB_STORE).delete(id);
  return txDone(tx);
}

export async function clearAllMoveJobs() {
  const db = await openDB();
  const tx = db.transaction(MOVE_JOB_STORE, 'readwrite');
  tx.objectStore(MOVE_JOB_STORE).clear();
  return txDone(tx);
}
