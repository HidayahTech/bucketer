// Copyright (C) 2026 HidayahTech, LLC
// Persistent upload history log (IndexedDB upload_log store).
//
// refreshKey prop: incremented by App whenever uploads complete. The useEffect dependency
// on refreshKey is the signal to re-read from IndexedDB — avoids prop-drilling individual
// upload results through the component tree.
//
// Display is capped at MAX_DISPLAY rows (newest first). All entries are still loaded for
// accurate summary stats. Stable keys (completedAt timestamp) let Preact add/remove one
// node per new entry instead of reconciling the entire list on every refresh.
import { useState, useEffect } from 'preact/hooks';
import { loadUploadLog, clearUploadLog } from '../lib/indexeddb.js';
import { formatBytes, formatSpeed } from '../lib/format.js';

const MAX_DISPLAY = 200;

function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

const completedAtCache = new Map();
function formatCompletedAt(ts) {
  if (!ts) return '—';
  if (completedAtCache.has(ts)) return completedAtCache.get(ts);
  try {
    const result = new Date(ts).toLocaleString(undefined, {
      dateStyle: 'short', timeStyle: 'medium',
    });
    completedAtCache.set(ts, result);
    return result;
  } catch { return '—'; }
}

// Returns a short human-readable string for the probe result, or null if none.
export function formatProbeAnnotation(probeResult) {
  if (!probeResult) return null;
  const range = `${probeResult.baseline}→${probeResult.candidate} parts`;
  if (probeResult.inconclusive) return `adaptive · probe: ${range} (unreliable measurement)`;
  if (probeResult.winner === probeResult.candidate) {
    const pct = Math.round((probeResult.candidateMbs / probeResult.baselineMbs - 1) * 100);
    return `adaptive · probe: ${range} (+${pct}%)`;
  }
  return `adaptive · probe: ${range} (held baseline)`;
}

// Returns the full strategy annotation for a log entry.
// Shows probe detail when available; falls back to mode + peak part concurrency.
// Returns '—' only for entries written before this feature existed.
function formatStrategyAnnotation(entry) {
  const probe = formatProbeAnnotation(entry.probeResult);
  if (probe) return probe;
  if (!entry.concurrencyMode) return '—';
  const parts = entry.peakPartConcurrency != null ? ` · ${entry.peakPartConcurrency} parts` : '';
  const shard = entry.sharded ? ' · sharded ×2' : '';
  return `${entry.concurrencyMode}${parts}${shard}`;
}

export function UploadLog({ refreshKey }) {
  const [entries, setEntries] = useState([]);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  useEffect(() => {
    loadUploadLog()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setInitialLoadDone(true));
  }, [refreshKey]);

  async function handleClear() {
    await clearUploadLog().catch(() => {});
    setEntries([]);
  }

  if (!initialLoadDone || entries.length === 0) return null;

  const totalBytes = entries.reduce((s, e) => s + (e.fileSize || 0), 0);
  const errorCount = entries.filter(e => e.status !== 'done').length;
  const summary = `${entries.length} file${entries.length !== 1 ? 's' : ''} · ${formatBytes(totalBytes)}${errorCount > 0 ? ` · ${errorCount} failed` : ''}`;

  const displayEntries = entries.length > MAX_DISPLAY ? entries.slice(0, MAX_DISPLAY) : entries;
  const truncated = entries.length > MAX_DISPLAY;

  return (
    <details class="upload-log">
      <summary class="upload-log-summary">
        <span class="section-heading" style={{ margin: 0, display: 'inline' }}>Upload history</span>
        <span class="upload-log-summary-meta">{summary}</span>
      </summary>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '.5rem' }}>
        <button class="btn btn-ghost btn-sm" onClick={handleClear}>Clear</button>
      </div>

      {truncated && (
        <p class="hint" style={{ marginBottom: '.5rem' }}>
          Showing most recent {MAX_DISPLAY} of {entries.length} uploads. Clear the log to reset.
        </p>
      )}

      <table class="file-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>File</th>
            <th>Destination</th>
            <th>Size</th>
            <th>Completed</th>
            <th>Duration</th>
            <th>Avg speed</th>
            <th>Strategy</th>
          </tr>
        </thead>
        <tbody>
          {displayEntries.map((e, i) => (
            <tr key={e.completedAt != null ? `${e.completedAt}_${i}` : i} class="file-row">
              <td class="log-status">
                {e.status === 'done'
                  ? <span class="log-done">✓</span>
                  : <span class="log-error" title={e.errorMessage}>✗</span>}
              </td>
              <td class="log-name" title={e.fileName}>{e.fileName}</td>
              <td class="log-dest" title={e.destinationKey}>{e.destinationKey}</td>
              <td class="log-num">{formatBytes(e.fileSize)}</td>
              <td class="log-num">{formatCompletedAt(e.completedAt)}</td>
              <td class="log-num">{formatDuration(e.durationSec)}</td>
              <td class="log-num">{e.avgSpeedBps != null ? formatSpeed(e.avgSpeedBps) : '—'}</td>
              <td class="log-strategy">
                {formatStrategyAnnotation(e)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
