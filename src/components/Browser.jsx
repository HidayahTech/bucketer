// Copyright (C) 2026 HidayahTech, LLC
// Object browser — listing, navigation, sorting, filter, preview, download, delete,
// rename, batch operations, drag-and-drop, and browser history (§4.2, §4.4, §4.7, §4.12).
//
// Reports capability discoveries (permitted/denied) back to App via onCapabilityChange.
// Notifies App when the initial listing probe fails via onInitialListFailed (§4.14).
// Coordinates with UploadQueue via onUploadTargetChange (upload destination = current prefix).
import { useState, useEffect, useRef } from 'preact/hooks';
import { ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { formatBytes, leafName, isPermissionError } from '../lib/format.js';
import { defaultMaxKeys } from '../lib/provider.js';
import { loadMaxKeys, loadListingCacheTTL } from '../lib/storage.js';
import { pushPrefixHistory } from '../lib/url-params.js';
import { mediaKind, mimeType, mimeKind } from '../lib/media.js';
import { collectFileEntries } from '../lib/file-entries.js';
import { ErrorBlock } from './ErrorBlock.jsx';
import { HiddenVersions } from './HiddenVersions.jsx';

// 1 hour: long enough for interactive use (preview, copy-link) but short enough that
// a leaked presigned URL expires overnight without manual rotation.
const PRESIGN_EXPIRES = 3600;

// Range-limited to 100 KB to prevent loading multi-GB log files into browser memory.
// Response status 206 (Partial Content) indicates truncation — the UI shows a warning.
const TEXT_PREVIEW_LIMIT = 100 * 1024;

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

// State is organized by concern — each interactive feature has its own slice.
// selectedKeys and selectedPrefixes are Sets for O(1) has() checks per row.
// Delete operations are owned by App.jsx (via onDeleteRequest) so they survive navigation.
// cacheRef and abortRef are Refs (not state) to avoid triggering re-renders.
export function Browser({ client, bucket, provider, credentials, onCapabilityChange, capabilities, onUploadTargetChange, onInitialListFailed, onExternalDrop, onDeleteRequest, onMount, prefetchSizeLimit, isFirstMount }) {
  const [prefix, setPrefix] = useState(() => {
    if (isFirstMount) {
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
  const [selectedPrefixes, setSelectedPrefixes] = useState(new Set());
  const [previewItem, setPreviewItem] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [resolvedKind, setResolvedKind] = useState(null);
  const [notPreviewable, setNotPreviewable] = useState(false);
  const [detectedContentType, setDetectedContentType] = useState(null);
  const [previewText, setPreviewText] = useState(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewPixelated, setPreviewPixelated] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState(new Set());
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
  const cacheRef = useRef(new Map());
  const previewUrlCacheRef = useRef(new Map()); // key → { url, expiresAt, kind, contentType, text?, truncated? }
  const prefetchGenRef     = useRef(0);          // incremented on each prefetch call to abandon stale runs
  const prevNextRef        = useRef({ prev: null, next: null }); // kept current during render for the prefetch effect
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
  const cacheTTL = loadListingCacheTTL() ?? 120; // seconds; 0 = off

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  useEffect(() => { onMount?.({ removeItems, invalidateCache }); }, []);

  // Notify parent of current prefix so upload queue knows where to target
  useEffect(() => {
    if (onUploadTargetChange) onUploadTargetChange(prefix);
  }, [prefix]);

  // Navigate to a new prefix — flush state and push a browser history entry (§4.7, §4.14)
  function navigateTo(newPrefix, { historyMode = 'push' } = {}) {
    if (abortRef.current) abortRef.current.abort();
    // Save current listing to cache before leaving (skip for initial replace-navigation)
    if (cacheTTL > 0 && historyMode !== 'replace' && (items.length > 0 || commonPrefixes.length > 0)) {
      cacheRef.current.set(prefix, { items, commonPrefixes, isTruncated, continuationToken, timestamp: Date.now() });
    }
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
    setSelectedPrefixes(new Set());
    setBatchCopyOpen(false);
    setBatchCopied(null);
    previewUrlCacheRef.current.clear();
    fetchPage(newPrefix, null, true);
  }
  navigateRef.current = navigateTo;

  const isInitialProbeRef = useRef(true);

  // Listing cache (D-7): session-scoped in-memory Map keyed by prefix. On initial navigation
  // (replace=true, no token), check the cache first. Cache hit: restore all pagination state
  // atomically (items + prefixes + token + isTruncated). Cache miss: fetch from S3.
  // Cache is NOT used for Load More (pagination) — only for navigating back to a prefix.
  // Mutations (delete, rename, upload, folder create) call invalidateCache() to prevent stale views.
  async function fetchPage(targetPrefix, token, replace = false) {
    // Serve from cache on initial navigation (not pagination)
    if (replace && !token && cacheTTL > 0) {
      const cached = cacheRef.current.get(targetPrefix);
      if (cached && (Date.now() - cached.timestamp) < cacheTTL * 1000) {
        setItems(cached.items);
        setCommonPrefixes(cached.commonPrefixes);
        setContinuationToken(cached.continuationToken);
        setIsTruncated(cached.isTruncated);
        setListError(null);
        isInitialProbeRef.current = false;
        return;
      }
    }

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
      // isInitialProbeRef gates a single call to onInitialListFailed (§4.14).
      // Only the very first listing failure triggers App to switch to 'failed' session state.
      // Subsequent errors (e.g., manual retry) do not re-trigger that transition.
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

  function toggleSelectAll(visFolders, visFiles) {
    const allSelected =
      (visFiles.length > 0 || visFolders.length > 0) &&
      visFiles.every(o => selectedKeys.has(o.Key)) &&
      visFolders.every(cp => selectedPrefixes.has(cp));
    if (allSelected) {
      setSelectedKeys(new Set());
      setSelectedPrefixes(new Set());
    } else {
      setSelectedKeys(new Set(visFiles.map(o => o.Key)));
      setSelectedPrefixes(new Set(visFolders));
    }
  }

  function toggleSelectPrefix(cp, e) {
    e.stopPropagation();
    setSelectedPrefixes(prev => {
      const next = new Set(prev);
      if (next.has(cp)) next.delete(cp); else next.add(cp);
      return next;
    });
  }

  function removeItems(keys, prefixes) {
    const keySet    = new Set(keys);
    const prefixSet = new Set(prefixes);
    if (keySet.size)    setItems(prev => prev.filter(o => !keySet.has(o.Key)));
    if (prefixSet.size) setCommonPrefixes(prev => prev.filter(p => !prefixSet.has(p)));
    if (keySet.size)    setSelectedKeys(prev => prev.size ? new Set([...prev].filter(k => !keySet.has(k))) : prev);
    if (prefixSet.size) setSelectedPrefixes(prev => prev.size ? new Set([...prev].filter(p => !prefixSet.has(p))) : prev);
  }

  // dragCounterRef debounces nested dragenter/dragleave. The HTML5 spec fires dragenter for
  // every element the cursor crosses (including children), so without counting, the drop
  // overlay would flicker as the cursor moves across table rows. Counter hits 0 only when
  // the user has fully exited the drop target.
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

  // S3 has no rename. Rename = CopyObject + DeleteObject.
  // Copy FIRST: if copy fails, the original is untouched. MetadataDirective: 'COPY' preserves
  // Content-Type and custom metadata — the default 'REPLACE' would strip them.
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
      invalidateCache(prefix);
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

  // Download via presigned URL — transfers entirely via browser's download manager with no
  // JS buffering. ResponseContentDisposition: 'attachment' forces a download with the correct
  // leaf filename; without it, the browser would try to open image/video files inline.
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

  // Preview: detects kind via HeadObject → ContentType first, extension second.
  // SECURITY: text previews always use ResponseContentType='text/plain; charset=utf-8'
  // regardless of the stored ContentType. This prevents an uploaded HTML or JS file from
  // being rendered by the browser — the preview always shows raw source text.
  async function handlePreview(obj) {
    setPreviewItem(obj);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewTruncated(false);
    setPreviewPixelated(false);
    setPreviewError(null);
    setResolvedKind(null);
    setNotPreviewable(false);
    setDetectedContentType(null);
    setPreviewCopyOpen(false);
    setPreviewCopied(false);
    try {
      // Check signed-URL cache first. URLs are valid for PRESIGN_EXPIRES seconds;
      // we treat entries as stale 5 minutes early to avoid serving nearly-expired URLs.
      const cached = previewUrlCacheRef.current.get(obj.Key);
      if (cached && Date.now() < cached.expiresAt) {
        setResolvedKind(cached.kind);
        if (cached.kind === 'text') {
          if (cached.text !== undefined) {
            setPreviewText(cached.text);
            setPreviewTruncated(cached.truncated ?? false);
          } else {
            const resp = await fetch(cached.url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } });
            setPreviewText(await resp.text());
            setPreviewTruncated(resp.status === 206);
          }
        } else {
          setPreviewUrl(cached.url);
        }
        return;
      }

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

      const expiresAt = Date.now() + (PRESIGN_EXPIRES - 300) * 1000;

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
        previewUrlCacheRef.current.set(obj.Key, { url, expiresAt, kind, contentType });
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
        previewUrlCacheRef.current.set(obj.Key, { url, expiresAt, kind, contentType });
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
    setPreviewPixelated(false);
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

  // Prefetch adjacent items after the current one is ready.
  // prevNextRef is updated during render so the effect always sees the latest neighbours
  // without needing them as deps (which would cause spurious re-runs on every listing change).
  useEffect(() => {
    if (!previewUrl && !previewText) return;
    prefetchAdjacent(prevNextRef.current.prev, prevNextRef.current.next);
  }, [previewUrl, previewText, prefetchSizeLimit]);

  async function prefetchAdjacent(prev, next) {
    const gen = ++prefetchGenRef.current;

    for (const item of [prev, next].filter(Boolean)) {
      if (gen !== prefetchGenRef.current) return;

      const cached = previewUrlCacheRef.current.get(item.Key);
      if (cached && Date.now() < cached.expiresAt) continue;

      // Level 1: HeadObject + signed URL
      let kind, contentType, contentLength;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.Key }));
        contentType  = head.ContentType || '';
        contentLength = head.ContentLength ?? null;
        kind = mimeKind(contentType) || mediaKind(item.Key);
        if (!mimeKind(contentType) && mediaKind(item.Key)) contentType = mimeType(item.Key) || contentType;
      } catch {
        contentType   = mimeType(item.Key) || '';
        contentLength = null;
        kind          = mediaKind(item.Key);
      }
      if (!kind) continue;
      if (gen !== prefetchGenRef.current) return;

      const expiresAt = Date.now() + (PRESIGN_EXPIRES - 300) * 1000;

      if (kind === 'text') {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: item.Key, ResponseContentDisposition: 'inline', ResponseContentType: 'text/plain; charset=utf-8' }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        const entry = { url, expiresAt, kind, contentType };
        previewUrlCacheRef.current.set(item.Key, entry);
        // Level 2: fetch text body (range-limited, always cheap)
        if (gen !== prefetchGenRef.current) return;
        try {
          const resp = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } });
          if (gen !== prefetchGenRef.current) return;
          previewUrlCacheRef.current.set(item.Key, { ...entry, text: await resp.text(), truncated: resp.status === 206 });
        } catch { /* silent — cache hit already has the URL */ }
      } else {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: item.Key, ResponseContentDisposition: 'inline', ...(contentType ? { ResponseContentType: contentType } : {}) }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        previewUrlCacheRef.current.set(item.Key, { url, expiresAt, kind, contentType });
        // Level 2: trigger image download if within size limit
        if (kind === 'image' && prefetchSizeLimit > 0 && (contentLength === null || contentLength <= prefetchSizeLimit)) {
          if (gen !== prefetchGenRef.current) return;
          const img = new Image();
          img.src = url;
        }
      }
    }
  }

  function invalidateCache(p) {
    cacheRef.current.delete(p);
  }

  function handleRefresh() {
    if (abortRef.current) abortRef.current.abort();
    invalidateCache(prefix);
    setItems([]);
    setCommonPrefixes([]);
    setContinuationToken(null);
    setIsTruncated(false);
    setListError(null);
    fetchPage(prefix, null, true);
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
      invalidateCache(prefix);
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
  const allVisibleSelected =
    (visibleItems.length > 0 || visibleFolders.length > 0) &&
    visibleItems.every(o => selectedKeys.has(o.Key)) &&
    visibleFolders.every(cp => selectedPrefixes.has(cp));
  const someVisibleSelected = !allVisibleSelected && (
    visibleItems.some(o => selectedKeys.has(o.Key)) ||
    visibleFolders.some(cp => selectedPrefixes.has(cp))
  );

  // Preview navigation — ordered to match the current display sort.
  // Includes extension-less files since they may have a previewable ContentType.
  const previewableItems = visibleItems.filter(obj => mediaKind(obj.Key) || !leafName(obj.Key).includes('.'));
  const previewIdx = previewItem ? previewableItems.findIndex(o => o.Key === previewItem.Key) : -1;
  const prevPreviewItem = previewIdx > 0 ? previewableItems[previewIdx - 1] : null;
  const nextPreviewItem = previewIdx >= 0 && previewIdx < previewableItems.length - 1 ? previewableItems[previewIdx + 1] : null;
  prevNextRef.current = { prev: prevPreviewItem, next: nextPreviewItem };
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
        const kind = resolvedKind ?? mediaKind(previewItem.Key);
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
                <div class={`preview-content${kind === 'audio' ? ' preview-content--audio' : ''}`}>
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
                    <img
                      src={previewUrl}
                      alt={leafName(previewItem.Key)}
                      class={`preview-media${previewPixelated ? ' preview-media--pixelated' : ''}`}
                      onLoad={e => setPreviewPixelated(e.target.naturalWidth < 128 && e.target.naturalHeight < 128)}
                    />
                  )}
                  {previewUrl && kind === 'audio' && (
                    <audio controls src={previewUrl} class="preview-audio" />
                  )}
                  {previewUrl && kind === 'video' && (
                    <video controls src={previewUrl} class="preview-media" />
                  )}
                  {previewUrl && kind === 'pdf' && (
                    <iframe src={previewUrl} class="preview-pdf" title={leafName(previewItem.Key)} sandbox="" />
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
          <button class="btn btn-ghost btn-sm" onClick={handleRefresh} title="Refresh listing" style={{ marginRight: '.25rem' }}>
            ↺
          </button>
          <button class="btn btn-ghost btn-sm" onClick={openNewFolder} title="Create a new folder">
            + New folder
          </button>
        </div>
      </div>

      {(selectedKeys.size > 0 || selectedPrefixes.size > 0) && (
        <div class="batch-bar">
          <span class="batch-count">
            {[
              selectedKeys.size > 0 && `${selectedKeys.size} file${selectedKeys.size !== 1 ? 's' : ''}`,
              selectedPrefixes.size > 0 && `${selectedPrefixes.size} folder${selectedPrefixes.size !== 1 ? 's' : ''}`,
            ].filter(Boolean).join(', ')} selected
          </span>
          <button class="btn btn-ghost btn-sm" onClick={() => { setSelectedKeys(new Set()); setSelectedPrefixes(new Set()); }}>Clear</button>
          {selectedKeys.size > 0 && (
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
          )}
          <button
            class="btn btn-danger btn-sm"
            style={selectedKeys.size === 0 ? { marginLeft: 'auto' } : undefined}
            onClick={() => onDeleteRequest({ files: [...selectedKeys], prefixes: [...selectedPrefixes], capturedPrefix: prefix })}
            disabled={!canDelete}
          >
            Delete {selectedKeys.size + selectedPrefixes.size}
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
        ? <div class="empty-state">{filterQ ? 'No files match the filter.' : !prefix ? 'This bucket is empty. Upload files to get started.' : 'This prefix is empty.'}</div>
        : (
          <table class="file-table">
            <thead>
              <tr>
                <th class="col-check">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={el => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={() => toggleSelectAll(visibleFolders, visibleItems)}
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
              {visibleFolders.map(cp => {
                const isFolderSelected = selectedPrefixes.has(cp);
                return (
                  <tr key={cp} class={`file-row${isFolderSelected ? ' file-row-selected' : ''}`} onClick={() => navigateTo(cp)} style={{ cursor: 'pointer' }}>
                    <td class="col-check" onClick={e => toggleSelectPrefix(cp, e)}>
                      <input type="checkbox" checked={isFolderSelected} onChange={e => toggleSelectPrefix(cp, e)} onClick={e => e.stopPropagation()} />
                    </td>
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
                        onClick={e => { e.stopPropagation(); onDeleteRequest({ files: [], prefixes: [cp], capturedPrefix: prefix }); }}
                        disabled={!canDelete}
                        title={!canDelete ? 'Delete not permitted with current credentials' : 'Delete folder and all contents'}
                      >✕</button>
                    </td>
                  </tr>
                );
              })}

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
                        onClick={() => onDeleteRequest({ files: [obj.Key], prefixes: [], capturedPrefix: prefix })}
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

      <HiddenVersions key={prefix} client={client} bucket={bucket} prefix={prefix} provider={provider} />
    </div>
  );
}
