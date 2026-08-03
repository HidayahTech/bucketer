// MasterQueue — the unified operations panel (docs/intent/master-queue.md §5.3).
// Subscribes to the shared taskStore and renders one row per task: a generic
// shell (icon, summary, cancel/expand/dismiss controls, error detail list) that
// replaced the near-identical DeleteQueue/MoveQueue panels.
//
// Collapsed = calm: one line per task. Expanded = complete: per-key errors.
// Finished rows persist until dismissed (a delete result is evidence — it must
// not vanish on a timer); "Dismiss all finished" appears at ≥2 settled rows.
// Controls talk to the store directly — App only creates tasks and runs engines.
import { useState, useEffect } from 'preact/hooks';
import { leafName } from '../lib/format.js';
import { taskStore } from '../lib/task-store.js';
import { tierLabel, TIERS } from '../lib/browser-capability.js';

const VERBS = {
  delete: { active: 'Deleting', done: 'Deleted' },
  move:   { active: 'Moving',   done: 'Moved' },
  copy:   { active: 'Copying',  done: 'Copied' },
  rename: { active: 'Renaming', done: 'Renamed' },
};

// Downloads are deliberately not routed through VERBS. The app hands a file to the
// browser's download manager and cannot see bytes, completion, or failure after that, so
// every phrase here is limited to what it genuinely knows: how many it sent. Saying
// "Downloaded" would be the exact lie docs/intent/master-queue.md warned about.
function downloadSummary(t) {
  const total = t.total != null ? t.total : null;
  const ofText = total != null ? ` of ${total}` : '';
  const errText = t.errors.length > 0 ? ` · ${t.errors.length} failed` : '';

  // ZIP delivery bundles everything into one file, so its states cannot borrow the
  // handoff copy below: nothing is "sent to your browser" until the single export
  // download actually fires (t.exported) — not while running, not on cancel, and not on
  // a finished-but-unexported zip (export failed or the save dialog was cancelled,
  // which is recoverable via "save it again", not a lost job).
  if (t.delivery === 'zip') {
    if (t.status === 'running')   return `Zipping ${t.current}${ofText}…`;
    if (t.status === 'cancelled') return `Stopped while zipping — ${t.current}${ofText}`;
    if (t.status === 'done' && t.exported) return 'ZIP handed to your browser';
    if (t.status === 'done' && t.finished) return 'ZIP ready — save it again';
    if (t.status === 'done') return `Paused — ${t.current}${ofText} zipped, ${t.failed ?? 0} failed`;
  }

  if (t.status === 'cancelled') return `Stopped — sent ${t.current}${ofText} to your browser${errText}`;
  if (t.status === 'done') return `Sent ${t.current}${ofText} to your browser — check your downloads${errText}`;
  if (t.subPhase === 'enumerating') return 'Listing files to download…';
  return `Sending to your browser — ${t.current}${ofText}${errText}`;
}

function taskSummary(t) {
  if (t.kind === 'download') return downloadSummary(t);
  const verbs = VERBS[t.kind];
  const skipped = t.errors.filter(e => e.skipped).length;
  const failed  = t.errors.length - skipped;
  const progressText = t.total != null ? ` · ${t.current} / ${t.total}` : '';
  const skippedText  = skipped > 0 ? ` · ${skipped} skipped` : '';
  const failedText   = failed > 0 ? ` · ${failed} error${failed !== 1 ? 's' : ''}` : '';

  if (t.status === 'cancelled') {
    const ofText = t.total != null ? ` of ${t.total}` : '';
    return `Cancelled — ${verbs.done.toLowerCase()} ${t.current}${ofText}${skippedText}${failedText}`;
  }
  if (t.status === 'done') return `${verbs.done} ${t.subject}${skippedText}${failedText}`;
  if (t.subPhase === 'discovering') return 'Listing folder contents…';
  if (t.subPhase === 'checking') return 'Checking destination…';
  return `${verbs.active} ${t.subject}${progressText}${skippedText}${failedText}`;
}

export function MasterQueue({ store = taskStore }) {
  const [tasks, setTasks] = useState(store.get());
  useEffect(() => store.subscribe(setTasks), [store]);
  if (tasks.length === 0) return null;

  const settled = tasks.filter(t => t.status !== 'running');
  return (
    <div class="queue-panel" data-testid="master-queue">
      {settled.length >= 2 && (
        <div class="queue-panel-actions">
          <button type="button" class="btn btn-ghost btn-sm"
            onClick={() => settled.forEach(t => store.remove(t.id))}>
            Dismiss all finished
          </button>
        </div>
      )}
      {tasks.map(t => <TaskRow key={t.id} task={t} store={store} />)}
    </div>
  );
}

function TaskRow({ task, store }) {
  const isSettled = task.status !== 'running';
  const failed    = task.errors.filter(e => !e.skipped).length;
  const hasErrors = task.errors.length > 0;
  const expanded  = isSettled && hasErrors && !task.collapsed;

  return (
    <div class={`queue-op${expanded ? ' queue-op-expanded' : ''}`}>
      <div class="queue-op-header">
        {!isSettled && <span class="spinner" style={{ flexShrink: 0 }} />}
        {task.status === 'done' && failed === 0 && <span class="queue-op-icon queue-op-ok">✓</span>}
        {task.status === 'done' && failed > 0 && <span class="queue-op-icon queue-op-err">✕</span>}
        {task.status === 'cancelled' && <span class="queue-op-icon queue-op-cancelled">⊘</span>}
        <span class="queue-op-summary">{taskSummary(task)}</span>
        {task.tier && (
          <span
            class="queue-op-badge"
            data-testid="task-badge"
            title={task.tier === TIERS.HANDOFF
              ? 'Your browser is doing the transfer. Bucketer can see which files it handed over, but not their progress.'
              : 'Bucketer is performing this transfer and can report its real progress.'}
          >
            {tierLabel(task.tier)}
          </span>
        )}
        {!isSettled && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            data-testid="task-cancel" disabled={task.cancelRequested}
            onClick={() => store.requestCancel(task.id)}>
            {task.cancelRequested ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {isSettled && hasErrors && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            onClick={() => store.update(task.id, { collapsed: !task.collapsed }, true)}>
            {task.collapsed ? 'Show details' : 'Hide'}
          </button>
        )}
        {isSettled && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            onClick={() => store.remove(task.id)}>
            Dismiss
          </button>
        )}
      </div>
      {expanded && (
        <div class="queue-op-errors">
          {task.errors.slice(0, 10).map((e, i) => (
            <div key={i} class="queue-op-error-row">
              <span class="queue-op-error-key" title={e.key}>{leafName(e.key) || e.key}</span>
              <span class={e.skipped ? 'queue-op-error-skip' : 'queue-op-error-msg'}>{e.message}</span>
            </div>
          ))}
          {task.errors.length > 10 && (
            <div class="queue-op-error-row queue-op-error-more">
              …and {task.errors.length - 10} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
