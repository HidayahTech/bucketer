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
import { isPermissionError, parentPrefix } from '../lib/format.js';
import {
  saveResumeRecord, loadResumeRecord, deleteResumeRecord,
  buildFileIdentity, fileIdentityMatches, computeFileHash,
  uploadExpiryWarningMs,
  markUploadActive, markUploadInactive, isUploadActiveElsewhere,
  saveUploadLogEntry,
} from '../lib/indexeddb.js';
import { UploadQueue as Queue, calcPartSize, collectParts, preparePutBody, uploadPartsWithPool } from '../lib/upload-queue.js';
import { loadPartConcurrency, loadPartSizeMB, loadFileConcurrency, loadUploadExpandThreshold, loadAdaptiveMode } from '../lib/storage.js';
import { MULTIPART_THRESHOLD, DEFAULT_FILE_CONCURRENCY, PART_CONCURRENCY, ADAPTIVE_CONNECTION_BUDGET, PROBE_THRESHOLD_PARTS, MAX_ADAPTIVE_MEMORY_BYTES } from '../lib/constants.js';
import { buildUploadMetadata } from '../lib/upload-metadata.js';
import { buildContentHashValue } from '../lib/content-hash.js';
import { calcAdaptiveConcurrency, createProbeState, resolveProbe, capConcurrencyByMemory } from '../lib/concurrency-strategy.js';
import { isActive as itemIsActive, isFailed as itemIsFailed, isPaused as itemIsPaused } from '../lib/upload-status.js';
import { abortMultipartSession } from '../lib/upload-cleanup.js';
import { useDoubleClickSafety } from '../hooks/useDoubleClickSafety.js';
import { ErrorBlock } from './ErrorBlock.jsx';
import { BatchSummary } from './BatchSummary.jsx';
import { createUpdateBatcher } from '../lib/update-batcher.js';

// Status: queued | uploading | paused | resuming | done | error | aborted
let _idCounter = 0;
function newId() { return ++_idCounter; }

function debugConcurrency(...args) {
  try {
    if (localStorage.getItem('s3b_debug_concurrency') === '1') {
      console.log('[bucketer:concurrency]', ...args);
    }
  } catch { /* private browsing — skip */ }
}

export function UploadQueue({ client, bucket, provider, currentPrefix, credentials, onCapabilityChange, capabilities, onUploadsComplete, onLogEntry, onMount }) {
  const [items, setItems] = useState([]);
  const [collapsedBatches, setCollapsedBatches] = useState({});
  const queueRef = useRef(null);
  if (queueRef.current === null) {
    queueRef.current = new Queue(
      loadAdaptiveMode() ? ADAPTIVE_CONNECTION_BUDGET : (loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY)
    );
  }
  const activeUploadsRef = useRef({}); // id → { abort, uploadInstance }
  const cancelledBatchesRef = useRef(new Set());
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const notifAskedRef = useRef(false);
  const [notifSuppressed, setNotifSuppressed] = useState(false);
  const { primed: cancelAllPrimed, handleClick: handleCancelAllClick } = useDoubleClickSafety(cancelAll);

  function toggleNotifSuppressed() {
    setNotifSuppressed(prev => !prev);
  }

  const canUpload = capabilities.upload !== 'denied';
  const hadActiveRef = useRef(false);
  const lastLoggedPartsPerFileRef = useRef(null);
  // Parent prefixes of files that have completed (status='done') since the last
  // drain fire. Passed to onUploadsComplete so Browser can invalidate the right
  // listing-cache entries and refetch only when the user is actually viewing
  // an affected folder. See BUG-029.
  const drainedPrefixesRef = useRef(new Set());

  const [destinationPrefix, setDestinationPrefix] = useState(currentPrefix || '');
  // Keep in sync with browser navigation, but let the user override by typing
  useEffect(() => { setDestinationPrefix(currentPrefix || ''); }, [currentPrefix]);

  // Fire onUploadsComplete once when the queue fully drains (no uploading/queued items left).
  // Passes the set of parent prefixes that received at least one successful upload this drain
  // cycle, then resets the accumulator for the next batch.
  useEffect(() => {
    const hasActive = items.some(itemIsActive);
    if (hadActiveRef.current && !hasActive && items.length > 0) {
      const drained = drainedPrefixesRef.current;
      drainedPrefixesRef.current = new Set();
      onUploadsComplete?.(drained);
    }
    hadActiveRef.current = hasActive;
  }, [items, onUploadsComplete]);

  const batcherRef = useRef(null);
  if (batcherRef.current === null) {
    batcherRef.current = createUpdateBatcher(
      setItems,
      fn => requestAnimationFrame(fn),
      cancelAnimationFrame,
    );
  }

  const updateItem = useCallback((id, patch, urgent = false) => {
    batcherRef.current.update(id, patch, urgent);
  }, []);

  // Returns the file concurrency to assign to the queue in the current mode.
  function effectiveFileConcurrency() {
    return loadAdaptiveMode()
      ? ADAPTIVE_CONNECTION_BUDGET
      : (loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY);
  }

  // Returns the part concurrency to use when starting or resuming a multipart upload.
  // In adaptive mode, scales up as fewer files are actively uploading.
  function getEffectivePartConcurrency() {
    if (loadAdaptiveMode()) {
      const activeCount = Object.keys(activeUploadsRef.current).length;
      const { partsPerFile } = calcAdaptiveConcurrency(activeCount);
      debugConcurrency('part-concurrency', { activeCount, partsPerFile });
      return partsPerFile;
    }
    return Math.max(1, loadPartConcurrency() ?? PART_CONCURRENCY);
  }

  // Expose addFiles to parent (e.g. for drop zones outside this component)
  useEffect(() => { onMount?.({ addFiles }); }, []);

  // fileEntries: Array<{ file: File, relativePath: string }>
  // relativePath preserves folder structure (e.g. "photos/2024/img.jpg").
  // For plain file picks it equals file.name.
  function addFiles(fileEntries) {
    const batchId = String(Date.now() + Math.random());
    // Smallest-first: minimises time-to-first-completion, reduces active file count
    // quickly so the part-concurrency rebalancer kicks in sooner for large files.
    fileEntries.sort((a, b) => a.file.size - b.file.size);
    const newItems = fileEntries.map(({ file, relativePath }) => ({
      id: newId(),
      batchId,
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

    // Batches at or below the threshold start expanded; larger ones start collapsed.
    const threshold = loadUploadExpandThreshold() ?? 5;
    setCollapsedBatches(prev => ({ ...prev, [batchId]: fileEntries.length > threshold }));

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

    // Guard: batch may have been cancelled while loadResumeRecord was in flight
    if (cancelledBatchesRef.current.has(item.batchId)) return;

    if (existingRecord) {
      updateItem(item.id, { status: 'paused', resumeRecord: existingRecord }, true);
      return; // User must explicitly choose Resume or Restart
    }

    queueRef.current.concurrency = effectiveFileConcurrency();
    queueRef.current.enqueue(async () => {
      if (cancelledBatchesRef.current.has(item.batchId)) {
        updateItem(item.id, { status: 'aborted' }, true);
        return;
      }
      return runUpload(item.id, item.file, item.destinationKey);
    });
  }

  async function runUpload(id, file, destinationKey) {
    // Concurrent tab conflict detection (§4.15)
    if (isUploadActiveElsewhere(destinationKey)) {
      updateItem(id, {
        status: 'error',
        error: { message: `Another browser tab appears to be uploading to "${destinationKey}". Close the other tab or wait for it to finish before retrying.` },
      }, true);
      return;
    }
    markUploadActive(destinationKey);

    updateItem(id, { status: 'uploading', error: null }, true);
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

    let uploadAnnotation = null;

    try {
      if (file.size < MULTIPART_THRESHOLD) {
        // Small file — single PutObjectCommand
        await uploadSmall(id, file, destinationKey, updateProgress);
      } else {
        // Large file — manual multipart with resume state
        uploadAnnotation = await uploadMultipart(id, file, destinationKey, updateProgress);
      }

      const completedAt = Date.now();
      const durationSec = (completedAt - startTime) / 1000;
      updateItem(id, { status: 'done', progress: 100 }, true);
      drainedPrefixesRef.current.add(parentPrefix(destinationKey));
      onCapabilityChange('upload', 'permitted');
      debugConcurrency('file-complete', {
        file: file.name,
        size: file.size,
        mode: loadAdaptiveMode() ? 'adaptive' : 'manual',
        peakPartConcurrency: uploadAnnotation?.peakPartConcurrency ?? '(single PUT)',
        avgSpeedMbs: durationSec > 0 ? Math.round(file.size / durationSec / 1000) / 1000 : null,
        probeResult: uploadAnnotation?.probeResult ?? null,
      });
      saveUploadLogEntry({
        fileName: file.name, destinationKey, fileSize: file.size,
        status: 'done', startedAt: startTime, completedAt, durationSec,
        avgSpeedBps: durationSec > 0 ? file.size / durationSec : null,
        errorMessage: null,
        concurrencyMode:     loadAdaptiveMode() ? 'adaptive' : 'manual',
        peakPartConcurrency: uploadAnnotation?.peakPartConcurrency ?? null,
        probeResult:         uploadAnnotation?.probeResult ?? null,
      }).then(() => onLogEntry?.()).catch(() => {});

    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Upload aborted') return;
      updateItem(id, { status: 'error', error: err }, true);
      const completedAt = Date.now();
      saveUploadLogEntry({
        fileName: file.name, destinationKey, fileSize: file.size,
        status: 'error', startedAt: startTime, completedAt,
        durationSec: (completedAt - startTime) / 1000,
        avgSpeedBps: null,
        errorMessage: err?.message || String(err),
        concurrencyMode:     loadAdaptiveMode() ? 'adaptive' : 'manual',
        peakPartConcurrency: uploadAnnotation?.peakPartConcurrency ?? null,
        probeResult:         null,
      }).then(() => onLogEntry?.()).catch(() => {});
      if (isPermissionError(err)) {
        onCapabilityChange('upload', 'denied');
        // Non-resumable failure on multipart: abort session and clear resume record (§4.10)
        if (file.size >= MULTIPART_THRESHOLD) {
          const rec = await loadResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => null);
          if (rec) {
            await abortMultipartSession(client, { bucket, key: destinationKey, uploadId: rec.uploadId, provider, endpoint: credentials.endpoint });
          }
        }
      }
    } finally {
      delete activeUploadsRef.current[id];
      markUploadInactive(destinationKey);
      // Re-read concurrency so a setting change mid-queue takes effect on the
      // next _drain() call, which fires immediately after this finally block.
      queueRef.current.concurrency = effectiveFileConcurrency();
      if (loadAdaptiveMode()) {
        const activeRemaining = Object.keys(activeUploadsRef.current).length;
        const { partsPerFile } = calcAdaptiveConcurrency(activeRemaining);
        if (partsPerFile !== lastLoggedPartsPerFileRef.current) {
          lastLoggedPartsPerFileRef.current = partsPerFile;
          debugConcurrency('rebalance', {
            activeRemaining,
            fileConcurrency: queueRef.current.concurrency,
            partsPerFile,
          });
        }
      }
    }
  }

  async function uploadSmall(id, file, destinationKey, onProgress) {
    const controller = new AbortController();
    activeUploadsRef.current[id] = { abort: () => controller.abort() };

    onProgress(0, file.size);
    const body = await preparePutBody(file); // BUG-003: must be Uint8Array, not Blob
    const contentHash = await computeFileHash(file);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket, Key: destinationKey, Body: body,
        ContentType: file.type || 'application/octet-stream',
        Metadata: buildUploadMetadata(file, buildContentHashValue(contentHash)),
      }),
      { abortSignal: controller.signal }
    );
    onProgress(file.size, file.size);
  }

  async function uploadMultipart(id, file, destinationKey, onProgress) {
    const preferredBytes = (loadPartSizeMB() ?? 5) * 1024 * 1024;
    const partSize = calcPartSize(file.size, preferredBytes);
    const totalParts = Math.ceil(file.size / partSize);

    // Compute the content hash once, up front: it stamps the object metadata (a cheap
    // duplicate-detection filter) and is reused for the resume record below — avoiding a
    // second hash pass over the file.
    const contentHash = await computeFileHash(file);

    const { UploadId: uploadId } = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: destinationKey,
      ContentType: file.type || 'application/octet-stream',
      Metadata: buildUploadMetadata(file, buildContentHashValue(contentHash)),
    }));

    const abortController = new AbortController();
    activeUploadsRef.current[id] = { abort: () => abortController.abort(), uploadId };

    // Save resume record before any parts so a crash mid-upload is recoverable
    try {
      // BUG-008: the content hash must be on the identity BEFORE saveResumeRecord so a
      // crash between save and a later hash write can't leave a record without one.
      const fileIdentity = buildFileIdentity(file);
      if (contentHash) fileIdentity.contentHash = contentHash;
      await saveResumeRecord({
        provider, endpoint: credentials.endpoint, bucket, destinationKey,
        uploadId, partSize, fileIdentity, startedAt: Date.now(),
      });
    } catch { /* IDB may be unavailable */ }

    const parts = new Array(totalParts);
    const allPartNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
    let bytesUploaded = 0;

    // slice→arrayBuffer: only this part's bytes live in memory at a time.
    // Raw Blob is not accepted by the SDK browser handler (calls .getReader()).
    async function uploadPart(partNumber) {
      if (abortController.signal.aborted) throw new Error('Upload aborted');
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, file.size);
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

    // Divide the total memory budget across all concurrently-uploading files so the
    // combined ArrayBuffer footprint stays within MAX_ADAPTIVE_MEMORY_BYTES total.
    const activeCount = Object.keys(activeUploadsRef.current).length;
    const perFileBudget = Math.floor(MAX_ADAPTIVE_MEMORY_BYTES / Math.max(1, activeCount));
    const baseline = capConcurrencyByMemory(getEffectivePartConcurrency(), partSize, perFileBudget);
    const candidate = capConcurrencyByMemory(Math.min(16, baseline + 4), partSize, perFileBudget);
    const shouldProbe = loadAdaptiveMode()
      && totalParts >= PROBE_THRESHOLD_PARTS
      && candidate !== baseline;

    let probeResolved = null;
    let peakPartConcurrency = baseline;

    if (shouldProbe) {
      debugConcurrency('probe-start', { file: file.name, totalParts, baseline, candidate });

      // Warm-up: upload part 1 without timing. This establishes the HTTP/2 connection
      // to S3 and brings the file's first bytes into the browser's page cache so the
      // timed phases start from a consistent steady-state rather than a cold start.
      await uploadPartsWithPool(allPartNumbers.slice(0, 1), uploadPart, 1);

      const t1 = Date.now();
      await uploadPartsWithPool(allPartNumbers.slice(1, 4), uploadPart, baseline);
      const baselineMs = Date.now() - t1;

      const t2 = Date.now();
      await uploadPartsWithPool(allPartNumbers.slice(4, 7), uploadPart, candidate);
      const candidateMs = Date.now() - t2;

      const state = createProbeState(baseline, candidate);
      state.baselineBytes  = 3 * partSize;
      state.baselineMs     = baselineMs;
      state.candidateBytes = 3 * partSize;
      state.candidateMs    = candidateMs;
      probeResolved = resolveProbe(state);
      peakPartConcurrency = probeResolved.winner;

      debugConcurrency('probe-result', {
        baseline, candidate,
        baselineMbs: probeResolved.baselineMbs,
        candidateMbs: probeResolved.candidateMbs,
        winner: probeResolved.winner,
        inconclusive: probeResolved.inconclusive,
      });

      await uploadPartsWithPool(allPartNumbers.slice(7), uploadPart, probeResolved.winner);
    } else {
      await uploadPartsWithPool(allPartNumbers, uploadPart, baseline);
    }

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: destinationKey, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));

    await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
    delete activeUploadsRef.current[id];
    return {
      peakPartConcurrency,
      probeResult: probeResolved
        ? {
            baseline: probeResolved.baseline,
            candidate: probeResolved.candidate,
            baselineMbs: probeResolved.baselineMbs,
            candidateMbs: probeResolved.candidateMbs,
            winner: probeResolved.winner,
          }
        : null,
    };
  }

  async function handleResume(id) {
    const item = items.find(it => it.id === id);
    if (!item || !item.resumeRecord) return;

    updateItem(id, { status: 'resuming', error: null }, true);

    const { uploadId, partSize, fileIdentity, destinationKey } = item.resumeRecord;

    // Verify file identity (§4.15)
    const file = item.file;
    if (!fileIdentityMatches(fileIdentity, file)) {
      updateItem(id, {
        status: 'error',
        error: { message: 'File does not match the resume record (name, size, or modification time differs). Please restart the upload.' },
      }, true);
      return;
    }

    // If a content hash was stored, verify it (recommended check — catches renamed/replaced files)
    if (fileIdentity.contentHash) {
      const currentHash = await computeFileHash(file);
      if (currentHash && currentHash !== fileIdentity.contentHash) {
        updateItem(id, {
          status: 'error',
          error: { message: 'File content hash does not match the resume record. The file may have changed since the upload was started. Please restart the upload.' },
        }, true);
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

      updateItem(id, { status: 'uploading', progress: (completedParts.length / totalParts) * 100 }, true);

      const newParts = [...completedParts];
      const abortController = new AbortController();
      activeUploadsRef.current[id] = { abort: () => abortController.abort() };

      const activeCount = Object.keys(activeUploadsRef.current).length;
      const perFileBudget = Math.floor(MAX_ADAPTIVE_MEMORY_BYTES / Math.max(1, activeCount));
      const concurrency = capConcurrencyByMemory(getEffectivePartConcurrency(), partSize, perFileBudget);
      await uploadPartsWithPool(remainingParts, async (partNumber) => {
        if (abortController.signal.aborted) throw new Error('Upload aborted');
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, item.file.size);
        const chunk = await item.file.slice(start, end).arrayBuffer();

        const partResp = await client.send(new UploadPartCommand({
          Bucket: bucket, Key: destinationKey, UploadId: uploadId,
          PartNumber: partNumber, Body: chunk,
        }), { abortSignal: abortController.signal });

        newParts.push({ PartNumber: partNumber, ETag: partResp.ETag });
        const uploaded = Math.min(partNumber * partSize, item.file.size);
        updateItem(id, { progress: (uploaded / item.file.size) * 100, bytesUploaded: uploaded });
      }, concurrency);

      // Complete
      newParts.sort((a, b) => a.PartNumber - b.PartNumber);
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: destinationKey, UploadId: uploadId,
        MultipartUpload: { Parts: newParts },
      }));

      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
      updateItem(id, { status: 'done', progress: 100, resumeRecord: null }, true);
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
        }, true);
      } else {
        updateItem(id, { status: 'error', error: err }, true);
      }
    }
  }

  async function handleRestart(id) {
    const item = items.find(it => it.id === id);
    if (!item) return;

    if (item.resumeRecord) {
      await abortMultipartSession(client, {
        bucket, key: item.destinationKey, uploadId: item.resumeRecord.uploadId,
        provider, endpoint: credentials.endpoint,
      });
    }

    updateItem(id, { status: 'queued', resumeRecord: null, error: null, progress: 0 }, true);
    queueRef.current.concurrency = effectiveFileConcurrency();
    queueRef.current.enqueue(() => runUpload(id, item.file, item.destinationKey));
  }

  function handleCancelBatch(batchId) {
    cancelledBatchesRef.current.add(batchId);
    const batchItemIds = new Set(items.filter(i => i.batchId === batchId).map(i => i.id));
    // Abort in-flight uploads for this batch
    Object.entries(activeUploadsRef.current).forEach(([id, active]) => {
      if (batchItemIds.has(Number(id))) active?.abort?.();
    });
    // Best-effort multipart cleanup — abort the S3 session and delete the
    // resume record so a re-drag of the same folder does not show files as paused
    items.filter(i => i.batchId === batchId).forEach(item => {
      const active = activeUploadsRef.current[item.id];
      const uploadId = active?.uploadId ?? item.resumeRecord?.uploadId;
      if (uploadId) {
        abortMultipartSession(client, {
          bucket, key: item.destinationKey, uploadId,
          provider, endpoint: credentials.endpoint,
        });
      }
    });
    setItems(prev => prev.map(i =>
      i.batchId === batchId && itemIsActive(i) ? { ...i, status: 'aborted' } : i
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
        }, true);
        return;
      }
      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => {});
    }

    setItems(prev => prev.filter(it => it.id !== id));
  }

  function handleRemove(id) {
    setItems(prev => prev.filter(it => it.id !== id));
  }

  function dismissBatch(batchId) {
    setItems(prev => prev.filter(i => i.batchId !== batchId));
    setCollapsedBatches(prev => { const next = { ...prev }; delete next[batchId]; return next; });
    cancelledBatchesRef.current.delete(batchId);
  }

  function toggleBatchCollapse(batchId) {
    setCollapsedBatches(prev => ({ ...prev, [batchId]: !prev[batchId] }));
  }

  function collapseBatch(batchId) {
    setCollapsedBatches(prev => ({ ...prev, [batchId]: true }));
  }

  function expandBatch(batchId) {
    setCollapsedBatches(prev => ({ ...prev, [batchId]: false }));
  }

  function dismissAllSettled() {
    const activeOrQueued = new Set(
      items.filter(i => itemIsActive(i) || itemIsPaused(i)).map(i => i.batchId)
    );
    const toRemove = new Set([...new Set(items.map(i => i.batchId))].filter(id => !activeOrQueued.has(id)));
    setItems(prev => prev.filter(i => !toRemove.has(i.batchId)));
    setCollapsedBatches(prev => { const next = { ...prev }; toRemove.forEach(id => delete next[id]); return next; });
    toRemove.forEach(id => cancelledBatchesRef.current.delete(id));
  }

  function retryAllFailed() {
    items.filter(itemIsFailed).forEach(item => handleRestart(item.id));
  }

  function cancelAll() {
    const activeBatchIds = new Set(items.filter(itemIsActive).map(i => i.batchId));
    activeBatchIds.forEach(batchId => handleCancelBatch(batchId));
  }

  function collapseAll() {
    setCollapsedBatches(prev => {
      const next = { ...prev };
      for (const i of items) next[i.batchId] = true;
      return next;
    });
  }

  function expandAll() {
    setCollapsedBatches(prev => {
      const next = { ...prev };
      for (const i of items) next[i.batchId] = false;
      return next;
    });
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

  // Group items by batchId, preserving insertion order (newest batch first)
  const batches = [];
  const batchMap = new Map();
  for (const item of items) {
    if (!batchMap.has(item.batchId)) {
      const batchItems = [];
      batchMap.set(item.batchId, batchItems);
      batches.push([item.batchId, batchItems]);
    }
    batchMap.get(item.batchId).push(item);
  }

  // Global action bar availability flags
  const settledBatchCount = batches.filter(([, bi]) =>
    !bi.some(i => i.status === 'uploading' || i.status === 'resuming' || i.status === 'queued' || i.status === 'paused')
  ).length;
  const hasAnyFailed  = items.some(i => i.status === 'error');
  const hasAnyActive  = items.some(i => i.status === 'uploading' || i.status === 'resuming' || i.status === 'queued');
  const expandedCount = batches.filter(([id]) => !collapsedBatches[id]).length;
  const collapsedCount = batches.filter(([id]) => !!collapsedBatches[id]).length;
  const showGlobalActions = batches.length > 0 && (
    settledBatchCount >= 2 || hasAnyFailed || hasAnyActive ||
    (batches.length >= 2 && (expandedCount >= 2 || collapsedCount >= 2))
  );

  return (
    <div>
      {canUpload && (
        <>
          <div class="form-group" style={{ marginBottom: '.75rem' }}>
            <label>Destination folder</label>
            <input
              type="text"
              value={destinationPrefix}
              onInput={e => setDestinationPrefix(e.target.value)}
              placeholder="(root of bucket)"
            />
            <span class="hint">
              Where uploaded files will be placed. Navigating the browser updates this automatically.
              You can also type any path here — it doesn't need to exist yet.
            </span>
          </div>

          <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.5rem' }}>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >Choose files</button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => folderInputRef.current?.click()}
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
        </>
      )}

      {canUpload && batches.length === 0 && (
        <p class="upload-empty-hint">
          Drag files or folders anywhere in this window to upload, or use the buttons above.
        </p>
      )}

      {showGlobalActions && (
        <div class="queue-global-actions">
          <span class="queue-global-actions-label">All queues:</span>
          {settledBatchCount >= 2 && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={dismissAllSettled}>Dismiss all done</button>
          )}
          {hasAnyFailed && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={retryAllFailed}>Retry all failed</button>
          )}
          {hasAnyActive && (
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              style={{ color: cancelAllPrimed ? 'var(--text-danger)' : undefined }}
              onClick={handleCancelAllClick}
            >{cancelAllPrimed ? 'Sure?' : 'Cancel all'}</button>
          )}
          {batches.length >= 2 && expandedCount >= 2 && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={collapseAll}>Collapse all</button>
          )}
          {batches.length >= 2 && collapsedCount >= 2 && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={expandAll}>Expand all</button>
          )}
        </div>
      )}

      {batches.length > 0 && (
        <div class="upload-queue" style={{ marginTop: '.75rem' }}>
          {batches.map(([batchId, batchItems]) => (
            <BatchSummary
              key={batchId}
              items={batchItems}
              provider={provider}
              collapsed={collapsedBatches[batchId] ?? false}
              onToggleCollapse={() => toggleBatchCollapse(batchId)}
              onCollapse={() => collapseBatch(batchId)}
              onExpand={() => expandBatch(batchId)}
              onDismiss={() => dismissBatch(batchId)}
              onCancelBatch={() => handleCancelBatch(batchId)}
              onResume={handleResume}
              onRestart={handleRestart}
              onCancel={handleCancel}
              onRemove={handleRemove}
              onDismissLargeWarn={(id) => updateItem(id, { largeFileWarningDismissed: true }, true)}
              notifSuppressed={notifSuppressed}
              onToggleNotifs={toggleNotifSuppressed}
            />
          ))}
        </div>
      )}
    </div>
  );
}
