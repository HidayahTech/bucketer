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
import { usePreview } from '../lib/usePreview.js';
import { Modal } from './Modal.jsx';
import { PreviewMedia } from './PreviewMedia.jsx';
import { defaultMaxKeys } from '../lib/provider.js';
import { loadMaxKeys, loadListingCacheTTL, loadFileMtimeAutoLoad } from '../lib/storage.js';
import { pushPrefixHistory } from '../lib/url-params.js';
import { mediaKind, mimeType, mimeKind } from '../lib/media.js';
import { collectFileEntries } from '../lib/file-entries.js';
import { PRESIGN_EXPIRES, TEXT_PREVIEW_LIMIT, FILE_MTIME_KEY } from '../lib/constants.js';
import { nameComparator, numericComparator } from '../lib/sort.js';
import { validateObjectName } from '../lib/validate-object-name.js';
import { ErrorBlock } from './ErrorBlock.jsx';
import { HiddenVersions } from './HiddenVersions.jsx';
import { CopyLinkPopover } from './CopyLinkPopover.jsx';
import { Breadcrumb } from './Breadcrumb.jsx';
import { SortTh } from './SortTh.jsx';
import { MovePickerModal } from './MovePickerModal.jsx';
import { dragPayload, dropAccepted } from '../lib/move-drag.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString(); } catch { return ''; }
}

// State is organized by concern — each interactive feature has its own slice.
// selectedKeys and selectedPrefixes are Sets for O(1) has() checks per row.
// Delete operations are owned by App.jsx (via onDeleteRequest) so they survive navigation.
// cacheRef and abortRef are Refs (not state) to avoid triggering re-renders.
export function Browser({ client, bucket, provider, credentials, onCapabilityChange, capabilities, onUploadTargetChange, onInitialListFailed, onExternalDrop, onDeleteRequest, onMoveRequest, onMount, prefetchSizeLimit, isFirstMount }) {
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
  const {
    previewItem, previewUrl, previewError,
    resolvedKind, notPreviewable, detectedContentType,
    previewText, previewTruncated, previewPixelated, setPreviewPixelated,
    previewCopyOpen, setPreviewCopyOpen, previewCopied, setPreviewCopied,
    previewUrlCacheRef, previewCopyWrapRef,
    handlePreview, closePreview,
  } = usePreview(client, bucket);
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
  // Non-null while the move destination picker is open; holds the selection being moved
  // ({ files: [{key, size}], prefixes: [pfx] }). Captured at open time so it is stable
  // even if the underlying selection changes.
  const [moveSel, setMoveSel] = useState(null);
  // Drag-and-drop move: the payload ({ files, prefixes, fromSelection }) of an in-progress
  // internal drag (a ref — not reactive — so dragover/drop handlers read it without re-renders),
  // and the prefix of the drop target currently under the cursor (drives the highlight).
  const internalDragRef = useRef(null);
  const [dndHoverTarget, setDndHoverTarget] = useState(null);
  const abortRef = useRef(null);
  const cacheRef = useRef(new Map());
  const prefetchGenRef = useRef(0); // incremented on each prefetch call to abandon stale runs
  const prevNextRef    = useRef({ prev: null, next: null }); // kept current during render for the prefetch effect
  const tableCopyWrapRef = useRef(null);
  const batchCopyWrapRef = useRef(null);
  // Always-current reference to navigateTo for the popstate handler (which has [] deps)
  const navigateRef = useRef(null);
  // Always-current reference to preview navigator, updated after sortedItems is computed
  const navigatePreviewRef = useRef(null);
  // Capture the prefix value at mount time for the initial history replaceState
  const initialPrefixRef = useRef(prefix);
  // Live mirror of the current prefix, so actions exposed via onMount (captured once
  // at mount with [] deps) can read the up-to-date value without stale-closure bugs.
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  // cacheKey = `${bucket}:${Key}:${lastModifiedMs}` — includes S3 LastModified for auto-invalidation on file replace
  const fileMtimeCacheRef = useRef(new Map());
  const [, setMtimeCacheVer] = useState(0);
  const [mtimeLoadEnabled, setMtimeLoadEnabled] = useState(() => loadFileMtimeAutoLoad());
  const [isMtimeLoading, setIsMtimeLoading] = useState(false);

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

  useEffect(() => { onMount?.({ removeItems, invalidateCache, onUploadsDrained }); }, []);

  // Called by App when an upload batch fully drains. prefixSet is the set of
  // parent prefixes that received at least one successful upload. We invalidate
  // their cached listings so a later navigation back shows the new files, and
  // refetch only if the user is currently viewing one of those prefixes (BUG-029).
  // Previously: App incremented browserKey, which remounted Browser and reset
  // the view to root, losing prefix, URL hash, selection, filter — even when
  // the user had navigated away from the upload target during the upload.
  function onUploadsDrained(prefixSet) {
    if (!prefixSet || prefixSet.size === 0) return;
    for (const p of prefixSet) invalidateCache(p);
    if (prefixSet.has(prefixRef.current)) fetchPage(prefixRef.current, null, true);
  }

  // Reset file-mtime state when the user switches buckets
  useEffect(() => {
    fileMtimeCacheRef.current = new Map();
    setMtimeCacheVer(0);
    setIsMtimeLoading(false);
  }, [bucket]);

  // Notify parent of current prefix so upload queue knows where to target
  useEffect(() => {
    if (onUploadTargetChange) onUploadTargetChange(prefix);
  }, [prefix]);

  // File-mtime opt-in loading via IntersectionObserver.
  // Only active when mtimeLoadEnabled is true (user clicked header or setting is on).
  // Observes [data-mtime-key] cells; IntersectionObserver fires immediately for visible ones.
  // Two-level cache: L1 session ref, L2 localStorage (key includes S3 LastModified for
  // automatic invalidation when a file is replaced).
  useEffect(() => {
    if (!mtimeLoadEnabled || !client || !bucket) return;
    let cancelled = false;
    const queue = [];
    let active = 0;

    function flush() {
      while (queue.length && active < 3) {
        const { Key, cacheKey } = queue.shift();
        active++;
        client.send(new HeadObjectCommand({ Bucket: bucket, Key }))
          .then(head => {
            const mtime = head.Metadata?.[FILE_MTIME_KEY] ?? null;
            fileMtimeCacheRef.current.set(cacheKey, mtime);
            try { localStorage.setItem('bucketer:mtime:' + cacheKey, mtime ?? ''); } catch {}
          })
          .catch(() => {
            fileMtimeCacheRef.current.set(cacheKey, null);
            try { localStorage.setItem('bucketer:mtime:' + cacheKey, ''); } catch {}
          })
          .finally(() => {
            active--;
            if (!cancelled) {
              flush();
              setMtimeCacheVer(v => v + 1);
              if (active === 0 && queue.length === 0) setIsMtimeLoading(false);
            }
          });
      }
    }

    function enqueue(Key, lastModifiedMs) {
      const cacheKey = `${bucket}:${Key}:${lastModifiedMs}`;
      if (fileMtimeCacheRef.current.has(cacheKey)) return; // L1 hit
      let stored = null;
      try { stored = localStorage.getItem('bucketer:mtime:' + cacheKey); } catch {}
      if (stored !== null) {
        // L2 hit — warm L1 and trigger a re-render without a HeadObject call
        fileMtimeCacheRef.current.set(cacheKey, stored === '' ? null : stored);
        setMtimeCacheVer(v => v + 1);
        return;
      }
      if (!queue.some(e => e.cacheKey === cacheKey)) {
        queue.push({ Key, cacheKey });
        if (active === 0 && queue.length === 1) setIsMtimeLoading(true);
        flush();
      }
    }

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const Key = entry.target.dataset.mtimeKey;
        const lastModifiedMs = Number(entry.target.dataset.mtimeLm);
        if (Key && lastModifiedMs) enqueue(Key, lastModifiedMs);
      }
    }, { rootMargin: '100px 0px' });

    document.querySelectorAll('[data-mtime-key]').forEach(el => observer.observe(el));

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [mtimeLoadEnabled, items, bucket]);

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
    // Only OS file drags (upload) raise the table overlay. Internal object-move drags carry
    // 'application/x-bucketer-move', not 'Files', and must not trigger the upload affordance.
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    if (onExternalDrop) setTableDragOver(true);
  }

  function handleTableDragLeave() {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setTableDragOver(false);
  }

  function handleTableDrop(e) {
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
      collectFileEntries(fsEntries).then(fileEntries => {
        if (fileEntries.length) onExternalDrop(fileEntries);
      }).catch(() => {});
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
    const nameErr = validateObjectName(newName);
    if (nameErr) { setRenameError(nameErr); return; }
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
    const nameErr = validateObjectName(name);
    if (nameErr) { setNewFolderError(nameErr); return; }
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
  // A move is a copy (write) + delete, so it needs both capabilities.
  const canMove     = capabilities.upload !== 'denied' && capabilities.delete !== 'denied';

  // Build the {key, size} list for the selected files from the current listing (Browser
  // already holds each object's Size). Used to open the move picker for the batch selection.
  function selectedFilesWithSize() {
    return [...selectedKeys].map(k => ({ key: k, size: items.find(o => o.Key === k)?.Size ?? 0 }));
  }

  function handleMoveHere(dest) {
    const sel = moveSel;
    setMoveSel(null);
    if (!sel) return;
    onMoveRequest?.({ files: sel.files, prefixes: sel.prefixes, dest, capturedPrefix: prefix });
    // Clear the multi-select once a move is underway (matches delete's row removal flow).
    setSelectedKeys(new Set());
    setSelectedPrefixes(new Set());
  }

  // ── Drag-and-drop move ────────────────────────────────────────────────────────
  // Internal object drags carry an 'application/x-bucketer-move' marker so they are told
  // apart from external OS file drags (which carry 'Files' and route to upload).
  function handleRowDragStart(dragged, e) {
    if (!canMove) return;
    internalDragRef.current = dragPayload(dragged, { files: selectedFilesWithSize(), prefixes: [...selectedPrefixes] });
    try {
      e.dataTransfer.setData('application/x-bucketer-move', '1');
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* dataTransfer unavailable (older engines) */ }
  }

  function handleRowDragEnd() {
    internalDragRef.current = null;
    setDndHoverTarget(null);
  }

  // Folder rows and breadcrumb crumbs are drop targets. Highlight + allow the drop only when
  // the structural guard accepts it (no folder-into-itself, no no-op).
  function handleTargetDragOver(dest, e) {
    const payload = internalDragRef.current;
    if (!payload || !e.dataTransfer?.types?.includes('application/x-bucketer-move')) return;
    if (dropAccepted(payload, dest)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDndHoverTarget(dest);
    } else if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none';
    }
  }

  function handleTargetDragLeave(dest) {
    setDndHoverTarget(t => (t === dest ? null : t));
  }

  function handleInternalDrop(dest, e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const payload = internalDragRef.current;
    internalDragRef.current = null;
    setDndHoverTarget(null);
    if (!payload || !dropAccepted(payload, dest)) return;
    onMoveRequest?.({ files: payload.files, prefixes: payload.prefixes, dest, capturedPrefix: prefix });
    // Only clear the selection if the whole selection was being dragged.
    if (payload.fromSelection) {
      setSelectedKeys(new Set());
      setSelectedPrefixes(new Set());
    }
  }

  // Sort folders by name only (no size/date available)
  const cmpName    = nameComparator(sortDir);
  const cmpNumeric = numericComparator(sortDir);
  const sortedFolders = [...commonPrefixes].sort((a, b) =>
    cmpName(a.slice(prefix.length).replace(/\/$/, ''), b.slice(prefix.length).replace(/\/$/, ''))
  );

  // Sort files by the selected column
  const sortedItems = items.filter(obj => !!obj.Key.slice(prefix.length)).sort((a, b) => {
    if (sortCol === 'name')     return cmpName(a.Key.slice(prefix.length), b.Key.slice(prefix.length));
    if (sortCol === 'size')     return cmpNumeric(a.Size || 0, b.Size || 0);
    if (sortCol === 'modified') {
      const tA = a.LastModified ? new Date(a.LastModified).getTime() : 0;
      const tB = b.LastModified ? new Date(b.LastModified).getTime() : 0;
      return cmpNumeric(tA, tB);
    }
    return 0;
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
      onDragOver={e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
      onDragLeave={handleTableDragLeave}
      onDrop={handleTableDrop}
      style={{ position: 'relative' }}
    >
      {tableDragOver && (
        <div class="browser-drop-overlay">Drop files to upload to this folder</div>
      )}
      {newFolderOpen && (
        <Modal onClose={() => setNewFolderOpen(false)}>
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
        </Modal>
      )}

      {moveSel && (
        <MovePickerModal
          client={client}
          bucket={bucket}
          selection={moveSel}
          onCancel={() => setMoveSel(null)}
          onMove={handleMoveHere}
        />
      )}

      {metaItem && (
        <Modal onClose={() => setMetaItem(null)} class="meta-dialog">
            <div class="modal-title" data-testid="properties-modal">File properties</div>
            <div class="modal-body">
              <p class="modal-filename" title={metaItem.Key}>{leafName(metaItem.Key)}</p>
              {metaLoading && <div class="empty-state"><span class="spinner" style={{ marginRight: '.4rem' }} />Loading…</div>}
              {metaError && <div class="modal-error">{metaError}</div>}
              {metaData && (() => {
                const fileMtime = metaData.Metadata?.[FILE_MTIME_KEY];
                const custom = Object.entries(metaData.Metadata || {}).filter(([k]) => k !== FILE_MTIME_KEY);
                return (
                  <table class="meta-table">
                    <tbody>
                      {metaData.ContentType && <tr><td class="meta-key">Content-Type</td><td class="meta-val">{metaData.ContentType}</td></tr>}
                      {metaData.ContentLength != null && <tr><td class="meta-key">Size</td><td class="meta-val">{formatBytes(metaData.ContentLength)}</td></tr>}
                      {fileMtime && <tr data-testid="meta-file-modified"><td class="meta-key">File Modified</td><td class="meta-val">{new Date(fileMtime).toLocaleString()}</td></tr>}
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
        </Modal>
      )}

      {previewItem && (() => {
        const kind = resolvedKind ?? mediaKind(previewItem.Key);
        return (
          <Modal onClose={closePreview} class="preview-dialog">
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
                  <PreviewMedia
                    kind={kind}
                    url={previewUrl}
                    text={previewText}
                    truncated={previewTruncated}
                    alt={leafName(previewItem.Key)}
                    pixelated={previewPixelated}
                    onLoad={e => setPreviewPixelated(e.target.naturalWidth < 128 && e.target.naturalHeight < 128)}
                  />
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
          </Modal>
        );
      })()}

      <Breadcrumb
        prefix={prefix}
        onNavigate={navigateTo}
        onMoveOver={handleTargetDragOver}
        onMoveLeave={handleTargetDragLeave}
        onMoveDrop={handleInternalDrop}
        moveHoverTarget={dndHoverTarget}
      />

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
                <CopyLinkPopover
                  client={client} bucket={bucket} fileKeys={[...selectedKeys]} direction="up"
                  onClose={() => setBatchCopyOpen(false)}
                  onCopied={(count) => { setBatchCopied(count); setTimeout(() => setBatchCopied(null), 2000); }}
                />
              )}
            </div>
          )}
          <button
            class="btn btn-ghost btn-sm"
            style={selectedKeys.size === 0 ? { marginLeft: 'auto' } : undefined}
            onClick={() => setMoveSel({ files: selectedFilesWithSize(), prefixes: [...selectedPrefixes] })}
            disabled={!canMove}
            title={!canMove ? 'Move needs both write and delete permissions' : 'Move to another folder'}
          >
            Move {selectedKeys.size + selectedPrefixes.size}
          </button>
          <button
            class="btn btn-danger btn-sm"
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
                <th
                  class="col-file-modified"
                  onClick={!mtimeLoadEnabled ? () => setMtimeLoadEnabled(true) : undefined}
                  title={!mtimeLoadEnabled ? 'Click to load file modification times' : undefined}
                  style={!mtimeLoadEnabled ? { cursor: 'pointer' } : undefined}
                >
                  File Modified
                  {!mtimeLoadEnabled && <span style={{ opacity: .5, marginLeft: '.3rem' }}>↓</span>}
                  {mtimeLoadEnabled && isMtimeLoading && <span class="spinner" style={{ marginLeft: '.4rem' }} />}
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleFolders.map(cp => {
                const isFolderSelected = selectedPrefixes.has(cp);
                return (
                  <tr
                    key={cp}
                    class={`file-row${isFolderSelected ? ' file-row-selected' : ''}${dndHoverTarget === cp ? ' drop-target-active' : ''}`}
                    data-testid={`folder-row:${cp.slice(prefix.length).replace(/\/$/, '')}`}
                    onClick={() => navigateTo(cp)}
                    style={{ cursor: 'pointer' }}
                    draggable={canMove}
                    onDragStart={e => handleRowDragStart({ prefix: cp }, e)}
                    onDragEnd={handleRowDragEnd}
                    onDragOver={e => handleTargetDragOver(cp, e)}
                    onDragLeave={() => handleTargetDragLeave(cp)}
                    onDrop={e => handleInternalDrop(cp, e)}
                  >
                    <td class="col-check" onClick={e => toggleSelectPrefix(cp, e)}>
                      <input type="checkbox" checked={isFolderSelected} onChange={e => toggleSelectPrefix(cp, e)} onClick={e => e.stopPropagation()} />
                    </td>
                    <td class="col-name">
                      <span class="file-icon">📁</span>
                      <span class="file-dir">{cp.slice(prefix.length).replace(/\/$/, '')}</span>
                    </td>
                    <td class="col-size">—</td>
                    <td class="col-modified"></td>
                    <td class="col-file-modified"></td>
                    <td class="col-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        style={{ marginRight: '.25rem' }}
                        onClick={e => { e.stopPropagation(); setMoveSel({ files: [], prefixes: [cp] }); }}
                        disabled={!canMove}
                        title={!canMove ? 'Move not permitted with current credentials' : 'Move folder to another folder'}
                      >↪</button>
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
                  <tr
                    key={obj.Key}
                    class={`file-row${isSelected ? ' file-row-selected' : ''}`}
                    data-testid={`file-row:${obj.Key.slice(prefix.length)}`}
                    draggable={canMove && renamingKey !== obj.Key}
                    onDragStart={e => handleRowDragStart({ fileKey: obj.Key, fileSize: obj.Size }, e)}
                    onDragEnd={handleRowDragEnd}
                  >
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
                    <td
                      class="col-file-modified"
                      data-mtime-key={obj.Key}
                      data-mtime-lm={new Date(obj.LastModified).getTime()}
                    >
                      {mtimeLoadEnabled && (() => {
                        const cacheKey = `${bucket}:${obj.Key}:${new Date(obj.LastModified).getTime()}`;
                        const cached = fileMtimeCacheRef.current.get(cacheKey);
                        if (cached === undefined) return null;
                        return cached ? formatDate(cached) : '—';
                      })()}
                    </td>
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
                        style={{ marginLeft: '.25rem' }}
                        onClick={e => { e.stopPropagation(); setMoveSel({ files: [{ key: obj.Key, size: obj.Size ?? 0 }], prefixes: [] }); }}
                        disabled={!canMove}
                        title={!canMove ? 'Move not permitted with current credentials' : 'Move to another folder'}
                      >
                        ↪
                      </button>
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
