// MovePickerModal — folder-tree destination picker for the move feature. The user drills
// into prefixes (ListObjectsV2 with Delimiter:'/') and clicks "Move here". This picker IS
// the deliberate confirmation step: navigating to a destination then clicking "Move here"
// is a two-step intentional action, so the move starts directly (no extra confirm dialog).
//
// validateMove (structural guard) disables "Move here" with an inline reason when the
// destination is invalid — moving a folder into itself/a descendant, or a no-op move.
import { useState, useEffect, useRef } from 'preact/hooks';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Modal } from './Modal.jsx';
import { Breadcrumb } from './Breadcrumb.jsx';
import { leafName } from '../lib/format.js';
import { validateMove, validateCopy } from '../lib/move-guards.js';

export function MovePickerModal({ client, bucket, selection, initialPrefix = '', onCancel, onMove, mode = 'move' }) {
  const [prefix, setPrefix]   = useState(initialPrefix);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const genRef = useRef(0);

  // List the subfolders of the current picker prefix. genRef guards against a slow
  // earlier fetch overwriting a newer one when the user drills quickly.
  useEffect(() => {
    const gen = ++genRef.current;
    setLoading(true); setError(null); setFolders([]);
    (async () => {
      try {
        const all = [];
        let token;
        do {
          const resp = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix || undefined, Delimiter: '/',
            MaxKeys: 1000, ContinuationToken: token,
          }));
          (resp.CommonPrefixes || []).forEach(cp => all.push(cp.Prefix));
          token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (token);
        if (gen !== genRef.current) return;
        setFolders(all);
      } catch (err) {
        if (gen !== genRef.current) return;
        setError(err.message || String(err));
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    })();
  }, [prefix, client, bucket]);

  const fileKeys = (selection.files || []).map(f => (typeof f === 'string' ? f : f.key));
  const isCopy   = mode === 'copy';
  const verb     = isCopy ? 'Copy' : 'Move';
  const reason   = isCopy
    ? validateCopy({ prefixes: selection.prefixes || [], dest: prefix })
    : validateMove({ files: fileKeys, prefixes: selection.prefixes || [], dest: prefix });
  const count    = (selection.files?.length || 0) + (selection.prefixes?.length || 0);

  return (
    <Modal onClose={onCancel} class="move-dialog">
      <div class="modal-title">{verb} {count} item{count !== 1 ? 's' : ''} to…</div>
      <Breadcrumb prefix={prefix} onNavigate={setPrefix} />
      <div class="move-picker-list">
        {loading && <div class="move-picker-loading"><span class="spinner" /> Loading…</div>}
        {error && <div class="move-picker-error">{error}</div>}
        {!loading && !error && folders.length === 0 && (
          <div class="move-picker-empty">No subfolders here.</div>
        )}
        {!loading && !error && folders.map(f => (
          <button key={f} type="button" class="move-picker-folder" onClick={() => setPrefix(f)}>
            <span class="file-icon">📁</span>{leafName(f.replace(/\/$/, ''))}/
          </button>
        ))}
      </div>
      <div class="modal-body">
        <p class="move-picker-dest">
          Destination: <code>{prefix || '/ (bucket root)'}</code>
        </p>
        {reason && <p class="modal-caveat move-picker-reason">{reason}</p>}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary btn-sm move-here"
          disabled={!!reason || loading}
          onClick={() => onMove(prefix)}
        >
          {verb} here
        </button>
      </div>
    </Modal>
  );
}
