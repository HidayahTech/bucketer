// Copyright (C) 2026 HidayahTech, LLC
// Upload engine (REQ-4, REQ-8, §4.6, §4.15).
//
// Routing: files < 5 MiB → single PutObjectCommand; ≥ 5 MiB → manual multipart.
//
// Why raw SDK commands instead of lib-storage (D-2):
// CreateMultipartUploadCommand returns UploadId synchronously before any parts are sent.
// This lets us save the resume record to IndexedDB BEFORE the first UploadPartCommand —
// the critical invariant for cross-session recovery. lib-storage would require extracting
// UploadId from an httpUploadProgress event callback (fragile, timing-dependent).
//
// Cross-session resume (REQ-8, §4.15):
//   On enqueue: check IndexedDB for a resume record at the same destination.
//   If found: pause and prompt Resume or Restart.
//   Resume: verify file identity, call ListParts (provider is authoritative on ACK'd parts),
//   upload remaining parts, complete with full part list sorted by PartNumber.
//   NoSuchUpload: session expired; delete stale record and tell user to restart.
//
// File concurrency: N=3 default (D-3, configurable). Part concurrency: 4 per file (configurable).
// Peak RAM at defaults: 3 files × 4 parts × 5 MiB = 60 MiB.
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { formatBytes, formatSpeed, formatEta, isPermissionError, parseS3Error } from '../lib/format.js';
import {
  saveResumeRecord, loadResumeRecord, deleteResumeRecord,
  buildFileIdentityWithHash, fileIdentityMatches, computeFileHash,
  uploadExpiryWarningMs,
  markUploadActive, markUploadInactive, isUploadActiveElsewhere,
  saveUploadLogEntry,
} from '../lib/indexeddb.js';
import { UploadQueue as Queue, calcPartSize, collectParts, preparePutBody } from '../lib/upload-queue.js';
import { loadPartConcurrency, loadPartSizeMB, loadFileConcurrency } from '../lib/storage.js';
import { collectFileEntries } from '../lib/file-entries.js';
import { ErrorBlock } from './ErrorBlock.jsx';

const MULTIPART_THRESHOLD       = 5 * 1024 * 1024;   // 5 MiB — internal threshold, above the 5 MB spec minimum
const LARGE_FILE_WARN           = 50 * 1024 * 1024 * 1024; // 50 GB — recommend native tools (§4.6)
const DEFAULT_FILE_CONCURRENCY  = 3;
const PART_CONCURRENCY          = 4; // concurrent part uploads per file (peak memory: 4 × partSize)

// Status: queued | uploading | paused | resuming | done | error | aborted
let _idCounter = 0;
function newId() { return ++_idCounter; }

export function UploadQueue({ client, bucket, provider, currentPrefix, credentials, onCapabilityChange, capabilities, onUploadsComplete, onLogEntry, onMount }) {
  const [items, setItems] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const queueRef = useRef(new Queue(loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY));
  const activeUploadsRef = useRef({}); // id → { abort, uploadInstance }
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const notifAskedRef = useRef(false);
  const notifSuppressedRef = useRef(false);
  const [notifSuppressed, setNotifSuppressed] = useState(false);

  function toggleNotifSuppressed() {
    const next = !notifSuppressedRef.current;
    notifSuppressedRef.current = next;
    setNotifSuppressed(next);
  }

  const canUpload = capabilities.upload !== 'denied';
  const hadActiveRef = useRef(false);

  const [destinationPrefix, setDestinationPrefix] = useState(currentPrefix || '');
  // Keep in sync with browser navigation, but let the user override by typing
  useEffect(() => { setDestinationPrefix(currentPrefix || ''); }, [currentPrefix]);

  // Fire onUploadsComplete once when the queue fully drains (no uploading/queued items left)
  useEffect(() => {
    const hasActive = items.some(i => i.status === 'uploading' || i.status === 'resuming' || i.status === 'queued');
    if (hadActiveRef.current && !hasActive && items.length > 0) {
      onUploadsComplete?.();
    }
    hadActiveRef.current = hasActive;
  }, [items, onUploadsComplete]);

  const updateItem = useCallback((id, patch) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  }, []);

  // Expose addFiles to parent (e.g. for drop zones outside this component)
  useEffect(() => { onMount?.({ addFiles }); }, []);

  // fileEntries: Array<{ file: File, relativePath: string }>
  // relativePath preserves folder structure (e.g. "photos/2024/img.jpg").
  // For plain file picks it equals file.name.
  function addFiles(fileEntries) {
    const newItems = fileEntries.map(({ file, relativePath }) => ({
      id: newId(),
      file,
      name: relativePath,
      size: file.size,
      status: 'queued',
      progress: 0,
      bytesUploaded: 0,
      speed: 0,
      eta: null,
      error: null,
      destinationKey: (destinationPrefix && !destinationPrefix.endsWith('/') ? destinationPrefix + '/' : destinationPrefix) + relativePath,
      resumeRecord: null,
      largeFileWarningDismissed: false,
    }));
    setItems(prev => [...newItems, ...prev]);

    // Request Notification API permission on first batch (Q4 in QUESTIONS.md)
    if (!notifAskedRef.current && 'Notification' in window) {
      notifAskedRef.current = true;
      Notification.requestPermission().catch(() => {});
    }

    newItems.forEach(item => enqueueUpload(item));
  }

  // Check for a stale multipart session in IndexedDB before starting a new upload.
  // If a record exists, the previous session was interrupted. Pausing here forces the user
  // to explicitly choose Resume (continue) or Restart (abort old session) — we never
  // silently overwrite, because a restart at the wrong moment would lose the already-uploaded parts.
  async function enqueueUpload(item) {
    let existingRecord = null;
    try {
      existingRecord = await loadResumeRecord({
        provider, endpoint: credentials.endpoint,
        bucket, destinationKey: item.destinationKey,
      });
    } catch { /* IndexedDB may be unavailable */ }

    if (existingRecord) {
      updateItem(item.id, { status: 'paused', resumeRecord: existingRecord });
      return; // User must explicitly choose Resume or Restart
    }

    queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
    queueRef.current.enqueue(() => runUpload(item.id, item.file, item.destinationKey));
  }

  async function runUpload(id, file, destinationKey) {
    // Concurrent tab conflict detection (§4.15)
    if (isUploadActiveElsewhere(destinationKey)) {
      updateItem(id, {
        status: 'error',
        error: { message: `Another browser tab appears to be uploading to "${destinationKey}". Close the other tab or wait for it to finish before retrying.` },
      });
      return;
    }
    markUploadActive(destinationKey);

    updateItem(id, { status: 'uploading', error: null });
    const startTime = Date.now();

    function updateProgress(loaded, total) {
      // Average speed from upload start — stable even when multiple parts
      // complete in rapid bursts (avoids the dt-threshold problem).
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? loaded / elapsed : 0;
      const remaining = speed > 0 ? (total - loaded) / speed : null;
      updateItem(id, {
        progress: total > 0 ? (loaded / total) * 100 : 0,
        bytesUploaded: loaded,
        speed,
        eta: remaining,
      });
    }

    try {
      if (file.size < MULTIPART_THRESHOLD) {
        // Small file — single PutObjectCommand
        await uploadSmall(id, file, destinationKey, updateProgress);
      } else {
        // Large file — manual multipart with resume state
        await uploadMultipart(id, file, destinationKey, updateProgress);
      }

      const completedAt = Date.now();
      const durationSec = (completedAt - startTime) / 1000;
      updateItem(id, { status: 'done', progress: 100 });
      onCapabilityChange('upload', 'permitted');
      saveUploadLogEntry({
        fileName: file.name, destinationKey, fileSize: file.size,
        status: 'done', startedAt: startTime, completedAt, durationSec,
        avgSpeedBps: durationSec > 0 ? file.size / durationSec : null,
        errorMessage: null,
      }).then(() => onLogEntry?.()).catch(() => {});

      if ('Notification' in window && Notification.permission === 'granted' && !notifSuppressedRef.current) {
        new Notification('Upload complete', { body: `${file.name} → ${destinationKey}` });
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Upload aborted') return;
      updateItem(id, { status: 'error', error: err });
      const completedAt = Date.now();
      saveUploadLogEntry({
        fileName: file.name, destinationKey, fileSize: file.size,
        status: 'error', startedAt: startTime, completedAt,
        durationSec: (completedAt - startTime) / 1000,
        avgSpeedBps: null,
        errorMessage: err?.message || String(err),
      }).then(() => onLogEntry?.()).catch(() => {});
      if (isPermissionError(err)) {
        onCapabilityChange('upload', 'denied');
        // Non-resumable failure on multipart: abort session and clear resume record (§4.10)
        if (file.size >= MULTIPART_THRESHOLD) {
          const rec = await loadResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => null);
          if (rec) {
            await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destinationKey, UploadId: rec.uploadId })).catch(() => {});
            await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
          }
        }
      }
    } finally {
      delete activeUploadsRef.current[id];
      markUploadInactive(destinationKey);
      // Re-read concurrency so a setting change mid-queue takes effect on the
      // next _drain() call, which fires immediately after this finally block.
      queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
    }
  }

  async function uploadSmall(id, file, destinationKey, onProgress) {
    const controller = new AbortController();
    activeUploadsRef.current[id] = { abort: () => controller.abort() };

    onProgress(0, file.size);
    const body = await preparePutBody(file); // BUG-003: must be Uint8Array, not Blob
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: destinationKey, Body: body, ContentType: file.type || 'application/octet-stream' }),
      { abortSignal: controller.signal }
    );
    onProgress(file.size, file.size);
  }

  async function uploadMultipart(id, file, destinationKey, onProgress) {
    const preferredBytes = (loadPartSizeMB() ?? 5) * 1024 * 1024;
    const partSize = calcPartSize(file.size, preferredBytes);
    const totalParts = Math.ceil(file.size / partSize);

    const { UploadId: uploadId } = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: destinationKey,
      ContentType: file.type || 'application/octet-stream',
    }));

    const abortController = new AbortController();
    activeUploadsRef.current[id] = { abort: () => abortController.abort(), uploadId };

    // Save resume record before any parts so a crash mid-upload is recoverable
    try {
      const fileIdentity = await buildFileIdentityWithHash(file);
      await saveResumeRecord({
        provider, endpoint: credentials.endpoint, bucket, destinationKey,
        uploadId, partSize, fileIdentity, startedAt: Date.now(),
      });
    } catch { /* IDB may be unavailable */ }

    const parts = new Array(totalParts);
    const queue = Array.from({ length: totalParts }, (_, i) => i + 1);
    let bytesUploaded = 0;

    // Worker pool: PART_CONCURRENCY workers drain the queue concurrently,
    // giving full pipelining while bounding memory to PART_CONCURRENCY × partSize.
    async function worker() {
      for (;;) {
        const partNumber = queue.shift();
        if (partNumber === undefined) break;
        if (abortController.signal.aborted) throw new Error('Upload aborted');

        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, file.size);
        // slice→arrayBuffer: only this part's bytes live in memory at a time.
        // Raw Blob is not accepted by the SDK browser handler (calls .getReader()).
        const chunk = await file.slice(start, end).arrayBuffer();

        const resp = await client.send(
          new UploadPartCommand({
            Bucket: bucket, Key: destinationKey, UploadId: uploadId,
            PartNumber: partNumber, Body: chunk,
          }),
          { abortSignal: abortController.signal },
        );

        parts[partNumber - 1] = { PartNumber: partNumber, ETag: resp.ETag };
        bytesUploaded += end - start;
        onProgress(bytesUploaded, file.size);
      }
    }

    const concurrency = Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
    await Promise.all(Array.from({ length: concurrency }, worker));

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: destinationKey, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));

    await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
    delete activeUploadsRef.current[id];
  }

  async function handleResume(id) {
    const item = items.find(it => it.id === id);
    if (!item || !item.resumeRecord) return;

    updateItem(id, { status: 'resuming', error: null });

    const { uploadId, partSize, fileIdentity, destinationKey } = item.resumeRecord;

    // Verify file identity (§4.15)
    const file = item.file;
    if (!fileIdentityMatches(fileIdentity, file)) {
      updateItem(id, {
        status: 'error',
        error: { message: 'File does not match the resume record (name, size, or modification time differs). Please restart the upload.' },
      });
      return;
    }

    // If a content hash was stored, verify it (recommended check — catches renamed/replaced files)
    if (fileIdentity.contentHash) {
      const currentHash = await computeFileHash(file);
      if (currentHash && currentHash !== fileIdentity.contentHash) {
        updateItem(id, {
          status: 'error',
          error: { message: 'File content hash does not match the resume record. The file may have changed since the upload was started. Please restart the upload.' },
        });
        return;
      }
    }

    try {
      // ListParts is the authoritative source for which parts were ACK'd by the provider (§4.15).
      // We do not trust the local resume record's part list — the session may have continued
      // in another browser or tab.
      const completedParts = await collectParts(client, { bucket, key: destinationKey, uploadId });
      const completedNums = new Set(completedParts.map(p => p.PartNumber));

      // Calculate total parts
      const totalParts = Math.ceil(item.file.size / partSize);
      const remainingParts = [];
      for (let i = 1; i <= totalParts; i++) {
        if (!completedNums.has(i)) remainingParts.push(i);
      }

      updateItem(id, { status: 'uploading', progress: (completedParts.length / totalParts) * 100 });

      const newParts = [...completedParts];
      const abortController = new AbortController();
      activeUploadsRef.current[id] = { abort: () => abortController.abort() };

      for (const partNumber of remainingParts) {
        if (abortController.signal.aborted) throw new Error('Upload aborted');
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, item.file.size);
        const chunk = await item.file.slice(start, end).arrayBuffer();

        const partResp = await client.send(new UploadPartCommand({
          Bucket: bucket, Key: destinationKey, UploadId: uploadId,
          PartNumber: partNumber, Body: chunk,
        }), { abortSignal: abortController.signal });

        newParts.push({ PartNumber: partNumber, ETag: partResp.ETag });
        const uploaded = Math.min((partNumber) * partSize, item.file.size);
        updateItem(id, { progress: (uploaded / item.file.size) * 100, bytesUploaded: uploaded });
      }

      // Complete
      newParts.sort((a, b) => a.PartNumber - b.PartNumber);
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: destinationKey, UploadId: uploadId,
        MultipartUpload: { Parts: newParts },
      }));

      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
      updateItem(id, { status: 'done', progress: 100, resumeRecord: null });
      onCapabilityChange('upload', 'permitted');

    } catch (err) {
      // NoSuchUpload: the provider has expired or garbage-collected the multipart session.
      // Delete the stale record so the user is not offered resume again for this file.
      if (err?.Code === 'NoSuchUpload' || err?.name === 'NoSuchUpload') {
        await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
        updateItem(id, {
          status: 'error',
          resumeRecord: null,
          error: { message: 'Upload session has expired and cannot be resumed. Please restart the upload.' },
        });
      } else {
        updateItem(id, { status: 'error', error: err });
      }
    }
  }

  async function handleRestart(id) {
    const item = items.find(it => it.id === id);
    if (!item) return;

    if (item.resumeRecord) {
      try {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket, Key: item.destinationKey, UploadId: item.resumeRecord.uploadId,
        }));
      } catch { /* best effort */ }
      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey: item.destinationKey }).catch(() => {});
    }

    updateItem(id, { status: 'queued', resumeRecord: null, error: null, progress: 0 });
    queueRef.current.concurrency = loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY;
    queueRef.current.enqueue(() => runUpload(id, item.file, item.destinationKey));
  }

  function handleCancelAll() {
    // Abort all in-flight requests
    Object.values(activeUploadsRef.current).forEach(active => active?.abort?.());
    // Drop everything still waiting in the queue
    queueRef.current.clear();
    // Best-effort multipart cleanup (fire-and-forget)
    items.forEach(item => {
      const uploadId = activeUploadsRef.current[item.id]?.uploadId ?? item.resumeRecord?.uploadId;
      if (uploadId) {
        client.send(new AbortMultipartUploadCommand({
          Bucket: bucket, Key: item.destinationKey, UploadId: uploadId,
        })).catch(() => {});
      }
    });
    setItems(prev => prev.map(it =>
      (it.status === 'queued' || it.status === 'uploading' || it.status === 'resuming')
        ? { ...it, status: 'aborted' }
        : it
    ));
  }

  async function handleCancel(id) {
    const active = activeUploadsRef.current[id];
    if (active?.abort) active.abort();

    const item = items.find(it => it.id === id);
    const destinationKey = item?.destinationKey;
    // active.uploadId covers in-progress uploads; item.resumeRecord covers paused ones
    const uploadId = active?.uploadId ?? item?.resumeRecord?.uploadId;

    if (uploadId && destinationKey) {
      try {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket, Key: destinationKey, UploadId: uploadId,
        }));
      } catch (err) {
        updateItem(id, {
          status: 'error',
          error: { message: `Cancelled, but abort failed: ${err.message}. Incomplete parts may remain and accrue storage charges.` },
        });
        return;
      }
      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
    }

    setItems(prev => prev.filter(it => it.id !== id));
  }

  function handleRemove(id) {
    setItems(prev => prev.filter(it => it.id !== id));
  }

  function handleClearDone() {
    setItems(prev => prev.filter(it => it.status !== 'done' && it.status !== 'aborted'));
  }

  // beforeunload guard while any upload is active (§4.6)
  const hasActive = items.some(it => it.status === 'uploading' || it.status === 'resuming');
  useEffect(() => {
    if (!hasActive) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasActive]);

  // Page Visibility API — log when tab hides during active upload (§4.6)
  useEffect(() => {
    if (!hasActive) return;
    const handler = () => {
      if (document.hidden) {
        console.info('[Bucketer] Tab hidden during active upload — uploads continue in background.');
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [hasActive]);

  // Drop zone — supports both files and folders via the FileSystem API.
  // DataTransfer items must be read synchronously before any await.
  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (!canUpload) return;

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
      if (fileEntries.length) addFiles(fileEntries);
    } else {
      // Fallback for browsers without FileSystem API
      const files = e.dataTransfer?.files;
      if (files?.length) addFiles(Array.from(files).map(f => ({ file: f, relativePath: f.name })));
    }
  }

  return (
    <div>
      <div class="form-group" style={{ marginBottom: '.75rem' }}>
        <label>Destination folder</label>
        <input
          type="text"
          value={destinationPrefix}
          onInput={e => setDestinationPrefix(e.target.value)}
          placeholder="(root of bucket)"
          disabled={!canUpload}
        />
        <span class="hint">
          Where uploaded files will be placed. Navigating the browser updates this automatically.
          You can also type any path here — it doesn't need to exist yet.
        </span>
      </div>

      {!canUpload && (
        <div class="banner banner-warn" style={{ marginBottom: '.75rem' }}>
          <div class="banner-body">Upload not permitted with current credentials.</div>
        </div>
      )}

      <div
        class={`upload-zone${dragOver ? ' drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{ opacity: canUpload ? 1 : .5 }}
      >
        Drop files or folders here
      </div>

      <div style={{ display: 'flex', gap: '.5rem', marginTop: '.5rem' }}>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canUpload}
        >Choose files</button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => folderInputRef.current?.click()}
          disabled={!canUpload}
        >Choose folder</button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="file-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(Array.from(e.target.files).map(f => ({ file: f, relativePath: f.name })));
          e.target.value = '';
        }}
      />
      <input
        ref={(el) => { folderInputRef.current = el; if (el) el.webkitdirectory = true; }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(Array.from(e.target.files).map(f => ({
            file: f,
            relativePath: f.webkitRelativePath || f.name,
          })));
          e.target.value = '';
        }}
      />

      {items.length > 0 && (
        <div class="upload-queue" style={{ marginTop: '.75rem' }}>
          {items.length === 1 ? (
            <UploadItem
              key={items[0].id}
              item={items[0]}
              provider={provider}
              onResume={() => handleResume(items[0].id)}
              onRestart={() => handleRestart(items[0].id)}
              onCancel={() => handleCancel(items[0].id)}
              onRemove={() => handleRemove(items[0].id)}
              onDismissLargeWarn={() => updateItem(items[0].id, { largeFileWarningDismissed: true })}
            />
          ) : (
            <BatchSummary
              items={items}
              provider={provider}
              onResume={handleResume}
              onRestart={handleRestart}
              onCancel={handleCancel}
              onRemove={handleRemove}
              onDismissLargeWarn={(id) => updateItem(id, { largeFileWarningDismissed: true })}
              onClearDone={handleClearDone}
              onCancelAll={handleCancelAll}
              notifSuppressed={notifSuppressed}
              onToggleNotifs={toggleNotifSuppressed}
            />
          )}
        </div>
      )}
    </div>
  );
}

function BatchSummary({ items, provider, onResume, onRestart, onCancel, onRemove, onDismissLargeWarn, onClearDone, onCancelAll, notifSuppressed, onToggleNotifs }) {
  // Single pass — replaces 8 separate filter/reduce calls over all items
  let doneCount = 0, abortedCount = 0, queuedCount = 0, errorCount = 0;
  let totalBytes = 0, confirmedBytes = 0;
  const errorItems = [], pausedItems = [], inFlightItems = [];
  for (const i of items) {
    totalBytes += i.size;
    confirmedBytes += i.status === 'done' ? i.size : i.bytesUploaded;
    if      (i.status === 'done')                                  doneCount++;
    else if (i.status === 'aborted')                               abortedCount++;
    else if (i.status === 'queued')                                queuedCount++;
    else if (i.status === 'error')    { errorCount++; errorItems.push(i); }
    else if (i.status === 'paused')                                pausedItems.push(i);
    else if (i.status === 'uploading' || i.status === 'resuming')  inFlightItems.push(i);
  }

  const totalFiles     = items.length;
  const completedCount = doneCount;
  const overallSpeed   = inFlightItems.reduce((s, i) => s + i.speed, 0);

  const isActive = inFlightItems.length > 0;
  const hasClearable = !isActive && !queuedCount && !pausedItems.length && (doneCount + abortedCount > 0);

  const [displayedBytes, setDisplayedBytes] = useState(confirmedBytes);
  const animRef  = useRef(null);
  const speedRef = useRef(overallSpeed);
  const floorRef = useRef(confirmedBytes);

  useEffect(() => { speedRef.current = overallSpeed; }, [overallSpeed]);

  useEffect(() => {
    floorRef.current = confirmedBytes;
    setDisplayedBytes(prev => Math.max(prev, confirmedBytes));
  }, [confirmedBytes]);

  useEffect(() => {
    if (!isActive) {
      cancelAnimationFrame(animRef.current);
      setDisplayedBytes(confirmedBytes);
      return;
    }
    let last = performance.now();
    function tick(now) {
      if (document.visibilityState === 'hidden' || now - last < 66) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      setDisplayedBytes(prev =>
        Math.min(Math.max(prev + speedRef.current * dt, floorRef.current), totalBytes)
      );
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isActive, totalBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayProgress = totalBytes > 0 ? Math.min((displayedBytes / totalBytes) * 100, 100) : 0;
  const liveEta = overallSpeed > 0 ? (totalBytes - displayedBytes) / overallSpeed : null;
  const allDone = completedCount === totalFiles && errorCount === 0 && abortedCount === 0;

  const actionItems = [...errorItems, ...pausedItems];

  const [cancelPrimed, setCancelPrimed] = useState(false);
  const cancelPrimedTimer = useRef(null);

  function handleCancelAllClick() {
    if (!cancelPrimed) {
      setCancelPrimed(true);
      clearTimeout(cancelPrimedTimer.current);
      cancelPrimedTimer.current = setTimeout(() => setCancelPrimed(false), 3000);
    } else {
      clearTimeout(cancelPrimedTimer.current);
      setCancelPrimed(false);
      onCancelAll();
    }
  }

  return (
    <div class="batch-summary">
      <div class="batch-summary-top">
        <span class="batch-summary-count">
          {completedCount} / {totalFiles} files
          {queuedCount > 0 && <span class="batch-queued"> · {queuedCount} queued</span>}
          {errorCount > 0 && <span class="batch-errors"> · {errorCount} failed</span>}
        </span>
        <span class="spacer" />
        {overallSpeed > 0 && <span class="batch-speed">{formatSpeed(overallSpeed)}</span>}
        {liveEta !== null && <span class="batch-eta"> · ETA {formatEta(liveEta)}</span>}
        {(isActive || queuedCount > 0) && (
          <button
            class="btn btn-ghost btn-sm"
            style={{ marginLeft: '.4rem', color: 'var(--text-danger)' }}
            onClick={handleCancelAllClick}
          >
            {cancelPrimed ? 'Sure?' : 'Cancel all'}
          </button>
        )}
        {hasClearable && (
          <button class="btn btn-ghost btn-sm" style={{ marginLeft: '.4rem' }} onClick={onClearDone}>
            Clear done
          </button>
        )}
        {'Notification' in window && Notification.permission === 'granted' && (
          <button
            class="btn btn-ghost btn-sm"
            style={{ marginLeft: '.4rem', color: notifSuppressed ? 'var(--text-muted)' : undefined }}
            title={notifSuppressed ? 'Desktop notifications muted — click to unmute' : 'Mute desktop notifications for this queue'}
            onClick={onToggleNotifs}
          >
            {notifSuppressed ? 'Notifs off' : 'Notifs on'}
          </button>
        )}
      </div>

      <div class="progress-bar-wrap">
        <div class="progress-bar" style={{ width: `${displayProgress.toFixed(2)}%` }} />
      </div>

      <div class="batch-summary-meta">
        <span>{formatBytes(displayedBytes)} / {formatBytes(totalBytes)}</span>
        {allDone && <span class="batch-all-done" data-testid="queue-complete">✓ All complete</span>}
      </div>

      {inFlightItems.length > 0 && (
        <div class="batch-inflight">
          {inFlightItems.map(item => (
            <UploadItem
              key={item.id}
              item={item}
              provider={provider}
              onResume={() => onResume(item.id)}
              onRestart={() => onRestart(item.id)}
              onCancel={() => onCancel(item.id)}
              onRemove={() => onRemove(item.id)}
              onDismissLargeWarn={() => onDismissLargeWarn(item.id)}
            />
          ))}
        </div>
      )}

      {actionItems.length > 0 && (
        <div class="batch-inflight">
          {actionItems.map(item => (
            <UploadItem
              key={item.id}
              item={item}
              provider={provider}
              onResume={() => onResume(item.id)}
              onRestart={() => onRestart(item.id)}
              onCancel={() => onCancel(item.id)}
              onRemove={() => onRemove(item.id)}
              onDismissLargeWarn={() => onDismissLargeWarn(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadItem({ item, onResume, onRestart, onCancel, onRemove, onDismissLargeWarn, provider }) {
  const { name, size, status, bytesUploaded, speed, error, expiryWarning, resumeRecord, largeFileWarningDismissed } = item;

  // Smoothly interpolated byte counter driven by rAF — advances at the current
  // speed between real part-completion events, floored at confirmed bytes so it
  // never goes backward and capped at file size.
  const [displayedBytes, setDisplayedBytes] = useState(bytesUploaded);
  const animRef  = useRef(null);
  const speedRef = useRef(speed);
  const floorRef = useRef(bytesUploaded);

  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    floorRef.current = bytesUploaded;
    // Snap forward if confirmed bytes overtook the interpolated display
    setDisplayedBytes(prev => Math.max(prev, bytesUploaded));
  }, [bytesUploaded]);

  useEffect(() => {
    if (status !== 'uploading') {
      cancelAnimationFrame(animRef.current);
      setDisplayedBytes(bytesUploaded);
      return;
    }
    let last = performance.now();
    function tick(now) {
      if (document.visibilityState === 'hidden' || now - last < 66) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      setDisplayedBytes(prev =>
        Math.min(Math.max(prev + speedRef.current * dt, floorRef.current), size)
      );
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [status, size]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayProgress = size > 0 ? (displayedBytes / size) * 100 : 0;
  const liveEta = speed > 0 ? (size - displayedBytes) / speed : null;

  const statusLabel = {
    queued:    'Queued',
    uploading: 'Uploading…',
    resuming:  'Resuming…',
    paused:    'Paused — resume record found',
    done:      'Done',
    error:     'Failed',
    aborted:   'Cancelled',
  }[status] || status;

  const statusClass = {
    uploading: 'uploading',
    resuming:  'uploading',
    done:      'done',
    error:     'error',
    paused:    'paused',
  }[status] || '';

  const showProgress = status === 'uploading' || status === 'resuming' || status === 'done';

  return (
    <div class="upload-item">
      <div class="upload-item-header">
        <span class="upload-item-name" title={name}>{name}</span>
        <span class="upload-item-size">{formatBytes(size)}</span>
        <span class={`upload-item-status ${statusClass}`}>
          {status === 'uploading' || status === 'resuming' ? <><span class="spinner" style={{ marginRight: '.3rem' }} /></> : null}
          {statusLabel}
        </span>
        <div style={{ display: 'flex', gap: '.3rem' }}>
          {(status === 'uploading' || status === 'resuming') && (
            <button class="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          )}
          {status === 'paused' && (
            <>
              <button class="btn btn-primary btn-sm" onClick={onResume}>Resume</button>
              <button class="btn btn-ghost btn-sm" onClick={onRestart}>Restart</button>
            </>
          )}
          {status === 'error' && (
            <button class="btn btn-ghost btn-sm" onClick={onRestart}>Retry</button>
          )}
          {(status === 'done' || status === 'error' || status === 'aborted') && (
            <button class="btn btn-ghost btn-sm" onClick={onRemove}>✕</button>
          )}
        </div>
      </div>

      {showProgress && (
        <>
          <div class="progress-bar-wrap">
            <div class="progress-bar" style={{ width: `${displayProgress.toFixed(2)}%` }} />
          </div>
          <div class="upload-meta">
            <span>{Math.floor(displayedBytes).toLocaleString()} / {size.toLocaleString()} B</span>
            {status === 'uploading' && speed > 0 && (
              <span>{formatSpeed(speed)} · ETA {formatEta(liveEta)}</span>
            )}
            {status === 'done' && <span>✓ Complete</span>}
          </div>
        </>
      )}

      {/* 50 GB large file guidance — non-blocking, dismissible (§4.6) */}
      {size >= LARGE_FILE_WARN && !largeFileWarningDismissed && (
        <div class="banner banner-warn" style={{ marginTop: '.4rem', padding: '.4rem .6rem', fontSize: '.78rem' }}>
          <div class="banner-body">
            <strong>Large file ({formatBytes(size)})</strong> — For files this large, native tools like{' '}
            <code>rclone</code>, the B2 CLI, or the AWS CLI offer better reliability (checksumming,
            bandwidth throttling, and resumability outside browser constraints). You can still proceed
            in-browser, but be aware of these limitations.
          </div>
          <button class="banner-close" onClick={() => onDismissLargeWarn()}>✕</button>
        </div>
      )}

      {expiryWarning && status === 'uploading' && (
        <div class="banner banner-warn" style={{ marginTop: '.4rem', padding: '.4rem .6rem', fontSize: '.78rem' }}>
          This upload session may be approaching the provider's expiry limit. If it expires, you'll need to restart.
        </div>
      )}

      {resumeRecord && status === 'paused' && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: '.3rem' }}>
          Resume record found from {new Date(resumeRecord.startedAt).toLocaleString()}.
          Re-select the same file to resume.
        </div>
      )}

      {error && (
        <div class="upload-error-detail">
          <details open>
            <summary>Error details</summary>
            <pre>{JSON.stringify(parseS3Error(error), null, 2)}</pre>
          </details>
          {size >= MULTIPART_THRESHOLD && status === 'error' && (
            <MultipartFailureConsequence provider={provider} />
          )}
          {(error.Code === 'NoSuchUpload' || error.name === 'NoSuchUpload') && (
            <div style={{ marginTop: '.3rem' }}>
              The multipart upload session has expired. Incomplete parts have been cleaned up.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Provider-specific multipart failure consequence (§4.10)
function MultipartFailureConsequence({ provider }) {
  if (provider === 'r2') {
    return (
      <div style={{ marginTop: '.3rem' }}>
        <strong>R2:</strong> Incomplete multipart uploads are automatically aborted after 7 days — no manual cleanup needed.
      </div>
    );
  }
  if (provider === 'b2') {
    return (
      <div style={{ marginTop: '.3rem' }}>
        <strong>B2:</strong> Incomplete parts may remain and accrue storage charges until aborted.
        Check your bucket's incomplete multipart uploads and abort them via the B2 console or CLI.
        Consider setting a lifecycle rule to auto-abort incomplete uploads.
      </div>
    );
  }
  return (
    <div style={{ marginTop: '.3rem' }}>
      Incomplete multipart parts may remain on the provider and accrue storage charges.
      Check your provider's console for incomplete multipart uploads.
    </div>
  );
}
