// Copyright (C) 2026 HidayahTech, LLC
// Activity (layout A, v1.67.0): uploads, moves, deletes and downloads behind one line with a
// badge, instead of a stack of cards above the file list that grew with every task and pushed
// the list down when work finished (REPORT W1: the table moved from y=326 to y=549 after one
// upload). Collapsed by default so finishing work never moves the list, and remembered open on
// this device for someone who likes to watch it; the panels inside stay mounted while it is
// closed, so nothing they hold is lost.
import { useState, useEffect } from 'preact/hooks';
import { taskStore } from '../lib/task-store.js';
import { loadActivityOpen, saveActivityOpen } from '../lib/storage.js';
import { leafName } from '../lib/format.js';
import { taskSummary } from './MasterQueue.jsx';
import { Icon } from './Icon.jsx';

const NO_UPLOADS = { running: 0, queued: 0, failed: 0, done: 0, current: null };

export function activityLine(uploads, tasks) {
  const running = tasks.filter((t) => t.status === 'running');
  const paused = tasks.filter((t) => t.status === 'paused');
  const settled = tasks.length - running.length - paused.length;
  const parts = [];
  if (uploads.current) {
    parts.push(`Uploading ${leafName(uploads.current.name)} · ${Math.round(uploads.current.progress || 0)} %`);
  } else if (running.length > 0) {
    parts.push(taskSummary(running[0]));
  }
  if (uploads.queued > 0) parts.push(`${uploads.queued} queued`);
  if (paused.length > 0) parts.push(`${paused.length} paused`);
  if (uploads.failed > 0) parts.push(`${uploads.failed} failed`);
  const finished = uploads.done + settled;
  if (parts.length === 0) return finished > 0 ? `All done · ${finished} finished` : 'Nothing running';
  if (finished > 0) parts.push(`${finished} done`);
  return parts.join(' · ');
}

export function ActivityPanel({ uploads = NO_UPLOADS, store = taskStore, children }) {
  const [tasks, setTasks] = useState(store.get());
  useEffect(() => store.subscribe(setTasks), [store]);
  // Closed unless the user left it open on this device.
  const [open, setOpen] = useState(loadActivityOpen);
  function onToggle(e) {
    setOpen(e.currentTarget.open);
    saveActivityOpen(e.currentTarget.open);
  }

  const active = uploads.running + tasks.filter((t) => t.status === 'running').length;
  const attention = uploads.failed + tasks.filter((t) => t.status === 'paused').length;

  return (
    <details class="activity" open={open} onToggle={onToggle}>
      <summary class="activity-summary">
        <span class="activity-title">Activity</span>
        {active > 0 && <span class="activity-badge">{active} running</span>}
        {attention > 0 && <span class="activity-badge activity-badge-attention">{attention} need attention</span>}
        <span class="activity-line">{activityLine(uploads, tasks)}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} class="activity-chevron" />
      </summary>
      <div class="activity-body">{children}</div>
    </details>
  );
}
