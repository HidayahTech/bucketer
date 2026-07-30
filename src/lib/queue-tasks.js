// Copyright (C) 2026 HidayahTech, LLC
// Task factories and progress adapters bridging the delete/move engines
// (delete-queue.js, move-queue.js) to the master task store
// (docs/intent/master-queue.md §5.1). The engines keep their own progress
// vocabulary (deleted/moved counters, phase names); these pure functions
// translate engine updates into task patches so the engines stay untouched
// and independently testable.
import { leafName } from './format.js';

export function subjectLabel(fileCount, prefixCount) {
  return [
    fileCount > 0 && `${fileCount} file${fileCount !== 1 ? 's' : ''}`,
    prefixCount > 0 && `${prefixCount} folder${prefixCount !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(' and ');
}

export function createDeleteTask({ files, prefixes, capturedPrefix, bucket }) {
  return {
    kind: 'delete',
    status: 'running',
    subPhase: null,
    subject: subjectLabel(files.length, prefixes.length),
    files, prefixes, capturedPrefix, bucket,
    current: 0, total: null,
    errors: [],
    collapsed: false,
    cancelRequested: false,
  };
}

export function createTransferTask({ files, prefixes, dest, capturedPrefix, bucket, mode, renameTo }) {
  if (mode === 'rename') {
    const oldLeaf = leafName(prefixes[0].slice(0, -1));
    return {
      kind: 'rename',
      status: 'running',
      subPhase: 'checking',
      subject: `${oldLeaf} → ${renameTo}`,
      files: [], prefixes, dest: capturedPrefix, renameTo, capturedPrefix, bucket,
      current: 0, total: null,
      errors: [],
      collapsed: false,
      cancelRequested: false,
    };
  }
  return {
    kind: mode === 'copy' ? 'copy' : 'move',
    status: 'running',
    subPhase: 'checking',
    subject: subjectLabel(files.length, prefixes.length),
    files, prefixes, dest, capturedPrefix, bucket,
    current: 0, total: null,
    errors: [],
    collapsed: false,
    cancelRequested: false,
  };
}

// A browser-managed download. `tier` is what keeps this row honest: the app hands files
// to the browser's download manager and can observe only that it did so, so the row must
// render differently from tasks whose progress the app actually knows.
export function createDownloadTask({ fileCount, bucket, capturedPrefix }) {
  return {
    kind: 'download',
    tier: 'browser-managed',
    status: 'running',
    subPhase: 'enumerating',
    subject: subjectLabel(fileCount, 0),
    files: [], prefixes: [], capturedPrefix, bucket,
    current: 0, total: fileCount || null,
    errors: [],
    collapsed: false,
    cancelRequested: false,
  };
}

// Engine progress update → task-store patch. countField is 'deleted' (delete
// engine) or 'moved' (move/copy engine). `cancelled: true` on a done update
// marks a run that stopped early because cancellation was requested.
export function engineUpdateToPatch(update, countField) {
  const patch = {};
  if (update.phase === 'done') {
    patch.status = update.cancelled ? 'cancelled' : 'done';
    patch.subPhase = null;
  } else if (update.phase) {
    patch.subPhase = update.phase;
  }
  if (update.total !== undefined) patch.total = update.total;
  if (update[countField] !== undefined) patch.current = update[countField];
  if (update.errors !== undefined) patch.errors = update.errors;
  return patch;
}
