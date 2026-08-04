// MasterQueue — the unified operations panel (docs/intent/master-queue.md §5.3).
// Subscribes to the shared taskStore and renders one row per task: a generic
// shell (icon, summary, cancel/expand/dismiss controls, error detail list) that
// replaced the near-identical DeleteQueue/MoveQueue panels.
//
// Collapsed = calm: one line per task. Expanded = complete: per-key errors.
// Finished rows persist until dismissed (a delete result is evidence — it must
// not vanish on a timer); "Dismiss all finished" appears at ≥2 settled rows.
// Controls talk to the store directly — App only creates tasks and runs engines.
import { useState, useEffect, useRef } from 'preact/hooks';
import { leafName, formatBytes, formatSpeed, formatEta } from '../lib/format.js';
import { taskStore } from '../lib/task-store.js';
import { tierLabel, TIERS } from '../lib/browser-capability.js';
import { useRate } from '../hooks/useRate.js';

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
    if (t.status === 'running') {
      // Byte-accurate progress (bytesTotal) unlocks the enriched "N of M files" line;
      // without it (older job, or a zero-byte selection) fall back to the plain count-only
      // line this row has always shown — never divide by a zero/missing bytesTotal.
      if (t.bytesTotal) {
        const failedZipText = t.failed > 0 ? ` · ${t.failed} failed` : '';
        const totalZipText = total != null ? ` of ${total.toLocaleString()}` : '';
        return `Zipping · ${t.current.toLocaleString()}${totalZipText} files${failedZipText}`;
      }
      return `Zipping ${t.current}${ofText}…`;
    }
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

export function MasterQueue({ store = taskStore, readZipDetail }) {
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
      {tasks.map(t => <TaskRow key={t.id} task={t} store={store} readZipDetail={readZipDetail} />)}
    </div>
  );
}

function TaskRow({ task, store, readZipDetail }) {
  const isSettled = task.status !== 'running';
  const failed    = task.errors.filter(e => !e.skipped).length;
  const hasErrors = task.errors.length > 0;
  const isZip        = task.delivery === 'zip';
  const isRunningZip = isZip && task.status === 'running';

  // useRate no-ops (no interval) whenever its `active` arg is false, so it is cheap to
  // call unconditionally for every task row rather than conditionally per delivery kind
  // (conditional hooks would break across a task whose delivery/kind never actually
  // changes, but there is no reason to risk it for a call this cheap).
  const speed = useRate(isZip ? (task.bytesDone ?? 0) : 0, isRunningZip);

  const bytesDone  = task.bytesDone ?? 0;
  const bytesTotal = task.bytesTotal ?? 0;
  // The byte line + bar render only while actually streaming, and only once the job
  // knows its sendable bytes — never divide by a zero/missing bytesTotal.
  const showZipProgress = isRunningZip && !!task.bytesTotal;
  const barPct = showZipProgress ? Math.min(100, Math.max(0, (bytesDone / bytesTotal) * 100)) : 0;
  const eta = showZipProgress && speed > 0 ? (bytesTotal - bytesDone) / speed : null;

  // Zip tasks get the new active-focused detail (running, or settled with per-key
  // errors); every other task kind keeps the pre-existing settled+errors-only error list,
  // untouched.
  const canExpandZip     = isZip && (isRunningZip || (isSettled && hasErrors));
  const canExpandGeneric = !isZip && isSettled && hasErrors;
  const canExpand         = canExpandZip || canExpandGeneric;

  // A running zip's detail panel is opt-in, gated on local component state rather than
  // task.collapsed: task.collapsed defaults false, and reusing it here would auto-expand
  // (and auto-poll readZipDetail every second — an O(job-size) IndexedDB walk) for every
  // running zip the instant it appears, whether or not anyone is looking at it. Once the
  // job settles, expand reverts to the pre-existing task.collapsed-driven behavior
  // (auto-expanded by default when there are errors) — unchanged from before this task.
  const [runningDetailOpen, setRunningDetailOpen] = useState(false);
  const isOpen    = isRunningZip ? runningDetailOpen : !task.collapsed;
  const expanded  = canExpand && isOpen;
  const expandedZip     = expanded && isZip;
  const expandedGeneric = expanded && !isZip;
  const toggleOpen = () => {
    if (isRunningZip) setRunningDetailOpen(o => !o);
    else store.update(task.id, { collapsed: !task.collapsed }, true);
  };

  const [zipDetail, setZipDetail] = useState(null);
  // Read via a ref so an inline readZipDetail prop identity (App.jsx wraps loadZipDetail
  // in a fresh arrow function each render) never itself triggers a re-read — only
  // expandedZip/jobId/isRunningZip transitions do.
  const readZipDetailRef = useRef(readZipDetail);
  readZipDetailRef.current = readZipDetail;

  // Read the per-file detail once when the panel opens, then re-read on a ~1s throttle
  // while it stays open and the job is still running — never on every task.current tick
  // (a fast many-small-file job would otherwise re-read on every completion, and each
  // read walks the whole job — see loadZipDetail). One extra read fires the moment the
  // job leaves 'running' while the panel is still expanded (isRunningZip flips, so this
  // effect re-runs once more before settling into "no interval"), so a panel left open
  // across the settle transition shows the final state rather than one up to a second old.
  useEffect(() => {
    if (!expandedZip || !task.jobId) return undefined;
    let cancelled = false;
    const read = () => {
      const fn = readZipDetailRef.current;
      if (!fn) return;
      fn(task.jobId).then(d => { if (!cancelled) setZipDetail(d); });
    };
    read();
    if (!isRunningZip) return () => { cancelled = true; };
    const h = setInterval(read, 1000);
    return () => { cancelled = true; clearInterval(h); };
  }, [expandedZip, isRunningZip, task.jobId]);

  const doneList    = zipDetail?.done ?? [];
  const failedList  = zipDetail?.failed ?? [];
  const doneCount   = zipDetail?.doneCount ?? 0;
  const failedCount = zipDetail?.failedCount ?? 0;
  const queuedCount = Math.max(0, (task.total ?? 0) - doneCount - failedCount);
  const doneOverflow = doneCount - doneList.length;
  const activePct = task.active?.size ? Math.round((task.active.bytes / task.active.size) * 100) : 0;
  // failed items from readZipDetail carry only {key} — the failure reason lives on
  // task.errors ({key, message}), already on the task, no extra IndexedDB read.
  const errorMessageByKey = new Map(task.errors.map(e => [e.key, e.message]));

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
        {canExpand && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            data-testid="task-expand-toggle"
            onClick={toggleOpen}>
            {isOpen ? 'Hide' : 'Show details'}
          </button>
        )}
        {isSettled && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
            onClick={() => store.remove(task.id)}>
            Dismiss
          </button>
        )}
      </div>

      {showZipProgress && (
        <div class="queue-op-progress">
          <div class="progress-bar-wrap">
            <div class="progress-bar" data-testid="zip-progress-bar" style={{ width: `${barPct.toFixed(2)}%` }} />
          </div>
          <div class="queue-op-bytes">
            {formatBytes(bytesDone)} of {formatBytes(bytesTotal)}
            {speed > 0 && ` · ${formatSpeed(speed)} · ETA ${formatEta(eta)}`}
          </div>
        </div>
      )}

      {expandedZip && (
        <div class="queue-op-zip-detail" data-testid="zip-detail">
          {task.active && (
            <div class="queue-op-zip-row queue-op-zip-active">
              ▶ {task.active.key}  {formatBytes(task.active.bytes)} / {formatBytes(task.active.size)}  ({activePct}%)
            </div>
          )}
          {doneList.map(d => (
            <div key={d.key} class="queue-op-zip-row queue-op-zip-done">✓ {d.key}  {formatBytes(d.size)}</div>
          ))}
          {failedList.map(f => (
            <div key={f.key} class="queue-op-zip-row queue-op-zip-failed">
              ✗ {f.key} — {errorMessageByKey.get(f.key) || 'failed'}
            </div>
          ))}
          <div class="queue-op-zip-row queue-op-zip-footer">
            …and {queuedCount.toLocaleString()} queued{doneOverflow > 0 ? ` · ${doneOverflow.toLocaleString()} more done` : ''}
          </div>
        </div>
      )}

      {expandedGeneric && (
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
