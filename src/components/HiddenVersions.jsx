// Hidden versions panel: lists and deletes old versions and delete markers
import { useState } from 'preact/hooks';
import { ListObjectVersionsCommand, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { formatBytes } from '../lib/format.js';
import { ErrorBlock } from './ErrorBlock.jsx';

function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(); } catch { return ''; }
}

function shortVersionId(id) {
  if (!id) return '—';
  return id.length > 18 ? id.slice(0, 18) + '…' : id;
}

function collectHidden(resp) {
  const hidden = [];
  for (const v of (resp.Versions || [])) {
    if (!v.IsLatest) hidden.push({ key: v.Key, versionId: v.VersionId, type: 'old-version', size: v.Size, date: v.LastModified });
  }
  for (const dm of (resp.DeleteMarkers || [])) {
    hidden.push({ key: dm.Key, versionId: dm.VersionId, type: 'delete-marker', isLatest: dm.IsLatest, size: null, date: dm.LastModified });
  }
  return hidden;
}

export function HiddenVersions({ client, bucket, prefix }) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [nextKeyMarker, setNextKeyMarker] = useState(null);
  const [nextVersionIdMarker, setNextVersionIdMarker] = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null); // row object | 'all'
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  async function fetchPage(keyMarker, versionIdMarker, replace) {
    setLoading(true);
    setError(null);
    try {
      const resp = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix || undefined,
        KeyMarker: keyMarker || undefined,
        VersionIdMarker: versionIdMarker || undefined,
      }));
      const hidden = collectHidden(resp);
      hidden.sort((a, b) => {
        const kc = a.key.localeCompare(b.key);
        return kc !== 0 ? kc : new Date(b.date) - new Date(a.date);
      });
      setRows(prev => replace ? hidden : [...(prev || []), ...hidden]);
      setIsTruncated(!!resp.IsTruncated);
      setNextKeyMarker(resp.NextKeyMarker || null);
      setNextVersionIdMarker(resp.NextVersionIdMarker || null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  function load() { fetchPage(null, null, true); }

  async function handleDeleteConfirm() {
    const row = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.key, VersionId: row.versionId }));
      setRows(prev => prev.filter(r => !(r.key === row.key && r.versionId === row.versionId)));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  }

  async function handlePurgeAllConfirm() {
    setDeleting(true);
    setDeleteError(null);
    try {
      // Collect all rows including any unloaded pages
      let all = [...(rows || [])];
      let km = nextKeyMarker;
      let vim = nextVersionIdMarker;
      let trunc = isTruncated;
      while (trunc) {
        const resp = await client.send(new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix || undefined,
          KeyMarker: km || undefined,
          VersionIdMarker: vim || undefined,
        }));
        all = all.concat(collectHidden(resp));
        trunc = !!resp.IsTruncated;
        km = resp.NextKeyMarker || null;
        vim = resp.NextVersionIdMarker || null;
      }

      // Batch delete in chunks of 1000 (S3 API limit)
      for (let i = 0; i < all.length; i += 1000) {
        const batch = all.slice(i, i + 1000);
        const resp = await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map(r => ({ Key: r.key, VersionId: r.versionId })), Quiet: true },
        }));
        if (resp.Errors && resp.Errors.length > 0) {
          const e = resp.Errors[0];
          throw new Error(`Failed to delete ${e.Key}: ${e.Message}`);
        }
      }

      setRows([]);
      setIsTruncated(false);
      setNextKeyMarker(null);
      setNextVersionIdMarker(null);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  }

  function handleCancel() { setPendingDelete(null); setDeleteError(null); }

  const rel = (key) => key.slice((prefix || '').length) || key;
  const isAll = pendingDelete === 'all';
  const n = rows ? rows.length : 0;

  return (
    <div class="hidden-versions">
      {pendingDelete && (
        <div class="modal-overlay" onClick={handleCancel}>
          <div class="modal-dialog" onClick={e => e.stopPropagation()}>
            <div class="modal-title">{isAll ? 'Purge all hidden versions?' : 'Permanently delete this version?'}</div>
            <div class="modal-body">
              {isAll ? (
                <p class="modal-caveat">
                  This will permanently delete {isTruncated ? `${n}+ ` : `all ${n} `}hidden
                  version{n !== 1 ? 's' : ''}{isTruncated ? ', including any not yet loaded,' : ''}. This cannot be undone.
                </p>
              ) : (
                <>
                  <p class="modal-filename" title={pendingDelete.key}>{rel(pendingDelete.key)}</p>
                  <p class="modal-caveat">
                    {pendingDelete.type === 'delete-marker'
                      ? 'Removing this delete marker will make the previous version of this file visible again in the listing.'
                      : 'This permanently removes this version and cannot be undone.'}
                  </p>
                </>
              )}
              {deleteError && <div class="modal-error">{deleteError.message || String(deleteError)}</div>}
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost btn-sm" onClick={handleCancel} disabled={deleting}>Cancel</button>
              <button
                class="btn btn-danger btn-sm"
                onClick={isAll ? handlePurgeAllConfirm : handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? <span class="spinner" /> : isAll ? 'Purge all' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rows === null && !loading && !error ? (
        <div class="hidden-versions-bar">
          <button class="btn btn-ghost btn-sm" onClick={load}>Show hidden versions…</button>
        </div>
      ) : (
        <>
          <div class="hidden-versions-header">
            <span class="section-heading" style={{ margin: 0 }}>Hidden versions</span>
            <div style={{ display: 'flex', gap: '.5rem' }}>
              {rows && rows.length > 0 && (
                <button
                  class="btn btn-ghost btn-sm"
                  style={{ color: 'var(--text-danger)', borderColor: 'var(--text-danger)' }}
                  onClick={() => { setDeleteError(null); setPendingDelete('all'); }}
                  disabled={loading || deleting}
                >
                  Purge all{isTruncated ? '…' : ` (${n})`}
                </button>
              )}
              <button class="btn btn-ghost btn-sm" onClick={load} disabled={loading || deleting}>Refresh</button>
            </div>
          </div>

          {error && (
            <ErrorBlock
              error={error}
              title="Failed to list versions"
              guidance="Check that your credentials have s3:ListObjectVersions permission and that versioning is supported by this provider."
            />
          )}

          {loading && <div class="empty-state"><span class="spinner" style={{ marginRight: '.5rem' }} />Loading…</div>}

          {!loading && rows !== null && rows.length === 0 && (
            <div class="empty-state">No hidden versions found in this prefix.</div>
          )}

          {rows && rows.length > 0 && (
            <table class="file-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Version ID</th>
                  <th style={{ textAlign: 'right' }}>Size</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.key}-${r.versionId}-${i}`} class="file-row">
                    <td class="col-name">
                      <span class="file-name" title={r.key}>{rel(r.key)}</span>
                    </td>
                    <td>
                      {r.type === 'delete-marker'
                        ? <span class="version-badge version-badge-dm">{r.isLatest ? 'Delete marker' : 'Delete marker (superseded)'}</span>
                        : <span class="version-badge version-badge-old">Old version</span>
                      }
                    </td>
                    <td class="col-version-id" title={r.versionId}>{shortVersionId(r.versionId)}</td>
                    <td class="col-size">{r.size != null ? formatBytes(r.size) : '—'}</td>
                    <td class="col-modified">{formatDate(r.date)}</td>
                    <td class="col-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        style={{ color: 'var(--text-danger)', borderColor: 'transparent' }}
                        onClick={() => { setDeleteError(null); setPendingDelete(r); }}
                        disabled={deleting}
                        title="Permanently delete this version"
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {isTruncated && !loading && (
            <div class="load-more-bar">
              <button class="btn btn-ghost" onClick={() => fetchPage(nextKeyMarker, nextVersionIdMarker, false)} disabled={deleting}>
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
