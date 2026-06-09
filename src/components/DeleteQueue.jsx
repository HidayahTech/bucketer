// DeleteQueue — unified in-progress and recently-completed delete operations panel.
// Lives in App.jsx alongside UploadQueue so delete ops survive folder navigation.
// Each op flows: confirm → discovering → deleting → done.
import { leafName } from '../lib/format.js';
import { Modal } from './Modal.jsx';

export function DeleteQueue({ ops, onConfirm, onDismiss, onCollapse, provider }) {
  if (ops.length === 0) return null;

  const confirmOp = ops.find(op => op.phase === 'confirm');
  const activeOps = ops.filter(op => op.phase !== 'confirm');

  const versioningCaveat = provider === 'b2'
    ? 'Backblaze B2 may retain older versions. The current version will be hidden but not immediately purged from storage.'
    : provider === 'wasabi'
    ? 'Wasabi has a 90-day minimum retention period. Objects deleted before 90 days are still billed for the remainder of that window.'
    : 'If versioning is enabled, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent.';

  return (
    <>
      {confirmOp && (
        <Modal onClose={() => onDismiss(confirmOp.id)}>
          <ConfirmContent
            op={confirmOp}
            onConfirm={() => onConfirm(confirmOp.id)}
            onCancel={() => onDismiss(confirmOp.id)}
            versioningCaveat={versioningCaveat}
          />
        </Modal>
      )}
      {activeOps.length > 0 && (
        <div class="delete-queue">
          {activeOps.map(op => (
            <DeleteOpEntry
              key={op.id}
              op={op}
              onDismiss={() => onDismiss(op.id)}
              onCollapse={() => onCollapse(op.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ConfirmContent({ op, onConfirm, onCancel, versioningCaveat }) {
  const fc = op.files.length;
  const pc = op.prefixes.length;

  const title = fc > 0 && pc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''} and ${pc} folder${pc !== 1 ? 's' : ''}?`
    : fc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''}?`
    : `Delete ${pc} folder${pc !== 1 ? 's' : ''}?`;

  return (
    <>
      <div class="modal-title">{title}</div>
      {fc === 1 && pc === 0 && (
        <div class="modal-filename" title={op.files[0]}>{leafName(op.files[0])}</div>
      )}
      <div class="modal-body">
        {pc > 0 && (
          <>
            <p class="modal-caveat">
              All objects inside {pc === 1 ? 'this folder' : 'these folders'} will be permanently deleted.
            </p>
            <div class="delete-confirm-prefixes">
              {op.prefixes.map(p => (
                <div key={p} class="modal-filename">{leafName(p.replace(/\/$/, ''))}/</div>
              ))}
            </div>
          </>
        )}
        <p class="modal-caveat">{versioningCaveat}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button class="btn btn-danger btn-sm" onClick={onConfirm}>Delete</button>
      </div>
    </>
  );
}

function DeleteOpEntry({ op, onDismiss, onCollapse }) {
  const isDone     = op.phase === 'done';
  const hasErrors  = op.errors.length > 0;
  const fc         = op.files.length;
  const pc         = op.prefixes.length;

  const subject = [
    fc > 0 && `${fc} file${fc !== 1 ? 's' : ''}`,
    pc > 0 && `${pc} folder${pc !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(' and ');

  const progressText = op.total != null ? ` · ${op.deleted} / ${op.total}` : '';
  const errorText    = hasErrors ? ` · ${op.errors.length} error${op.errors.length !== 1 ? 's' : ''}` : '';

  const summary = isDone
    ? `Deleted ${subject}${errorText}`
    : op.phase === 'discovering'
    ? `Listing folder contents…`
    : `Deleting ${subject}${progressText}${errorText}`;

  return (
    <div class={`delete-op${isDone && hasErrors && !op.collapsed ? ' delete-op-expanded' : ''}`}>
      <div class="delete-op-header">
        {!isDone && <span class="spinner" style={{ flexShrink: 0 }} />}
        {isDone && !hasErrors && <span class="delete-op-icon delete-op-ok">✓</span>}
        {isDone && hasErrors && <span class="delete-op-icon delete-op-err">✕</span>}
        <span class="delete-op-summary">{summary}</span>
        {isDone && hasErrors && (
          <button class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onCollapse}>
            {op.collapsed ? 'Show errors' : 'Hide'}
          </button>
        )}
        {isDone && (
          <button class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {isDone && hasErrors && !op.collapsed && (
        <div class="delete-op-errors">
          {op.errors.slice(0, 10).map((e, i) => (
            <div key={i} class="delete-op-error-row">
              <span class="delete-op-error-key" title={e.key}>{leafName(e.key) || e.key}</span>
              <span class="delete-op-error-msg">{e.message}</span>
            </div>
          ))}
          {op.errors.length > 10 && (
            <div class="delete-op-error-row delete-op-error-more">
              …and {op.errors.length - 10} more error{op.errors.length - 10 !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
