// Upload queue with multipart, resumable uploads, and concurrency (§4.6, §4.15)
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { PutObjectCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { formatBytes, formatSpeed, formatEta, isPermissionError, parseS3Error } from '../lib/format.js';
import {
  saveResumeRecord, loadResumeRecord, deleteResumeRecord,
  buildFileIdentity, fileIdentityMatches, computeFileHash,
  UPLOAD_EXPIRY_WARNING_MS,
} from '../lib/indexeddb.js';
import { UploadQueue as Queue } from '../lib/upload-queue.js';
import { ErrorBlock } from './ErrorBlock.jsx';

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
const QUEUE_CONCURRENCY = 2;

function calcPartSize(fileSize) {
  return Math.max(5 * 1024 * 1024, Math.ceil(fileSize / 10000));
}

// Status: queued | uploading | paused | resuming | done | error | aborted
let _idCounter = 0;
function newId() { return ++_idCounter; }

export function UploadQueue({ client, bucket, provider, currentPrefix, credentials, onCapabilityChange, capabilities, onUploadsComplete }) {
  const [items, setItems] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const queueRef = useRef(new Queue(QUEUE_CONCURRENCY));
  const activeUploadsRef = useRef({}); // id → { abort, uploadInstance }
  const fileInputRef = useRef(null);
  const notifAskedRef = useRef(false);

  const canUpload = capabilities.upload !== 'denied';

  const updateItem = useCallback((id, patch) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  }, []);

  function addFiles(files) {
    const newItems = Array.from(files).map(file => ({
      id: newId(),
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
      progress: 0,
      bytesUploaded: 0,
      speed: 0,
      eta: null,
      error: null,
      destinationKey: (currentPrefix || '') + file.name,
      resumeRecord: null,
    }));
    setItems(prev => [...prev, ...newItems]);

    // Request Notification API permission on first batch (Q4 in QUESTIONS.md)
    if (!notifAskedRef.current && 'Notification' in window) {
      notifAskedRef.current = true;
      Notification.requestPermission().catch(() => {});
    }

    newItems.forEach(item => enqueueUpload(item));
  }

  async function enqueueUpload(item) {
    // Check for existing resume record before starting
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

    queueRef.current.enqueue(() => runUpload(item.id, item.file, item.destinationKey));
  }

  async function runUpload(id, file, destinationKey) {
    updateItem(id, { status: 'uploading', error: null });
    const startTime = Date.now();
    let lastBytes = 0;
    let lastTime = startTime;

    function updateProgress(loaded, total) {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      const db = loaded - lastBytes;
      const speed = dt > 0.5 ? db / dt : 0;
      lastBytes = loaded;
      lastTime = now;
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
        // Large file — lib-storage multipart with resume state
        await uploadMultipart(id, file, destinationKey, updateProgress);
      }

      updateItem(id, { status: 'done', progress: 100 });
      onCapabilityChange('upload', 'permitted');

      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Upload complete', { body: `${file.name} → ${destinationKey}` });
      }
      if (onUploadsComplete) onUploadsComplete();
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Upload aborted') return;
      updateItem(id, { status: 'error', error: err });
      if (isPermissionError(err)) onCapabilityChange('upload', 'denied');
    } finally {
      delete activeUploadsRef.current[id];
    }
  }

  async function uploadSmall(id, file, destinationKey, onProgress) {
    const controller = new AbortController();
    activeUploadsRef.current[id] = { abort: () => controller.abort() };

    // Simulate progress for single-part (indeterminate — just 0 → 100 on completion)
    onProgress(0, file.size);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: destinationKey, Body: file, ContentType: file.type || 'application/octet-stream' }),
      { abortSignal: controller.signal }
    );
    onProgress(file.size, file.size);
  }

  async function uploadMultipart(id, file, destinationKey, onProgress) {
    const partSize = calcPartSize(file.size);

    const upload = new Upload({
      client,
      params: { Bucket: bucket, Key: destinationKey, Body: file, ContentType: file.type || 'application/octet-stream' },
      partSize,
      leavePartsOnError: true,
      queueSize: 4,
    });

    activeUploadsRef.current[id] = {
      abort: () => upload.abort(),
      uploadInstance: upload,
    };

    let recordSaved = false;

    upload.on('httpUploadProgress', async (progress) => {
      onProgress(progress.loaded || 0, progress.total || file.size);

      // Persist resume record on first progress event (uploadId is set by now) (§4.15)
      if (!recordSaved && upload.uploadId) {
        recordSaved = true;
        try {
          const fileIdentity = buildFileIdentity(file);
          // Compute hash async without blocking the upload
          computeFileHash(file).then(hash => {
            if (hash) fileIdentity.contentHash = hash;
          });
          await saveResumeRecord({
            provider, endpoint: credentials.endpoint, bucket, destinationKey,
            uploadId: upload.uploadId,
            partSize,
            fileIdentity,
            startedAt: Date.now(),
          });
        } catch { /* IDB may be unavailable */ }

        // Warn if record is approaching expiry (provider session limit)
        const record = await loadResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey }).catch(() => null);
        if (record && (Date.now() - record.startedAt) > UPLOAD_EXPIRY_WARNING_MS * 0.9) {
          updateItem(id, { expiryWarning: true });
        }
      }
    });

    await upload.done();

    // Clear resume record on success
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

    try {
      // List completed parts from provider (authoritative source)
      const listResp = await client.send(new ListPartsCommand({
        Bucket: bucket, Key: destinationKey, UploadId: uploadId,
      }));
      const completedParts = (listResp.Parts || []).map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
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
        const chunk = item.file.slice(start, end);

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
      if (onUploadsComplete) onUploadsComplete();

    } catch (err) {
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
    queueRef.current.enqueue(() => runUpload(id, item.file, item.destinationKey));
  }

  async function handleCancel(id) {
    const active = activeUploadsRef.current[id];
    if (active?.abort) active.abort();

    const item = items.find(it => it.id === id);
    if (item?.resumeRecord) {
      try {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket, Key: item.destinationKey, UploadId: item.resumeRecord.uploadId,
        }));
      } catch (err) {
        updateItem(id, {
          status: 'error',
          error: { message: `Cancelled, but abort failed: ${err.message}. Incomplete parts may remain and accrue storage charges.` },
        });
        return;
      }
      await deleteResumeRecord({ provider, endpoint: credentials.endpoint, bucket, destinationKey: item.destinationKey }).catch(() => {});
    }

    setItems(prev => prev.filter(it => it.id !== id));
  }

  function handleRemove(id) {
    setItems(prev => prev.filter(it => it.id !== id));
  }

  // beforeunload guard while any upload is active (§4.6)
  const hasActive = items.some(it => it.status === 'uploading' || it.status === 'resuming');
  useEffect(() => {
    if (!hasActive) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasActive]);

  // Drop zone
  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (!canUpload) return;
    const files = e.dataTransfer?.files;
    if (files?.length) addFiles(files);
  }

  return (
    <div>
      <div class="section-heading" style={{ marginBottom: '.5rem' }}>
        Upload to: <code style={{ fontWeight: 400 }}>/{currentPrefix || ''}</code>
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
        onClick={() => canUpload && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && canUpload && fileInputRef.current?.click()}
        aria-disabled={!canUpload}
        style={{ cursor: canUpload ? 'pointer' : 'not-allowed', opacity: canUpload ? 1 : .5 }}
      >
        Drop files here or click to choose
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {items.length > 0 && (
        <div class="upload-queue" style={{ marginTop: '.75rem' }}>
          {items.map(item => (
            <UploadItem
              key={item.id}
              item={item}
              onResume={() => handleResume(item.id)}
              onRestart={() => handleRestart(item.id)}
              onCancel={() => handleCancel(item.id)}
              onRemove={() => handleRemove(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadItem({ item, onResume, onRestart, onCancel, onRemove }) {
  const { name, size, status, progress, bytesUploaded, speed, eta, error, expiryWarning, resumeRecord } = item;

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
            <div class="progress-bar" style={{ width: `${progress.toFixed(1)}%` }} />
          </div>
          <div class="upload-meta">
            <span>{formatBytes(bytesUploaded)} / {formatBytes(size)}</span>
            {status === 'uploading' && speed > 0 && (
              <span>{formatSpeed(speed)} · ETA {formatEta(eta)}</span>
            )}
            {status === 'done' && <span>✓ Complete</span>}
          </div>
        </>
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
