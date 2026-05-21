// Object browser: listing, navigation, download, delete (§4.2, §4.4, §4.7, §4.12)
import { useState, useEffect, useRef } from 'preact/hooks';
import { ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { formatBytes, leafName, isPermissionError } from '../lib/format.js';
import { defaultMaxKeys } from '../lib/provider.js';
import { loadMaxKeys } from '../lib/storage.js';
import { ErrorBlock } from './ErrorBlock.jsx';

const PRESIGN_EXPIRES = 3600; // 1 hour

function Breadcrumb({ prefix, onNavigate }) {
  if (!prefix) return (
    <div class="breadcrumb"><span class="current">/ (root)</span></div>
  );
  const parts = prefix.split('/').filter(Boolean);
  return (
    <div class="breadcrumb">
      <span class="crumb" onClick={() => onNavigate('')}>root</span>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/') + '/';
        const isLast = i === parts.length - 1;
        return [
          <span key={`sep-${i}`} class="sep">/</span>,
          isLast
            ? <span key={part} class="current">{part}</span>
            : <span key={part} class="crumb" onClick={() => onNavigate(target)}>{part}</span>,
        ];
      })}
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString(); } catch { return ''; }
}

function SortTh({ col, sortCol, sortDir, onSort, align, children }) {
  const active = sortCol === col;
  return (
    <th
      class={`col-sortable${active ? ' col-sort-active' : ''}`}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      onClick={() => onSort(col)}
      title={`Sort by ${children}`}
    >
      {children}
      <span class="sort-indicator">
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </th>
  );
}

export function Browser({ client, bucket, provider, credentials, onCapabilityChange, capabilities, onUploadTargetChange, onInitialListFailed }) {
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState([]);
  const [commonPrefixes, setCommonPrefixes] = useState([]);
  const [continuationToken, setContinuationToken] = useState(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [pendingDelete, setPendingDelete] = useState(null); // object to confirm
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const abortRef = useRef(null);

  const maxKeys = loadMaxKeys() || defaultMaxKeys(provider);

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  // Notify parent of current prefix so upload queue knows where to target
  useEffect(() => {
    if (onUploadTargetChange) onUploadTargetChange(prefix);
  }, [prefix]);

  // Navigate to a new prefix — flush state synchronously (§4.7, §4.14)
  function navigateTo(newPrefix) {
    if (abortRef.current) abortRef.current.abort();
    setPrefix(newPrefix);
    setItems([]);
    setCommonPrefixes([]);
    setContinuationToken(null);
    setIsTruncated(false);
    setListError(null);
    setDownloadError(null);
    fetchPage(newPrefix, null, true);
  }

  const isInitialProbeRef = useRef(true);

  async function fetchPage(targetPrefix, token, replace = false) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setListing(true);
    setListError(null);

    const isInitial = isInitialProbeRef.current;

    try {
      const cmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: targetPrefix || undefined,
        Delimiter: '/',
        MaxKeys: maxKeys,
        ContinuationToken: token || undefined,
      });
      const resp = await client.send(cmd, { abortSignal: controller.signal });

      isInitialProbeRef.current = false;

      const newItems = resp.Contents || [];
      const newPrefixes = (resp.CommonPrefixes || []).map(cp => cp.Prefix);

      if (replace) {
        setItems(newItems);
        setCommonPrefixes(newPrefixes);
      } else {
        setItems(prev => [...prev, ...newItems]);
        setCommonPrefixes(prev => [...prev, ...newPrefixes]);
      }
      setContinuationToken(resp.NextContinuationToken || null);
      setIsTruncated(!!resp.IsTruncated);
      onCapabilityChange('list', 'permitted');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setListError(err);
      if (isPermissionError(err)) onCapabilityChange('list', 'denied');
      // Notify parent when the initial listing probe fails (§4.14 Connection Failed state)
      if (isInitial && onInitialListFailed) onInitialListFailed(err);
    } finally {
      setListing(false);
    }
  }

  // Initial load
  useEffect(() => {
    navigateTo('');
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [client, bucket]);

  async function handleDownload(key) {
    setDownloadError(null);
    setDownloadingKey(key);
    try {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(leafName(key))}"`,
        }),
        { expiresIn: PRESIGN_EXPIRES }
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = leafName(key);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      onCapabilityChange('download', 'permitted');
    } catch (err) {
      setDownloadError(err);
      if (isPermissionError(err)) onCapabilityChange('download', 'denied');
    } finally {
      setDownloadingKey(null);
    }
  }

  function handleDeleteClick(obj) {
    setDeleteError(null);
    setPendingDelete(obj);
  }

  function handleDeleteCancel() {
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function handleDeleteConfirm() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: pendingDelete.Key }));
      onCapabilityChange('delete', 'permitted');
      setItems(prev => prev.filter(o => o.Key !== pendingDelete.Key));
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err);
      if (isPermissionError(err)) onCapabilityChange('delete', 'denied');
    } finally {
      setDeleting(false);
    }
  }

  const canDownload = capabilities.download !== 'denied';
  const canDelete   = capabilities.delete !== 'denied';
  const canList     = capabilities.list !== 'denied';

  if (!canList && listError) {
    return (
      <div>
        <ErrorBlock
          error={listError}
          title="Cannot list bucket contents"
          guidance="Check that your key has ListObjects permission on this bucket."
        />
      </div>
    );
  }

  // Sort folders by name only (no size/date available)
  const sortedFolders = [...commonPrefixes].sort((a, b) => {
    const nameA = a.slice(prefix.length).replace(/\/$/, '');
    const nameB = b.slice(prefix.length).replace(/\/$/, '');
    const cmp = nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Sort files by the selected column
  const sortedItems = items.filter(obj => !!obj.Key.slice(prefix.length)).sort((a, b) => {
    let cmp = 0;
    if (sortCol === 'name') {
      cmp = a.Key.slice(prefix.length).localeCompare(b.Key.slice(prefix.length), undefined, { sensitivity: 'base' });
    } else if (sortCol === 'size') {
      cmp = (a.Size || 0) - (b.Size || 0);
    } else if (sortCol === 'modified') {
      const tA = a.LastModified ? new Date(a.LastModified).getTime() : 0;
      const tB = b.LastModified ? new Date(b.LastModified).getTime() : 0;
      cmp = tA - tB;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const isEmpty = !listing && sortedItems.length === 0 && sortedFolders.length === 0 && !listError;

  const versioningCaveat = provider === 'b2'
    ? 'Backblaze B2 may retain older versions of this file. The current version will be hidden but not immediately purged from storage.'
    : 'If versioning is enabled on this bucket, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent and cannot be undone.';

  return (
    <div>
      {pendingDelete && (
        <div class="modal-overlay" onClick={handleDeleteCancel}>
          <div class="modal-dialog" onClick={e => e.stopPropagation()}>
            <div class="modal-title">Delete file?</div>
            <div class="modal-body">
              <p class="modal-filename" title={pendingDelete.Key}>{leafName(pendingDelete.Key)}</p>
              <p class="modal-caveat">{versioningCaveat}</p>
              {deleteError && (
                <div class="modal-error">
                  Delete failed: {deleteError.message || String(deleteError)}
                </div>
              )}
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost btn-sm" onClick={handleDeleteCancel} disabled={deleting}>Cancel</button>
              <button class="btn btn-danger btn-sm" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? <span class="spinner" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Breadcrumb prefix={prefix} onNavigate={navigateTo} />

      {downloadError && (
        <ErrorBlock
          error={downloadError}
          title="Download failed"
          guidance="Check that your key has GetObject permission on this bucket."
        />
      )}

      {listError && (
        <ErrorBlock
          error={listError}
          title="Listing failed"
          guidance="If this looks like a CORS error, check your bucket's CORS configuration."
        />
      )}

      {isEmpty
        ? <div class="empty-state">This prefix is empty.</div>
        : (
          <table class="file-table">
            <thead>
              <tr>
                <SortTh col="name" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Name</SortTh>
                <SortTh col="size" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Size</SortTh>
                <SortTh col="modified" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Modified</SortTh>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedFolders.map(cp => (
                <tr key={cp} class="file-row" onClick={() => navigateTo(cp)} style={{ cursor: 'pointer' }}>
                  <td class="col-name">
                    <span class="file-icon">📁</span>
                    <span class="file-dir">{cp.slice(prefix.length).replace(/\/$/, '')}</span>
                  </td>
                  <td class="col-size">—</td>
                  <td class="col-modified"></td>
                  <td class="col-actions"></td>
                </tr>
              ))}

              {sortedItems.map(obj => {
                const display = obj.Key.slice(prefix.length);
                const isDownloading = downloadingKey === obj.Key;
                return (
                  <tr key={obj.Key} class="file-row">
                    <td class="col-name">
                      <span class="file-icon">📄</span>
                      <span class="file-name" title={obj.Key}>{display}</span>
                    </td>
                    <td class="col-size">{formatBytes(obj.Size)}</td>
                    <td class="col-modified">{formatDate(obj.LastModified)}</td>
                    <td class="col-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={() => handleDownload(obj.Key)}
                        disabled={!canDownload || isDownloading}
                        title={!canDownload ? 'Download not permitted with current credentials' : 'Download'}
                      >
                        {isDownloading ? <span class="spinner" /> : '↓'}
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        style={{ color: 'var(--text-danger)', borderColor: 'transparent', marginLeft: '.25rem' }}
                        onClick={() => handleDeleteClick(obj)}
                        disabled={!canDelete}
                        title={!canDelete ? 'Delete not permitted with current credentials' : 'Delete'}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }

      {listing && (
        <div class="empty-state"><span class="spinner" style={{ marginRight: '.5rem' }} />Loading…</div>
      )}

      {isTruncated && !listing && (
        <div class="load-more-bar">
          <button class="btn btn-ghost" onClick={() => fetchPage(prefix, continuationToken)}>
            Load more ({maxKeys} per page)
          </button>
        </div>
      )}
    </div>
  );
}
