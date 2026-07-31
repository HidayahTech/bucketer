// Copyright (C) 2026 HidayahTech, LLC
// Durable state for download jobs and their per-object items.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// WHAT BELONGS HERE: CRUD for the bucketer_download_jobs and bucketer_download_items
// stores. Nothing else touches those stores directly.
//
// WHAT DOES NOT BELONG HERE: enumeration (download-manifest.js), naming
// (download-naming.js), or the transfer engine (download-queue.js).
//
// CRITICAL INVARIANT: appendManifestPage() writes a page of items AND the continuation
// token that follows it in ONE transaction. If those could diverge, a crash mid-enumeration
// would either lose objects or re-list ones already recorded, and enumeration would stop
// being resumable — which is the reason this module exists at all.

import { openDB, DL_JOB_STORE, DL_ITEM_STORE } from './indexeddb-core.js';

export const ITEM_STATUS = {
  PENDING:  'pending',
  ISSUED:   'issued',
  DONE:     'done',
  FAILED:   'failed',
  SKIPPED:  'skipped',
};

export const JOB_STATUS = {
  ENUMERATING: 'enumerating',
  RUNNING:     'running',
  PAUSED:      'paused',
  DONE:        'done',
  CANCELLED:   'cancelled',
};

const itemId = (jobId, key) => `${jobId}:${key}`;

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

export async function saveJob(job) {
  const db = await openDB();
  const tx = db.transaction(DL_JOB_STORE, 'readwrite');
  tx.objectStore(DL_JOB_STORE).put(job);
  return txDone(tx);
}

export async function loadJob(id) {
  const db = await openDB();
  const tx = db.transaction(DL_JOB_STORE, 'readonly');
  return (await reqResult(tx.objectStore(DL_JOB_STORE).get(id))) ?? null;
}

export async function loadAllJobs() {
  const db = await openDB();
  const tx = db.transaction(DL_JOB_STORE, 'readonly');
  return (await reqResult(tx.objectStore(DL_JOB_STORE).getAll())) ?? [];
}

// Removes the job and every item belonging to it. Items are deleted through the by_job
// index with a cursor, so a million-item job does not materialise as an array first.
export async function deleteJob(id) {
  const db = await openDB();
  const tx = db.transaction([DL_JOB_STORE, DL_ITEM_STORE], 'readwrite');
  tx.objectStore(DL_JOB_STORE).delete(id);

  const cursorReq = tx.objectStore(DL_ITEM_STORE).index('by_job').openCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  return txDone(tx);
}

// Write one page of manifest items and advance the job's enumeration state atomically.
// `enumeration` may carry { continuationToken, done }. Counters accumulate here so the
// job row always agrees with the items actually committed.
export async function appendManifestPage(jobId, items, enumeration = {}) {
  const db = await openDB();
  const tx = db.transaction([DL_JOB_STORE, DL_ITEM_STORE], 'readwrite');
  const jobs = tx.objectStore(DL_JOB_STORE);
  const store = tx.objectStore(DL_ITEM_STORE);

  // Any failure must abort explicitly. Throwing out of this function without aborting
  // lets IndexedDB auto-commit whatever was already put — which committed a partial page
  // in practice, not just in theory.
  try {
    const job = await reqResult(jobs.get(jobId));
    if (!job) throw new Error(`unknown download job: ${jobId}`);

    let added = 0;
    let bytes = 0;
    for (const it of items) {
      const id = itemId(jobId, it.key);
      // Re-appending a page must not double-count, so only unseen ids move the counters.
      const existing = await reqResult(store.get(id));
      if (!existing) { added += 1; bytes += it.size || 0; }
      store.put({ ...it, id, jobId });
    }

    job.counters = {
      ...job.counters,
      total:      (job.counters?.total ?? 0) + added,
      bytesTotal: (job.counters?.bytesTotal ?? 0) + bytes,
    };
    job.enumeration = { ...job.enumeration, ...enumeration };
    jobs.put(job);
  } catch (err) {
    try { tx.abort(); } catch { /* already aborting */ }
    throw err;
  }

  return txDone(tx);
}

export async function updateItem(jobId, key, patch) {
  const db = await openDB();
  const tx = db.transaction(DL_ITEM_STORE, 'readwrite');
  const store = tx.objectStore(DL_ITEM_STORE);
  const id = itemId(jobId, key);
  const existing = await reqResult(store.get(id));
  if (existing) store.put({ ...existing, ...patch });
  return txDone(tx);
}

// Return failed items to the queue so a resume actually retries them. They are left in
// FAILED while a run is in progress so it can report them, but a resume only picks up
// PENDING — without this they would be skipped forever.
export async function resetFailedToPending(jobId) {
  const db = await openDB();
  const tx = db.transaction(DL_ITEM_STORE, 'readwrite');
  const idx = tx.objectStore(DL_ITEM_STORE).index('by_job_status');
  const req = idx.openCursor(IDBKeyRange.only([jobId, ITEM_STATUS.FAILED]));
  let reset = 0;

  await new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const { error, ...rest } = cursor.value;   // drop the stale failure reason
      cursor.update({ ...rest, status: ITEM_STATUS.PENDING });
      reset += 1;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);
  return reset;
}

export async function countItemsByStatus(jobId, status) {
  const db = await openDB();
  const tx = db.transaction(DL_ITEM_STORE, 'readonly');
  const idx = tx.objectStore(DL_ITEM_STORE).index('by_job_status');
  return (await reqResult(idx.count(IDBKeyRange.only([jobId, status])))) ?? 0;
}

// Walk items of a given status with a cursor. Return false from `fn` to stop early.
// Deliberately not a getAll(): a job can hold a million items and the UI must never
// materialise them (see BUG-021 — Firefox froze diffing a 15,000-row list).
// Take up to `limit` items of a given status. The engine works in bounded batches rather
// than pulling a whole job into memory; it re-queries after each batch, which also means
// items whose status changed underneath it are picked up naturally.
export async function takeItemsByStatus(jobId, status, limit) {
  const out = [];
  await eachItemByStatus(jobId, status, (it) => {
    out.push(it);
    return out.length < limit;
  });
  return out;
}

export async function eachItemByStatus(jobId, status, fn) {
  const db = await openDB();
  const tx = db.transaction(DL_ITEM_STORE, 'readonly');
  const idx = tx.objectStore(DL_ITEM_STORE).index('by_job_status');
  const req = idx.openCursor(IDBKeyRange.only([jobId, status]));

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if (fn(cursor.value) === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
