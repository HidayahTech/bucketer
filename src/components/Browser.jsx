// Object browser: listing, navigation, download, delete (§4.2, §4.4, §4.7, §4.12)
import { useState, useEffect, useRef } from 'preact/hooks';
import { ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { formatBytes, leafName, isPermissionError } from '../lib/format.js';
import { defaultMaxKeys } from '../lib/provider.js';
import { loadMaxKeys } from '../lib/storage.js';
import { pushPrefixHistory } from '../lib/url-params.js';
import { mediaKind, mimeType, mimeKind } from '../lib/media.js';
import { collectFileEntries } from '../lib/file-entries.js';
import { ErrorBlock } from './ErrorBlock.jsx';
import { HiddenVersions } from './HiddenVersions.jsx';

// Read the URL prefix exactly once per page session. Subsequent mounts (reconnects)
// always start at root — only the very first mount restores the URL-specified path.
let _sessionFirstMount = true;

const PRESIGN_EXPIRES = 3600;        // 1 hour
const TEXT_PREVIEW_LIMIT = 100 * 1024; // 100 KB cap for text previews

const COPY_LINK_PRESETS = [
  { label: '1 hour',   seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days',   seconds: 604800 },
];

function CopyLinkPopover({ client, bucket, fileKey, onClose, onCopied, direction = 'down' }) {
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('1');
  const [customUnit, setCustomUnit] = useState('hours');
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState(null);

  async function copyLink(expiresIn) {
    setCopying(true);
    setError(null);
    try {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: fileKey, ResponseContentDisposition: 'inline' }),
        { expiresIn },
      );
      await navigator.clipboard.writeText(url);
      onCopied();
      onClose();
    } catch (err) {
      setError(err.message || String(err));
      setCopying(false);
    }
  }

  function handleCustomCopy() {
    const mult = { minutes: 60, hours: 3600, days: 86400 };
    const n = parseInt(customValue, 10);
    if (!n || n < 1) { setError('Enter a positive number.'); return; }
    const seconds = n * mult[customUnit];
    if (seconds > 604800) { setError('Maximum is 7 days.'); return; }
    copyLink(seconds);
  }

  return (
    <div class={`copy-link-popover${direction === 'up' ? ' copy-link-popover--up' : ''}`}>
      <div class="copy-link-presets">
        {COPY_LINK_PRESETS.map(p => (
          <button key={p.seconds} class="btn btn-ghost btn-sm" onClick={() => copyLink(p.seconds)} disabled={copying}>
            {p.label}
          </button>
        ))}
        <button class="btn btn-ghost btn-sm" onClick={() => setShowCustom(v => !v)} disabled={copying}>
          Custom…
        </button>
      </div>
      {showCustom && (
        <div class="copy-link-custom">
          <input
            type="number" min="1" class="copy-link-num"
            value={customValue}
            onInput={e => { setCustomValue(e.target.value); setError(null); }}
          />
          <select class="copy-link-unit" value={customUnit} onChange={e => setCustomUnit(e.target.value)}>
            <option value="minutes">min</option>
            <option value="hours">hrs</option>
            <option value="days">days</option>
          </select>
          <button class="btn btn-ghost btn-sm" onClick={handleCustomCopy} disabled={copying}>
            {copying ? <span class="spinner" /> : 'Copy'}
          </button>
        </div>
      )}
      {error && <div class="copy-link-error">{error}</div>}
      <div class="copy-link-note">Link expires after the selected duration.</div>
    </div>
  );
}

function BatchCopyLinkPopover({ client, bucket, keys, onClose, onCopied }) {
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('1');
  const [customUnit, setCustomUnit] = useState('hours');
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState(null);

  async function copyLinks(expiresIn) {
    setCopying(true);
    setError(null);
    try {
      const urls = await Promise.all(keys.map(key => getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: 'inline' }),
        { expiresIn },
      )));
      await navigator.clipboard.writeText(urls.join('\n'));
      onCopied(keys.length);
      onClose();
    } catch (err) {
      setError(err.message || String(err));
      setCopying(false);
    }
  }

  function handleCustomCopy() {
    const mult = { minutes: 60, hours: 3600, days: 86400 };
    const n = parseInt(customValue, 10);
    if (!n || n < 1) { setError('Enter a positive number.'); return; }
    const seconds = n * mult[customUnit];
    if (seconds > 604800) { setError('Maximum is 7 days.'); return; }
    copyLinks(seconds);
  }

  return (
    <div class="copy-link-popover copy-link-popover--up">
      <div class="copy-link-presets">
        {COPY_LINK_PRESETS.map(p => (
          <button key={p.seconds} class="btn btn-ghost btn-sm" onClick={() => copyLinks(p.seconds)} disabled={copying}>
            {p.label}
          </button>
        ))}
        <button class="btn btn-ghost btn-sm" onClick={() => setShowCustom(v => !v)} disabled={copying}>
          Custom…
        </button>
      </div>
      {showCustom && (
        <div class="copy-link-custom">
          <input type="number" min="1" class="copy-link-num" value={customValue}
            onInput={e => { setCustomValue(e.target.value); setError(null); }} />
          <select class="copy-link-unit" value={customUnit} onChange={e => setCustomUnit(e.target.value)}>
            <option value="minutes">min</option>
            <option value="hours">hrs</option>
            <option value="days">days</option>
          </select>
          <button class="btn btn-ghost btn-sm" onClick={handleCustomCopy} disabled={copying}>
            {copying ? <span class="spinner" /> : 'Copy'}
          </button>
        </div>
      )}
      {error && <div class="copy-link-error">{error}</div>}
      <div class="copy-link-note">{keys.length} link{keys.length !== 1 ? 's' : ''}, one per line. Expires after selected duration.</div>
    </div>
  );
}

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

export function Browser({ client, bucket, provider, credentials, onCapabilityChange, capabilities, onUploadTargetChange, onInitialListFailed, onExternalDrop }) {
  const [prefix, setPrefix] = useState(() => {
    if (_sessionFirstMount) {
      _sessionFirstMount = false;
      return new URLSearchParams(window.location.hash.slice(1)).get('prefix') || '';
    }
    return '';
  });
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
  // folderDelete: null | { prefix, phase: 'confirm'|'listing'|'deleting'|'done', total, deleted, errors }
  const [folderDelete, setFolderDelete] = useState(null);
  const [previewItem, setPreviewItem] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [resolvedKind, setResolvedKind] = useState(null);
  const [notPreviewable, setNotPreviewable] = useState(false);
  const [detectedContentType, setDetectedContentType] = useState(null);
  const [previewText, setPreviewText] = useState(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [batchDeletePending, setBatchDeletePending] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDeleteError, setBatchDeleteError] = useState(null);
  const [batchCopyOpen, setBatchCopyOpen] = useState(false);
  const [batchCopied, setBatchCopied] = useState(null);
  const [tableDragOver, setTableDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [metaItem, setMetaItem] = useState(null);
  const [metaData, setMetaData] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState(null);
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState(null);
  const [newFolderSaving, setNewFolderSaving] = useState(false);
  const [tableCopyKey, setTableCopyKey] = useState(null);
  const [tableCopied, setTableCopied] = useState(null);
  const [previewCopyOpen, setPreviewCopyOpen] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const abortRef = useRef(null);
  const tableCopyWrapRef = useRef(null);
  const previewCopyWrapRef = useRef(null);
  const batchCopyWrapRef = useRef(null);
  // Always-current reference to navigateTo for the popstate handler (which has [] deps)
  const navigateRef = useRef(null);
  // Always-current reference to preview navigator, updated after sortedItems is computed
  const navigatePreviewRef = useRef(null);
  // Capture the prefix value at mount time for the initial history replaceState
  const initialPrefixRef = useRef(prefix);

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

  // Navigate to a new prefix — flush state and push a browser history entry (§4.7, §4.14)
  function navigateTo(newPrefix, { historyMode = 'push' } = {}) {
    if (abortRef.current) abortRef.current.abort();
    if (historyMode === 'push')    pushPrefixHistory(newPrefix, false);
    if (historyMode === 'replace') pushPrefixHistory(newPrefix, true);
    setPrefix(newPrefix);
    setItems([]);
    setCommonPrefixes([]);
    setContinuationToken(null);
    setIsTruncated(false);
    setListError(null);
    setDownloadError(null);
    setFilterQuery('');
    setSelectedKeys(new Set());
    setBatchCopyOpen(false);
    setBatchCopied(null);
    fetchPage(newPrefix, null, true);
  }
  navigateRef.current = navigateTo;

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

  // Initial load — use replaceState so the initial prefix doesn't add a history entry
  useEffect(() => {
    navigateTo(initialPrefixRef.current, { historyMode: 'replace' });
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [client, bucket]);

  // Back / forward button support — restore prefix from history state
  useEffect(() => {
    function onPopState(e) {
      const newPrefix = e.state?.prefix !== undefined
        ? e.state.prefix
        : (new URLSearchParams(window.location.hash.slice(1)).get('prefix') || '');
      navigateRef.current(newPrefix, { historyMode: 'none' });
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!tableCopyKey) return;
    function onDown(e) {
      if (tableCopyWrapRef.current && !tableCopyWrapRef.current.contains(e.target)) setTableCopyKey(null);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tableCopyKey]);

  useEffect(() => {
    if (!previewCopyOpen) return;
    function onDown(e) {
      if (previewCopyWrapRef.current && !previewCopyWrapRef.current.contains(e.target)) setPreviewCopyOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [previewCopyOpen]);

  useEffect(() => {
    if (!batchCopyOpen) return;
    function onDown(e) {
      if (batchCopyWrapRef.current && !batchCopyWrapRef.current.contains(e.target)) setBatchCopyOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [batchCopyOpen]);

  function toggleSelect(key, e) {
    e.stopPropagation();
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleSelectAll(visItems) {
    const allSelected = visItems.length > 0 && visItems.every(o => selectedKeys.has(o.Key));
    setSelectedKeys(allSelected ? new Set() : new Set(visItems.map(o => o.Key)));
  }

  async function handleBatchDelete() {
    setBatchDeleting(true);
    setBatchDeleteError(null);
    const keys = [...selectedKeys];
    try {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
      }
      onCapabilityChange('delete', 'permitted');
      setItems(prev => prev.filter(o => !selectedKeys.has(o.Key)));
      setSelectedKeys(new Set());
      setBatchDeletePending(false);
    } catch (err) {
      setBatchDeleteError(err);
    } finally {
      setBatchDeleting(false);
    }
  }

  function handleTableDragEnter(e) {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (onExternalDrop) setTableDragOver(true);
  }

  function handleTableDragLeave() {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setTableDragOver(false);
  }

  async function handleTableDrop(e) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setTableDragOver(false);
    if (!onExternalDrop) return;
    const fsEntries = [];
    const items = e.dataTransfer?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = item.kind === 'file' && (item.getAsEntry?.() ?? item.webkitGetAsEntry?.());
        if (entry) fsEntries.push(entry);
      }
    }
    if (fsEntries.length) {
      const fileEntries = await collectFileEntries(fsEntries);
      if (fileEntries.length) onExternalDrop(fileEntries);
    } else {
      const files = e.dataTransfer?.files;
      if (files?.length) onExternalDrop(Array.from(files).map(f => ({ file: f, relativePath: f.name })));
    }
  }

  async function handleShowMeta(obj) {
    setMetaItem(obj);
    setMetaData(null);
    setMetaError(null);
    setMetaLoading(true);
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.Key }));
      setMetaData(head);
    } catch (err) {
      setMetaError(err.message || String(err));
    } finally {
      setMetaLoading(false);
    }
  }

  function startRename(key) {
    setRenamingKey(key);
    setRenameValue(leafName(key));
    setRenameError(null);
  }

  async function commitRename(oldKey) {
    const newName = renameValue.trim();
    if (!newName) { setRenameError('Name cannot be empty.'); return; }
    if (newName.includes('/')) { setRenameError('Name cannot contain slashes.'); return; }
    const newKey = prefix + newName;
    if (newKey === oldKey) { setRenamingKey(null); return; }
    if (items.some(o => o.Key === newKey)) { setRenameError('A file with that name already exists.'); return; }
    setRenameSaving(true);
    setRenameError(null);
    try {
      await client.send(new CopyObjectCommand({
        Bucket: bucket, CopySource: `${bucket}/${oldKey}`,
        Key: newKey, MetadataDirective: 'COPY',
      }));
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
      setItems(prev => prev.map(o => o.Key === oldKey ? { ...o, Key: newKey } : o));
      setRenamingKey(null);
    } catch (err) {
      setRenameError(err.message || String(err));
    } finally {
      setRenameSaving(false);
    }
  }

  function handleTableCopyLinkCopied(key) {
    setTableCopied(key);
    setTimeout(() => setTableCopied(k => k === key ? null : k), 2000);
  }

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

  async function handlePreview(obj) {
    setPreviewItem(obj);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewTruncated(false);
    setPreviewError(null);
    setResolvedKind(null);
    setNotPreviewable(false);
    setDetectedContentType(null);
    setPreviewCopyOpen(false);
    setPreviewCopied(false);
    try {
      let kind, contentType;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.Key }));
        contentType = head.ContentType || '';
        kind = mimeKind(contentType) || mediaKind(obj.Key);
        // If ContentType is generic but extension tells us the type, use the extension MIME
        if (!mimeKind(contentType) && mediaKind(obj.Key)) {
          contentType = mimeType(obj.Key) || contentType;
        }
      } catch {
        // HeadObject failed (e.g. no permission) — fall back to extension-based detection
        contentType = mimeType(obj.Key) || '';
        kind = mediaKind(obj.Key);
      }
      if (!kind) {
        setNotPreviewable(true);
        setDetectedContentType(contentType || null);
        return;
      }
      setResolvedKind(kind);

      if (kind === 'text') {
        // Force text/plain regardless of stored ContentType — prevents HTML/JS execution
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket, Key: obj.Key,
            ResponseContentDisposition: 'inline',
            ResponseContentType: 'text/plain; charset=utf-8',
          }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        const resp = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } });
        setPreviewText(await resp.text());
        setPreviewTruncated(resp.status === 206);
      } else {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket, Key: obj.Key,
            ResponseContentDisposition: 'inline',
            ...(contentType ? { ResponseContentType: contentType } : {}),
          }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        setPreviewUrl(url);
      }
    } catch (err) {
      setPreviewError(err);
    }
  }

  function closePreview() {
    setPreviewItem(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewTruncated(false);
    setPreviewError(null);
    setResolvedKind(null);
    setNotPreviewable(false);
    setDetectedContentType(null);
    setPreviewCopyOpen(false);
    setPreviewCopied(false);
  }

  useEffect(() => {
    if (!previewItem) return;
    function onKey(e) {
      if (e.key === 'Escape')     closePreview();
      if (e.key === 'ArrowLeft')  navigatePreviewRef.current?.(-1);
      if (e.key === 'ArrowRight') navigatePreviewRef.current?.(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewItem]);

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

  function handleFolderDeleteClick(cp, e) {
    e.stopPropagation();
    setFolderDelete({ prefix: cp, phase: 'confirm', total: null, deleted: 0, errors: [] });
  }

  async function handleFolderDeleteConfirm() {
    const fp = folderDelete.prefix;
    setFolderDelete(prev => ({ ...prev, phase: 'listing' }));

    const keys = [];
    let token;
    try {
      do {
        const resp = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: fp, MaxKeys: 1000, ContinuationToken: token,
        }));
        (resp.Contents || []).forEach(o => keys.push(o.Key));
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      setFolderDelete(prev => ({ ...prev, phase: 'done', errors: [{ key: '(listing)', message: err.message }] }));
      return;
    }

    if (keys.length === 0) {
      setCommonPrefixes(prev => prev.filter(p => p !== fp));
      setFolderDelete(null);
      return;
    }

    setFolderDelete(prev => ({ ...prev, phase: 'deleting', total: keys.length }));

    const errors = [];
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
      try {
        const resp = await client.send(new DeleteObjectsCommand({
          Bucket: bucket, Delete: { Objects: batch, Quiet: true },
        }));
        const batchErrors = resp.Errors || [];
        errors.push(...batchErrors.map(e => ({ key: e.Key, message: e.Message || e.Code })));
        deleted += batch.length - batchErrors.length;
      } catch (err) {
        batch.forEach(o => errors.push({ key: o.Key, message: err.message }));
      }
      setFolderDelete(prev => ({ ...prev, deleted }));
    }

    onCapabilityChange('delete', 'permitted');
    setFolderDelete(prev => ({ ...prev, phase: 'done', deleted, errors }));
    fetchPage(prefix, null, true);
  }

  function closeFolderDeleteModal() {
    setFolderDelete(null);
  }

  function openNewFolder() {
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderOpen(true);
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) { setNewFolderError('Enter a folder name.'); return; }
    if (name.includes('/')) { setNewFolderError('Folder name cannot contain slashes.'); return; }
    const key = prefix + name + '/';
    if (commonPrefixes.includes(key)) { setNewFolderError('A folder with that name already exists.'); return; }
    setNewFolderSaving(true);
    setNewFolderError(null);
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: '', ContentType: 'application/x-directory',
      }));
      setCommonPrefixes(prev => [...prev, key].sort());
      setNewFolderOpen(false);
    } catch (err) {
      setNewFolderError(err.message || String(err));
    } finally {
      setNewFolderSaving(false);
    }
  }

  const canDownload = capabilities.download !== 'denied';
  const canDelete   = capabilities.delete !== 'denied';
  const canList     = capabilities.list !== 'denied';

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

  const filterQ = filterQuery.trim().toLowerCase();
  const visibleFolders = filterQ
    ? sortedFolders.filter(cp => cp.slice(prefix.length).replace(/\/$/, '').toLowerCase().includes(filterQ))
    : sortedFolders;
  const visibleItems = filterQ
    ? sortedItems.filter(obj => obj.Key.slice(prefix.length).toLowerCase().includes(filterQ))
    : sortedItems;

  const isEmpty = !listing && visibleItems.length === 0 && visibleFolders.length === 0 && !listError;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every(o => selectedKeys.has(o.Key));
  const someVisibleSelected = !allVisibleSelected && visibleItems.some(o => selectedKeys.has(o.Key));

  const versioningCaveat = provider === 'b2'
    ? 'Backblaze B2 may retain older versions of this file. The current version will be hidden but not immediately purged from storage.'
    : 'If versioning is enabled on this bucket, this creates a delete marker — the object is hidden but recoverable. If versioning is off, deletion is permanent and cannot be undone.';

  // Preview navigation — ordered to match the current display sort.
  // Includes extension-less files since they may have a previewable ContentType.
  const previewableItems = visibleItems.filter(obj => mediaKind(obj.Key) || !leafName(obj.Key).includes('.'));
  const previewIdx = previewItem ? previewableItems.findIndex(o => o.Key === previewItem.Key) : -1;
  const prevPreviewItem = previewIdx > 0 ? previewableItems[previewIdx - 1] : null;
  const nextPreviewItem = previewIdx >= 0 && previewIdx < previewableItems.length - 1 ? previewableItems[previewIdx + 1] : null;
  navigatePreviewRef.current = (delta) => {
    const target = delta < 0 ? prevPreviewItem : nextPreviewItem;
    if (target) handlePreview(target);
  };

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

  return (
    <div
      class={tableDragOver ? 'browser-drop-active' : undefined}
      onDragEnter={handleTableDragEnter}
      onDragOver={e => e.preventDefault()}
      onDragLeave={handleTableDragLeave}
      onDrop={handleTableDrop}
      style={{ position: 'relative' }}
    >
      {tableDragOver && (
        <div class="browser-drop-overlay">Drop files to upload to this folder</div>
      )}
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

      {folderDelete && (
        <div class="modal-overlay" onClick={folderDelete.phase === 'confirm' ? closeFolderDeleteModal : undefined}>
          <div class="modal-dialog" onClick={e => e.stopPropagation()}>
            {folderDelete.phase === 'confirm' && (<>
              <div class="modal-title">Delete folder?</div>
              <div class="modal-body">
                <p class="modal-filename">{folderDelete.prefix.slice(prefix.length)}</p>
                <p class="modal-caveat">All objects inside will be permanently deleted. {versioningCaveat}</p>
              </div>
              <div class="modal-actions">
                <button class="btn btn-ghost btn-sm" onClick={closeFolderDeleteModal}>Cancel</button>
                <button class="btn btn-danger btn-sm" onClick={handleFolderDeleteConfirm}>Delete folder</button>
              </div>
            </>)}
            {(folderDelete.phase === 'listing' || folderDelete.phase === 'deleting') && (<>
              <div class="modal-title">Deleting folder…</div>
              <div class="modal-body">
                <p class="modal-filename">{folderDelete.prefix.slice(prefix.length)}</p>
                {folderDelete.phase === 'listing'
                  ? <p class="modal-caveat"><span class="spinner" style={{ marginRight: '.4rem' }} />Listing objects…</p>
                  : <p class="modal-caveat"><span class="spinner" style={{ marginRight: '.4rem' }} />Deleting {folderDelete.deleted} / {folderDelete.total} objects…</p>
                }
              </div>
            </>)}
            {folderDelete.phase === 'done' && (<>
              <div class="modal-title">{folderDelete.errors.length === 0 ? 'Folder deleted' : 'Deleted with errors'}</div>
              <div class="modal-body">
                <p class="modal-filename">{folderDelete.prefix.slice(prefix.length)}</p>
                <p class="modal-caveat">{folderDelete.deleted} object{folderDelete.deleted !== 1 ? 's' : ''} deleted.</p>
                {folderDelete.errors.length > 0 && (
                  <div class="modal-error">
                    {folderDelete.errors.slice(0, 5).map((e, i) => (
                      <div key={i}>{e.key}: {e.message}</div>
                    ))}
                    {folderDelete.errors.length > 5 && <div>…and {folderDelete.errors.length - 5} more</div>}
                  </div>
                )}
              </div>
              <div class="modal-actions">
                <button class="btn btn-ghost btn-sm" onClick={closeFolderDeleteModal}>Close</button>
              </div>
            </>)}
          </div>
        </div>
      )}

      {batchDeletePending && (
        <div class="modal-overlay" onClick={() => setBatchDeletePending(false)}>
          <div class="modal-dialog" onClick={e => e.stopPropagation()}>
            <div class="modal-title">Delete {selectedKeys.size} file{selectedKeys.size !== 1 ? 's' : ''}?</div>
            <div class="modal-body">
              <p class="modal-caveat">{versioningCaveat}</p>
              {batchDeleteError && (
                <div class="modal-error">Delete failed: {batchDeleteError.message || String(batchDeleteError)}</div>
              )}
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost btn-sm" onClick={() => setBatchDeletePending(false)} disabled={batchDeleting}>Cancel</button>
              <button class="btn btn-danger btn-sm" onClick={handleBatchDelete} disabled={batchDeleting}>
                {batchDeleting ? <span class="spinner" /> : `Delete ${selectedKeys.size}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {newFolderOpen && (
        <div class="modal-overlay" onClick={() => setNewFolderOpen(false)}>
          <div class="modal-dialog" onClick={e => e.stopPropagation()}>
            <div class="modal-title">New folder</div>
            <div class="modal-body">
              <input
                class="form-input"
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onInput={e => { setNewFolderName(e.target.value); setNewFolderError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderOpen(false); }}
                autoFocus
              />
              {newFolderError && <div class="modal-error">{newFolderError}</div>}
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost btn-sm" onClick={() => setNewFolderOpen(false)} disabled={newFolderSaving}>Cancel</button>
              <button class="btn btn-primary btn-sm" onClick={handleCreateFolder} disabled={newFolderSaving}>
                {newFolderSaving ? <span class="spinner" /> : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {metaItem && (
        <div class="modal-overlay" onClick={() => setMetaItem(null)}>
          <div class="modal-dialog meta-dialog" onClick={e => e.stopPropagation()}>
            <div class="modal-title">File properties</div>
            <div class="modal-body">
              <p class="modal-filename" title={metaItem.Key}>{leafName(metaItem.Key)}</p>
              {metaLoading && <div class="empty-state"><span class="spinner" style={{ marginRight: '.4rem' }} />Loading…</div>}
              {metaError && <div class="modal-error">{metaError}</div>}
              {metaData && (() => {
                const custom = Object.entries(metaData.Metadata || {});
                return (
                  <table class="meta-table">
                    <tbody>
                      {metaData.ContentType && <tr><td class="meta-key">Content-Type</td><td class="meta-val">{metaData.ContentType}</td></tr>}
                      {metaData.ContentLength != null && <tr><td class="meta-key">Size</td><td class="meta-val">{formatBytes(metaData.ContentLength)}</td></tr>}
                      {metaData.LastModified && <tr><td class="meta-key">Last Modified</td><td class="meta-val">{new Date(metaData.LastModified).toLocaleString()}</td></tr>}
                      {metaData.ETag && <tr><td class="meta-key">ETag</td><td class="meta-val meta-mono">{metaData.ETag}</td></tr>}
                      {metaData.StorageClass && <tr><td class="meta-key">Storage Class</td><td class="meta-val">{metaData.StorageClass}</td></tr>}
                      {metaData.VersionId && <tr><td class="meta-key">Version ID</td><td class="meta-val meta-mono">{metaData.VersionId}</td></tr>}
                      {custom.map(([k, v]) => (
                        <tr key={k}><td class="meta-key">x-amz-meta-{k}</td><td class="meta-val">{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost btn-sm" onClick={() => setMetaItem(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {previewItem && (() => {
        const kind = resolvedKind;
        return (
          <div class="modal-overlay" onClick={closePreview}>
            <div class="modal-dialog preview-dialog" onClick={e => e.stopPropagation()}>
              <div class="modal-title preview-title">
                <span class="preview-filename" title={previewItem.Key}>{leafName(previewItem.Key)}</span>
                {previewableItems.length > 1 && previewIdx !== -1 && (
                  <span class="preview-counter">{previewIdx + 1} / {previewableItems.length}</span>
                )}
                <button class="preview-close" onClick={closePreview} aria-label="Close">✕</button>
              </div>
              <div class="preview-body">
                {/* Buttons only for non-image media (audio, video) */}
                {previewableItems.length > 1 && previewIdx !== -1 && kind !== 'image' && (
                  <button class="preview-nav" onClick={() => navigatePreviewRef.current(-1)} disabled={!prevPreviewItem} aria-label="Previous">‹</button>
                )}
                <div class="preview-content">
                  {/* Transparent tap zones for image navigation (left/right half) */}
                  {previewableItems.length > 1 && previewIdx !== -1 && kind === 'image' && previewUrl && (
                    <>
                      <div class="preview-tap-zone preview-tap-prev" onClick={() => navigatePreviewRef.current(-1)} style={!prevPreviewItem ? { pointerEvents: 'none' } : undefined} aria-label="Previous" />
                      <div class="preview-tap-zone preview-tap-next" onClick={() => navigatePreviewRef.current(1)} style={!nextPreviewItem ? { pointerEvents: 'none' } : undefined} aria-label="Next" />
                    </>
                  )}
                  {!previewUrl && !previewText && !previewError && !notPreviewable && (
                    <div class="empty-state"><span class="spinner" style={{ marginRight: '.5rem' }} />Loading…</div>
                  )}
                  {notPreviewable && (
                    <div class="preview-unavailable">
                      <p>This file can't be previewed in the browser.</p>
                      {detectedContentType && (
                        <p class="preview-unavailable-type">Content-Type: <code>{detectedContentType}</code></p>
                      )}
                      <button
                        class="btn btn-ghost"
                        onClick={() => handleDownload(previewItem.Key)}
                        disabled={!canDownload || downloadingKey === previewItem.Key}
                      >
                        {downloadingKey === previewItem.Key ? <span class="spinner" /> : 'Download instead'}
                      </button>
                    </div>
                  )}
                  {previewError && (
                    <div class="modal-error">Preview failed: {previewError.message || String(previewError)}</div>
                  )}
                  {previewUrl && kind === 'image' && (
                    <img src={previewUrl} alt={leafName(previewItem.Key)} class="preview-media" />
                  )}
                  {previewUrl && kind === 'audio' && (
                    <audio controls src={previewUrl} class="preview-audio" />
                  )}
                  {previewUrl && kind === 'video' && (
                    <video controls src={previewUrl} class="preview-media" />
                  )}
                  {previewUrl && kind === 'pdf' && (
                    <iframe src={previewUrl} class="preview-pdf" title={leafName(previewItem.Key)} />
                  )}
                  {previewText !== null && kind === 'text' && (
                    <div class="preview-text-wrap">
                      <pre class="preview-text">{previewText}</pre>
                      {previewTruncated && (
                        <div class="preview-truncated">Preview limited to 100 KB — download for the full file.</div>
                      )}
                    </div>
                  )}
                </div>
                {previewableItems.length > 1 && previewIdx !== -1 && kind !== 'image' && (
                  <button class="preview-nav" onClick={() => navigatePreviewRef.current(1)} disabled={!nextPreviewItem} aria-label="Next">›</button>
                )}
              </div>
              <div class="modal-actions">
                <button class="btn btn-ghost btn-sm" onClick={closePreview}>Close</button>
                <div class="copy-link-wrap" ref={previewCopyOpen ? previewCopyWrapRef : undefined}>
                  <button class="btn btn-ghost btn-sm" onClick={() => setPreviewCopyOpen(v => !v)} disabled={!canDownload}>
                    {previewCopied ? '✓ Copied' : 'Copy link'}
                  </button>
                  {previewCopyOpen && (
                    <CopyLinkPopover
                      client={client} bucket={bucket} fileKey={previewItem.Key}
                      onClose={() => setPreviewCopyOpen(false)}
                      onCopied={() => { setPreviewCopied(true); setTimeout(() => setPreviewCopied(false), 2000); }}
                      direction="up"
                    />
                  )}
                </div>
                <button class="btn btn-ghost btn-sm" onClick={() => handleDownload(previewItem.Key)} disabled={!canDownload || downloadingKey === previewItem.Key}>
                  {downloadingKey === previewItem.Key ? <span class="spinner" /> : 'Download'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <Breadcrumb prefix={prefix} onNavigate={navigateTo} />

      <div class="browser-toolbar">
        {(sortedItems.length > 0 || sortedFolders.length > 0 || filterQ) && (
          <div class="filter-bar">
            <input
              class="filter-input"
              type="search"
              placeholder="Filter by name…"
              value={filterQuery}
              onInput={e => setFilterQuery(e.target.value)}
            />
            {filterQ && (
              <span class="filter-count">
                {visibleItems.length + visibleFolders.length} of {sortedItems.length + sortedFolders.length}
              </span>
            )}
          </div>
        )}
        <div class="browser-toolbar-actions">
          <button class="btn btn-ghost btn-sm" onClick={openNewFolder} title="Create a new folder">
            + New folder
          </button>
        </div>
      </div>

      {selectedKeys.size > 0 && (
        <div class="batch-bar">
          <span class="batch-count">{selectedKeys.size} selected</span>
          <button class="btn btn-ghost btn-sm" onClick={() => setSelectedKeys(new Set())}>Clear</button>
          <div class="copy-link-wrap" ref={batchCopyOpen ? batchCopyWrapRef : undefined} style={{ marginLeft: 'auto' }}>
            <button class="btn btn-ghost btn-sm" onClick={() => setBatchCopyOpen(v => !v)} disabled={!canDownload}>
              {batchCopied !== null ? `✓ ${batchCopied} link${batchCopied !== 1 ? 's' : ''} copied` : 'Copy links'}
            </button>
            {batchCopyOpen && (
              <BatchCopyLinkPopover
                client={client} bucket={bucket} keys={[...selectedKeys]}
                onClose={() => setBatchCopyOpen(false)}
                onCopied={(count) => { setBatchCopied(count); setTimeout(() => setBatchCopied(null), 2000); }}
              />
            )}
          </div>
          <button
            class="btn btn-danger btn-sm"
            onClick={() => { setBatchDeleteError(null); setBatchDeletePending(true); }}
            disabled={!canDelete}
          >
            Delete {selectedKeys.size}
          </button>
        </div>
      )}

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
        ? <div class="empty-state">{filterQ ? 'No files match the filter.' : 'This prefix is empty.'}</div>
        : (
          <table class="file-table">
            <thead>
              <tr>
                <th class="col-check">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={el => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={() => toggleSelectAll(visibleItems)}
                    title="Select all"
                  />
                </th>
                <SortTh col="name" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Name</SortTh>
                <SortTh col="size" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Size</SortTh>
                <SortTh col="modified" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Modified</SortTh>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleFolders.map(cp => (
                <tr key={cp} class="file-row" onClick={() => navigateTo(cp)} style={{ cursor: 'pointer' }}>
                  <td class="col-check" />
                  <td class="col-name">
                    <span class="file-icon">📁</span>
                    <span class="file-dir">{cp.slice(prefix.length).replace(/\/$/, '')}</span>
                  </td>
                  <td class="col-size">—</td>
                  <td class="col-modified"></td>
                  <td class="col-actions">
                    <button
                      class="btn btn-ghost btn-sm"
                      style={{ color: 'var(--text-danger)', borderColor: 'transparent' }}
                      onClick={e => handleFolderDeleteClick(cp, e)}
                      disabled={!canDelete}
                      title={!canDelete ? 'Delete not permitted with current credentials' : 'Delete folder and all contents'}
                    >✕</button>
                  </td>
                </tr>
              ))}

              {visibleItems.map(obj => {
                const display = obj.Key.slice(prefix.length);
                const isDownloading = downloadingKey === obj.Key;
                const isSelected = selectedKeys.has(obj.Key);
                return (
                  <tr key={obj.Key} class={`file-row${isSelected ? ' file-row-selected' : ''}`}>
                    <td class="col-check" onClick={e => toggleSelect(obj.Key, e)}>
                      <input type="checkbox" checked={isSelected} onChange={e => toggleSelect(obj.Key, e)} />
                    </td>
                    <td class="col-name">
                      <span class="file-icon">📄</span>
                      {renamingKey === obj.Key ? (
                        <span class="rename-inline">
                          <input
                            class="rename-input"
                            value={renameValue}
                            onInput={e => { setRenameValue(e.target.value); setRenameError(null); }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitRename(obj.Key);
                              if (e.key === 'Escape') setRenamingKey(null);
                            }}
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                          {renameError && <span class="rename-error">{renameError}</span>}
                          <button class="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); commitRename(obj.Key); }} disabled={renameSaving}>
                            {renameSaving ? <span class="spinner" /> : '✓'}
                          </button>
                          <button class="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setRenamingKey(null); }} disabled={renameSaving}>✕</button>
                        </span>
                      ) : (
                        <span
                          class="file-name file-name-previewable"
                          title={obj.Key}
                          onClick={() => handlePreview(obj)}
                        >{display}</span>
                      )}
                    </td>
                    <td class="col-size">{formatBytes(obj.Size)}</td>
                    <td class="col-modified">{formatDate(obj.LastModified)}</td>
                    <td class="col-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={e => { e.stopPropagation(); handleShowMeta(obj); }}
                        title="Properties"
                        style={{ marginRight: '.25rem' }}
                      >
                        ℹ
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={() => handlePreview(obj)}
                        title="Preview"
                        style={{ marginRight: '.25rem' }}
                      >
                        ⊙
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={e => { e.stopPropagation(); startRename(obj.Key); }}
                        title="Rename"
                        style={{ marginRight: '.25rem' }}
                      >
                        ✎
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={() => handleDownload(obj.Key)}
                        disabled={!canDownload || isDownloading}
                        title={!canDownload ? 'Download not permitted with current credentials' : 'Download'}
                        style={{ marginRight: '.25rem' }}
                      >
                        {isDownloading ? <span class="spinner" /> : '↓'}
                      </button>
                      <div
                        class="copy-link-wrap"
                        ref={tableCopyKey === obj.Key ? tableCopyWrapRef : undefined}
                      >
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick={() => setTableCopyKey(k => k === obj.Key ? null : obj.Key)}
                          disabled={!canDownload}
                          title="Copy link"
                        >
                          {tableCopied === obj.Key ? '✓' : '⎘'}
                        </button>
                        {tableCopyKey === obj.Key && (
                          <CopyLinkPopover
                            client={client} bucket={bucket} fileKey={obj.Key}
                            onClose={() => setTableCopyKey(null)}
                            onCopied={() => handleTableCopyLinkCopied(obj.Key)}
                          />
                        )}
                      </div>
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

      <HiddenVersions key={prefix} client={client} bucket={bucket} prefix={prefix} />
    </div>
  );
}
