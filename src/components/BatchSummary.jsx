// Copyright (C) 2026 HidayahTech, LLC
import { useState, useEffect, useRef } from 'preact/hooks';
import { formatBytes, formatSpeed, formatEta } from '../lib/format.js';
import { useDoubleClickSafety } from '../hooks/useDoubleClickSafety.js';
import { UploadItem } from './UploadItem.jsx';

export function BatchSummary({ items, provider, collapsed, onToggleCollapse, onCollapse, onExpand, onDismiss, onCancelBatch, onResume, onRestart, onCancel, onRemove, onDismissLargeWarn, notifSuppressed, onToggleNotifs }) {
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

  const isActive   = inFlightItems.length > 0;
  const allDone    = completedCount === totalFiles && errorCount === 0 && abortedCount === 0;
  const isSettled  = !isActive && queuedCount === 0 && pausedItems.length === 0;

  // Auto-collapse 3 s after batch completes cleanly
  const prevAllDoneRef = useRef(false);
  useEffect(() => {
    if (allDone && !prevAllDoneRef.current) {
      prevAllDoneRef.current = true;
      const timer = setTimeout(() => onCollapse?.(), 3000);
      return () => clearTimeout(timer);
    }
    if (!allDone) prevAllDoneRef.current = false;
  }, [allDone]);

  // One summary notification when the batch settles (all items done/failed/cancelled)
  const prevIsSettledRef = useRef(false);
  useEffect(() => {
    if (isSettled && !prevIsSettledRef.current) {
      prevIsSettledRef.current = true;
      if ('Notification' in window && Notification.permission === 'granted' && !notifSuppressed) {
        let body;
        if (allDone) {
          body = `${doneCount} file${doneCount !== 1 ? 's' : ''} uploaded`;
        } else {
          const parts = [];
          if (doneCount > 0)    parts.push(`${doneCount} uploaded`);
          if (errorCount > 0)   parts.push(`${errorCount} failed`);
          if (abortedCount > 0) parts.push(`${abortedCount} cancelled`);
          body = parts.join(' · ');
        }
        new Notification(errorCount === 0 ? 'Upload complete' : 'Upload finished', { body });
      }
    }
    if (!isSettled) prevIsSettledRef.current = false;
  }, [isSettled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force-expand when the first error appears so failures are never hidden
  const hadErrorsRef = useRef(false);
  useEffect(() => {
    if (errorCount > 0 && !hadErrorsRef.current) onExpand?.();
    hadErrorsRef.current = errorCount > 0;
  }, [errorCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Float error items to the top so they're immediately visible without scrolling
  const displayItems = errorCount > 0
    ? [...items].sort((a, b) => (a.status === 'error' ? -1 : b.status === 'error' ? 1 : 0))
    : items;

  const [displayedBytes, setDisplayedBytes] = useState(confirmedBytes);
  const [batchSpeed, setBatchSpeed] = useState(0);
  const animRef        = useRef(null);
  const speedRef       = useRef(0);
  const floorRef       = useRef(confirmedBytes);
  const samplesRef     = useRef([]); // rolling-window samples: [{t: ms, bytes: number}]

  useEffect(() => {
    floorRef.current = confirmedBytes;
    setDisplayedBytes(prev => Math.max(prev, confirmedBytes));
  }, [confirmedBytes]);

  useEffect(() => {
    if (!isActive) {
      cancelAnimationFrame(animRef.current);
      samplesRef.current = [];
      speedRef.current = 0;
      setBatchSpeed(0);
      setDisplayedBytes(confirmedBytes);
      return;
    }
    samplesRef.current = [];
    let last = performance.now();
    function tick(now) {
      if (document.visibilityState === 'hidden' || now - last < 66) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      // Rolling 6-second window — works for both small (discrete jumps) and
      // large (continuous part updates) files
      const samples = samplesRef.current;
      samples.push({ t: now, bytes: floorRef.current });
      while (samples.length > 1 && samples[0].t < now - 6000) samples.shift();
      let rollingSpeed = 0;
      if (samples.length >= 2) {
        const span = (samples[samples.length - 1].t - samples[0].t) / 1000;
        const gained = samples[samples.length - 1].bytes - samples[0].bytes;
        if (span >= 0.5) rollingSpeed = Math.max(0, gained / span);
      }
      speedRef.current = rollingSpeed;
      setBatchSpeed(rollingSpeed);
      const dt = (now - last) / 1000;
      last = now;
      setDisplayedBytes(prev =>
        Math.min(Math.max(prev + rollingSpeed * dt, floorRef.current), totalBytes)
      );
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isActive, totalBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayProgress = totalBytes > 0 ? Math.min((displayedBytes / totalBytes) * 100, 100) : 0;
  const liveEta = batchSpeed > 0 ? (totalBytes - displayedBytes) / batchSpeed : null;

  const { primed: cancelPrimed, handleClick: handleCancelBatchClick } = useDoubleClickSafety(onCancelBatch);

  const summaryTop = (
    <div class="batch-summary-top">
      {isActive  && <span class="spinner" style={{ flexShrink: 0 }} />}
      {!isActive && allDone                           && <span class="batch-status-icon batch-status-ok">✓</span>}
      {!isActive && !allDone && (errorCount > 0 || abortedCount > 0) && <span class="batch-status-icon batch-status-err">✕</span>}
      <span class="batch-summary-count">
        {completedCount} / {totalFiles} file{totalFiles !== 1 ? 's' : ''}
        {queuedCount > 0 && <span class="batch-queued"> · {queuedCount} queued</span>}
        {errorCount  > 0 && <span class="batch-errors"> · {errorCount} failed</span>}
        {abortedCount > 0 && errorCount === 0 && <span class="batch-queued"> · {abortedCount} cancelled</span>}
      </span>
      <span class="batch-spacer" />
      {batchSpeed > 0 && <span class="batch-speed">{formatSpeed(batchSpeed)}</span>}
      {liveEta !== null  && <span class="batch-eta"> · {formatEta(liveEta)}</span>}
      {(isActive || queuedCount > 0) && (
        <button
          class="btn btn-ghost btn-sm"
          style={{ flexShrink: 0, color: 'var(--text-danger)' }}
          onClick={handleCancelBatchClick}
        >
          {cancelPrimed ? 'Sure?' : 'Cancel all'}
        </button>
      )}
      {'Notification' in window && Notification.permission === 'granted' && !collapsed && (
        <button
          class="btn btn-ghost btn-sm"
          style={{ flexShrink: 0, color: notifSuppressed ? 'var(--text-muted)' : undefined }}
          title={notifSuppressed ? 'Desktop notifications muted — click to unmute' : 'Mute desktop notifications for this queue'}
          onClick={onToggleNotifs}
        >
          {notifSuppressed ? 'Notifs off' : 'Notifs on'}
        </button>
      )}
      <button class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onToggleCollapse}>
        {collapsed ? 'Show' : 'Hide'}
      </button>
      {isSettled && (
        <button class="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );

  const errorClass = errorCount > 0 ? ' batch-summary--errors' : '';

  if (collapsed) {
    return <div class={`batch-summary${errorClass}`}>{summaryTop}</div>;
  }

  return (
    <div class={`batch-summary${errorClass}`}>
      {summaryTop}

      <div class="progress-bar-wrap" role="progressbar" aria-valuenow={Math.round(displayProgress)} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
        <div class="progress-bar" style={{ width: `${displayProgress.toFixed(2)}%` }} />
      </div>

      <div class="batch-summary-meta">
        <span>{formatBytes(displayedBytes)} / {formatBytes(totalBytes)}</span>
        {allDone && <span class="batch-all-done" data-testid="queue-complete">✓ All complete</span>}
      </div>

      <div class="batch-inflight">
        {displayItems.map(item => (
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
    </div>
  );
}
