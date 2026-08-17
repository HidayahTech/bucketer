// Incomplete-uploads cleanup panel. Scans the bucket for in-progress multipart uploads (via
// the injected `scan`), lists the ones Bucketer isn't already tracking as resumable, and lets
// the user Discard each — aborting it to reclaim storage. See
// docs/superpowers/specs/2026-08-16-incomplete-uploads-design.md.
//
// scan()          → Promise<[{ key, uploadId, initiated }]> (already filtered to orphans)
// discard(upload) → Promise<void> (aborts the multipart upload)
import { useState, useEffect } from 'preact/hooks';
import { Modal } from './Modal.jsx';

function age(initiated) {
  const then = new Date(initiated).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60); if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60); if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function IncompleteUploadsModal({ scan, discard, onClose }) {
  const [state, setState] = useState({ loading: true, uploads: [], error: null });
  const [busy, setBusy] = useState({}); // uploadId → true while its Discard is in flight

  useEffect(() => {
    let cancelled = false;
    scan().then(
      (uploads) => { if (!cancelled) setState({ loading: false, uploads, error: null }); },
      (err) => { if (!cancelled) setState({ loading: false, uploads: [], error: err.message || String(err) }); },
    );
    return () => { cancelled = true; };
  }, []);

  async function handleDiscard(u) {
    setBusy((b) => ({ ...b, [u.uploadId]: true }));
    try {
      await discard(u);
      setState((s) => ({ ...s, uploads: s.uploads.filter((x) => x.uploadId !== u.uploadId) }));
    } catch {
      // Leave the row so the user can retry; clear the busy flag below.
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[u.uploadId]; return n; });
    }
  }

  async function handleDiscardAll() {
    for (const u of [...state.uploads]) await handleDiscard(u);
  }

  return (
    <Modal onClose={onClose} class="incomplete-uploads-modal">
      <h2>Incomplete uploads</h2>
      <p class="muted">
        Unfinished multipart uploads that are still using storage. Some may have been started by
        other tools — discarding one that another tool is actively uploading will break that
        transfer. Uploads Bucketer can resume appear in the operations queue instead.
      </p>

      {state.loading && <p><span class="spinner" /> Scanning…</p>}
      {state.error && <p class="error-text" data-testid="incomplete-error">Could not scan: {state.error}</p>}
      {!state.loading && !state.error && state.uploads.length === 0 && (
        <p data-testid="no-incomplete">No incomplete uploads found.</p>
      )}

      {state.uploads.length > 0 && (
        <>
          <div class="incomplete-actions">
            <button type="button" class="btn btn-danger btn-sm" data-testid="discard-all" onClick={handleDiscardAll}>
              Discard all ({state.uploads.length})
            </button>
          </div>
          <ul class="incomplete-list">
            {state.uploads.map((u) => (
              <li key={u.uploadId} data-testid={`incomplete-row:${u.uploadId}`} class="incomplete-row">
                <span class="incomplete-key">{u.key}</span>
                {u.initiated && <span class="incomplete-age muted"> · started {age(u.initiated)}</span>}
                <button type="button" class="btn btn-ghost btn-sm" data-testid={`discard:${u.uploadId}`}
                  disabled={!!busy[u.uploadId]} onClick={() => handleDiscard(u)}>
                  {busy[u.uploadId] ? 'Discarding…' : 'Discard'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
