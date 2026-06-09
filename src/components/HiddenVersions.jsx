// Copyright (C) 2026 HidayahTech, LLC
// Hidden versions panel: lists old versions and delete markers (D-6).
//
// In S3 versioned buckets, ListObjectsV2 only shows the latest version of each key.
// This panel uses ListObjectVersionsCommand to surface:
//   - Old versions (IsLatest=false): previous copies of overwritten objects
//   - Delete markers: tombstones that hide a file from the normal listing
//
// Removing a delete marker where IsLatest=true UNDELETES the file (the prior version
// becomes visible). The confirmation dialog reflects this with "Undelete?" vs "Delete version?".
//
// Purge-all exhausts all pagination before deleting. Partial purge (deleting only the
// loaded page) would leave orphaned versions and show a misleading "done" message.
// Batched in 1000-object chunks — the S3 DeleteObjects API maximum.
import { useState } from 'preact/hooks';
import { ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { formatBytes } from '../lib/format.js';
import { ErrorBlock } from './ErrorBlock.jsx';
import { Modal } from './Modal.jsx';
import { purgeAllVersions, collectHiddenVersions } from '../lib/purge-versions.js';

function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(); } catch { return ''; }
}

function shortVersionId(id) {
  if (!id) return '—';
  return id.length > 18 ? id.slice(0, 18) + '…' : id;
}


export function HiddenVersions({ client, bucket, prefix, provider }) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [nextKeyMarker, setNextKeyMarker] = useState(null);
  const [nextVersionIdMarker, setNextVersionIdMarker] = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null); // row object | 'all'
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Cloudflare R2 does not support versioning — gate early to avoid a confusing empty panel.
  if (provider === 'r2') {
    return (
      <div class="hidden-versions">
        <div class="hidden-versions-bar">
          <span style={{ color: 'var(--text-muted)' }}>
            R2 does not support versioning — the hidden versions panel is not available for Cloudflare R2 buckets.
          </span>
        </div>
      </div>
    );
  }

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
      const hidden = collectHiddenVersions(resp);
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
      const allErrors = await purgeAllVersions(client, {
        bucket, prefix: prefix || '',
        initialRows: rows || [],
        nextKeyMarker, nextVersionIdMarker, isTruncated,
      });

      if (allErrors.length > 0) {
        const first = allErrors[0];
        setDeleteError(new Error(
          `${allErrors.length} version${allErrors.length !== 1 ? 's' : ''} failed to delete. ` +
          `First error — ${first.Key}: ${first.Message}`
        ));
      } else {
        setRows([]);
        setIsTruncated(false);
        setNextKeyMarker(null);
        setNextVersionIdMarker(null);
        setPendingDelete(null);
      }
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
        <Modal onClose={handleCancel}>
            <div class="modal-title">
              {isAll ? 'Purge all hidden versions?' : pendingDelete.type === 'delete-marker' && pendingDelete.isLatest ? 'Undelete this file?' : 'Permanently delete this version?'}
            </div>
            <div class="modal-body">
              {isAll ? (
                <>
                  <p class="modal-caveat">
                    This will permanently delete {isTruncated ? `${n}+ ` : `all ${n} `}hidden
                    version{n !== 1 ? 's' : ''}{isTruncated ? ', including any not yet loaded,' : ''}.
                  </p>
                  <p class="modal-caveat">
                    Any delete markers in this set will also be removed, which will undelete those files — their previous versions will reappear in the listing.
                  </p>
                  {provider === 'wasabi' && (
                    <p class="modal-caveat">
                      Wasabi has a 90-day minimum retention period. Versions deleted before 90 days are still billed for the remainder of that window.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p class="modal-filename" title={pendingDelete.key}>{rel(pendingDelete.key)}</p>
                  <p class="modal-caveat">
                    {pendingDelete.type === 'delete-marker' && pendingDelete.isLatest
                      ? 'This delete marker is what makes the file appear deleted. Removing it will undelete the file — the previous version will become visible in the listing again.'
                      : pendingDelete.type === 'delete-marker'
                        ? 'This is a superseded delete marker. Removing it will not change the file\'s current visibility.'
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
                {deleting ? <span class="spinner" /> : isAll ? 'Purge all' : pendingDelete.type === 'delete-marker' && pendingDelete.isLatest ? 'Undelete' : 'Delete'}
              </button>
            </div>
        </Modal>
      )}

      {rows === null && !loading && !error ? (
        <div class="hidden-versions-bar">
          <button class="btn btn-ghost btn-sm" onClick={load}>Show hidden versions…</button>
        </div>
      ) : (
        <>
          <div class="hidden-versions-header">
            <span class="section-heading" style={{ margin: 0 }}>Hidden versions &amp; deleted files</span>
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

          <p class="hidden-versions-note">
            Items here are not visible in the normal listing.
            <strong> Old versions</strong> are previous copies of files that were overwritten.
            <strong> Delete markers</strong> are what make files appear deleted — the content still exists in storage, and removing a delete marker will undelete the file.
          </p>

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
                        ? <span class="version-badge version-badge-dm" title={r.isLatest ? 'This marker is hiding the file — removing it will undelete the file' : 'An older delete marker, no longer the current version'}>
                            {r.isLatest ? 'Delete marker — file hidden' : 'Delete marker (superseded)'}
                          </span>
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
                        title={r.type === 'delete-marker' && r.isLatest ? 'Undelete file (remove this delete marker)' : 'Permanently delete this version'}
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
