// DeleteConfirmModal — pre-queue confirmation for delete requests. Confirmation
// happens BEFORE a task enters the master queue (docs/intent/master-queue.md
// §5.1): a task in the queue is always already authorized. Extracted from
// DeleteQueue when delete/move ops moved onto the unified MasterQueue panel.
//
// Layout A (v1.68.0): the dialog names what is about to go — the bucket (and its storage
// address), the folder the selection was made in, and the count, on the button too — so a
// delete in the wrong bucket or folder is caught before it is confirmed.
import { leafName } from '../lib/format.js';
import { endpointHost } from '../lib/saved-bucket-labels.js';
import { Modal } from './Modal.jsx';

const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;

export function DeleteConfirmModal({ request, provider, bucket, endpoint, onConfirm, onCancel }) {
  const fc = request.files.length;
  const pc = request.prefixes.length;

  const versioningCaveat =
    provider === 'b2'
      ? 'Backblaze B2 may retain older versions. The current version will be hidden but not immediately purged from storage.'
      : provider === 'wasabi'
        ? 'Wasabi has a 90-day minimum retention period. Objects deleted before 90 days are still billed for the remainder of that window.'
        : 'If versioning is enabled, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent.';

  const counts = [fc > 0 && plural(fc, 'file'), pc > 0 && plural(pc, 'folder')].filter(Boolean).join(' and ');
  const what = fc === 0 && pc === 1 ? `folder “${leafName(request.prefixes[0].replace(/\/$/, ''))}”` : counts;
  const title = `Delete ${what}${bucket ? ` from ${bucket}` : ''}?`;
  const host = endpoint ? endpointHost(endpoint) : '';
  const folder = request.capturedPrefix || '';

  return (
    <Modal onClose={onCancel}>
      <div class="modal-title">{title}</div>
      {bucket && (
        <dl class="delete-scope">
          <dt>Bucket</dt>
          <dd>
            <strong>{bucket}</strong>
            {host && <span class="delete-scope-host"> on {host}</span>}
          </dd>
          {/* "In", not "Folder": a folder delete's title already names a folder (ux-review 4b L2). */}
          <dt>In</dt>
          <dd>{folder ? <code>{folder}</code> : 'Top of the bucket'}</dd>
        </dl>
      )}
      {fc === 1 && pc === 0 && (
        <div class="modal-filename" title={request.files[0]}>
          {leafName(request.files[0])}
        </div>
      )}
      <div class="modal-body">
        {pc > 0 && (
          <>
            <p class="modal-caveat">
              All objects inside {pc === 1 ? 'this folder' : 'these folders'} will be permanently deleted.
            </p>
            <div class="delete-confirm-prefixes">
              {request.prefixes.map((p) => (
                <div key={p} class="modal-filename">
                  {leafName(p.replace(/\/$/, ''))}/
                </div>
              ))}
            </div>
          </>
        )}
        <p class="modal-caveat">{versioningCaveat}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button class="btn btn-danger btn-sm" data-testid="delete-confirm" onClick={onConfirm}>
          Delete {counts}
        </button>
      </div>
    </Modal>
  );
}
