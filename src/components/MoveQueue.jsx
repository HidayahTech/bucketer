// MoveQueue — in-progress and recently-completed move operations panel. Lives in App.jsx
// alongside DeleteQueue/UploadQueue so move ops survive folder navigation. The destination
// picker (MovePickerModal) is the confirmation step, so this panel has no confirm dialog:
// each op flows discovering → checking → moving → done.
//
// Collisions are objects deliberately skipped (never overwritten); they are surfaced as
// "skipped" and do NOT mark the operation as failed. Only genuine copy/delete failures do.
import { leafName } from '../lib/format.js';

export function MoveQueue({ ops, onDismiss, onCollapse }) {
  if (ops.length === 0) return null;
  return (
    <div class="move-queue">
      {ops.map(op => (
        <MoveOpEntry key={op.id} op={op} onDismiss={() => onDismiss(op.id)} onCollapse={() => onCollapse(op.id)} />
      ))}
    </div>
  );
}

function MoveOpEntry({ op, onDismiss, onCollapse }) {
  const isDone  = op.phase === 'done';
  const skipped = op.errors.filter(e => e.skipped).length;
  const failed  = op.errors.length - skipped;
  const fc = op.files.length;
  const pc = op.prefixes.length;

  const subject = [
    fc > 0 && `${fc} file${fc !== 1 ? 's' : ''}`,
    pc > 0 && `${pc} folder${pc !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(' and ');

  const isCopy = op.mode === 'copy';
  const doneVerb = isCopy ? 'Copied' : 'Moved';
  const activeVerb = isCopy ? 'Copying' : 'Moving';

  const progressText = op.total != null ? ` · ${op.moved} / ${op.total}` : '';
  const skippedText  = skipped > 0 ? ` · ${skipped} skipped` : '';
  const failedText   = failed > 0 ? ` · ${failed} error${failed !== 1 ? 's' : ''}` : '';

  const summary = isDone
    ? `${doneVerb} ${subject}${skippedText}${failedText}`
    : op.phase === 'discovering'
    ? 'Listing folder contents…'
    : op.phase === 'checking'
    ? 'Checking destination…'
    : `${activeVerb} ${subject}${progressText}${skippedText}${failedText}`;

  const hasErrors = op.errors.length > 0; // skips count as "errors" for the expandable detail list

  return (
    <div class={`move-op${isDone && hasErrors && !op.collapsed ? ' move-op-expanded' : ''}`}>
      <div class="move-op-header">
        {!isDone && <span class="spinner" style={{ flexShrink: 0 }} />}
        {isDone && failed === 0 && <span class="move-op-icon move-op-ok">✓</span>}
        {isDone && failed > 0 && <span class="move-op-icon move-op-err">✕</span>}
        <span class="move-op-summary">{summary}</span>
        {isDone && hasErrors && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onCollapse}>
            {op.collapsed ? 'Show details' : 'Hide'}
          </button>
        )}
        {isDone && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {isDone && hasErrors && !op.collapsed && (
        <div class="move-op-errors">
          {op.errors.slice(0, 10).map((e, i) => (
            <div key={i} class="move-op-error-row">
              <span class="move-op-error-key" title={e.key}>{leafName(e.key) || e.key}</span>
              <span class={e.skipped ? 'move-op-error-skip' : 'move-op-error-msg'}>{e.message}</span>
            </div>
          ))}
          {op.errors.length > 10 && (
            <div class="move-op-error-row move-op-error-more">
              …and {op.errors.length - 10} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
