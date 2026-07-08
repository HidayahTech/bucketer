// DeleteConfirmModal — pre-queue confirmation for delete requests. Confirmation
// happens BEFORE a task enters the master queue (docs/intent/master-queue.md
// §5.1): a task in the queue is always already authorized. Extracted from
// DeleteQueue when delete/move ops moved onto the unified MasterQueue panel.
import { leafName } from '../lib/format.js';
import { Modal } from './Modal.jsx';

export function DeleteConfirmModal({ request, provider, onConfirm, onCancel }) {
  const fc = request.files.length;
  const pc = request.prefixes.length;

  const versioningCaveat = provider === 'b2'
    ? 'Backblaze B2 may retain older versions. The current version will be hidden but not immediately purged from storage.'
    : provider === 'wasabi'
    ? 'Wasabi has a 90-day minimum retention period. Objects deleted before 90 days are still billed for the remainder of that window.'
    : 'If versioning is enabled, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent.';

  const title = fc > 0 && pc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''} and ${pc} folder${pc !== 1 ? 's' : ''}?`
    : fc > 0
    ? `Delete ${fc} file${fc !== 1 ? 's' : ''}?`
    : `Delete ${pc} folder${pc !== 1 ? 's' : ''}?`;

  return (
    <Modal onClose={onCancel}>
      <div class="modal-title">{title}</div>
      {fc === 1 && pc === 0 && (
        <div class="modal-filename" title={request.files[0]}>{leafName(request.files[0])}</div>
      )}
      <div class="modal-body">
        {pc > 0 && (
          <>
            <p class="modal-caveat">
              All objects inside {pc === 1 ? 'this folder' : 'these folders'} will be permanently deleted.
            </p>
            <div class="delete-confirm-prefixes">
              {request.prefixes.map(p => (
                <div key={p} class="modal-filename">{leafName(p.replace(/\/$/, ''))}/</div>
              ))}
            </div>
          </>
        )}
        <p class="modal-caveat">{versioningCaveat}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button class="btn btn-danger btn-sm" data-testid="delete-confirm" onClick={onConfirm}>Delete</button>
      </div>
    </Modal>
  );
}
