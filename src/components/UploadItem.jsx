// Copyright (C) 2026 HidayahTech, LLC
import { formatBytes, formatSpeed, formatEta } from '../lib/format.js';
import { MULTIPART_THRESHOLD, LARGE_FILE_WARN } from '../lib/constants.js';
import { useInterpolatedProgress } from '../hooks/useInterpolatedProgress.js';
import { ErrorDetailsPanel } from './ErrorDetailsPanel.jsx';

export function UploadItem({ item, onResume, onRestart, onCancel, onRemove, onDismissLargeWarn, provider }) {
  const { name, size, status, bytesUploaded, speed, error, expiryWarning, resumeRecord, largeFileWarningDismissed } = item;

  // Smoothly interpolated byte counter — advances at the current speed between
  // real part-completion events, floored at confirmed bytes, capped at file size.
  const { displayedBytes } = useInterpolatedProgress({
    isActive: status === 'uploading',
    confirmedBytes: bytesUploaded,
    speed,
    fileSize: size,
  });

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
            resumeRecord ? (
              // A resumable failure (transient network error on multipart): Resume uploads
              // only the missing parts. Restart re-uploads the whole file (BUG-034).
              <>
                <button class="btn btn-primary btn-sm" onClick={onResume}>Resume</button>
                <button class="btn btn-ghost btn-sm" onClick={onRestart}>Restart</button>
              </>
            ) : (
              <button class="btn btn-ghost btn-sm" onClick={onRestart}>Retry</button>
            )
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
            {status === 'done' && <span>✓ Complete{speed > 0 ? ` · ${formatSpeed(speed)}` : ''}</span>}
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
        <ErrorDetailsPanel
          error={error}
          isMultipart={size >= MULTIPART_THRESHOLD}
          isError={status === 'error'}
          provider={provider}
        />
      )}
    </div>
  );
}
