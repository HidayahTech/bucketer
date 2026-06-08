// Copyright (C) 2026 HidayahTech, LLC
// Upload item status predicate functions.
//
// WHY THIS FILE EXISTS: the set of "active" upload statuses was previously written
// inline as repeated string comparisons (e.g. `i.status === 'uploading' || i.status === 'resuming' || ...`)
// in 4+ places across UploadQueue.jsx. Any time a new status is added, each site
// must be found and updated. Centralizing the predicates here means there is one
// authoritative definition of what "active" means.
//
// WHAT BELONGS HERE: pure functions that classify an upload item's status.
//
// WHAT DOES NOT BELONG HERE: upload orchestration, state mutation, S3 operations,
// or any Preact-specific code.
//
// Valid statuses: queued | uploading | resuming | paused | done | error | aborted

export const isActive = (item) =>
  item.status === 'uploading' || item.status === 'resuming' || item.status === 'queued';

export const isFailed  = (item) => item.status === 'error';
export const isDone    = (item) => item.status === 'done';
export const isPaused  = (item) => item.status === 'paused';
export const isAborted = (item) => item.status === 'aborted';

// isSettled: the item is no longer going to change on its own.
// paused is considered settled (it waits for user action, not for the queue).
export const isSettled = (item) => !isActive(item);
