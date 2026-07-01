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
import { Fragment } from 'preact';
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

// Compact one-line strategy for the default view: mode · part size · concurrency · sharding.
// "conns" (concurrent part uploads) is deliberately distinct from the "part size" so the two
// numbers aren't confused. Returns '—' only for entries written before this feature existed.
export function formatStrategyAnnotation(entry) {
  const probe = formatProbeAnnotation(entry.probeResult);
  if (probe) return probe + (entry.sharded ? ' · sharded ×2' : '');
  if (!entry.concurrencyMode) return '—';
  const size  = entry.partSize != null ? ` · ${formatBytes(entry.partSize)}` : '';
  const conns = entry.peakPartConcurrency != null ? ` · ${entry.peakPartConcurrency} conns` : '';
  const shard = entry.sharded ? ' · sharded ×2' : '';
  return `${entry.concurrencyMode}${size}${conns}${shard}`;
}

// Full diagnostic breakdown for the expanded row — an array of [label, value] pairs. Only
// includes fields that are present, so old log entries and single-PUT small files stay clean.
// This is the "enrichment" the compact line intentionally omits, revealed on demand.
export function strategyDetails(entry) {
  const rows = [];
  if (entry.concurrencyMode) rows.push(['Mode', entry.concurrencyMode]);
  if (entry.partSize != null) rows.push(['Part size', formatBytes(entry.partSize)]);
  if (entry.totalParts != null) rows.push(['Parts', entry.totalParts.toLocaleString()]);
  if (entry.peakPartConcurrency != null) {
    rows.push(['Peak concurrency', entry.sharded ? `${entry.peakPartConcurrency} (across 2 origins)` : String(entry.peakPartConcurrency)]);
  }
  if (entry.retries != null) rows.push(['Transient retries', String(entry.retries)]);
  if (entry.avgSpeedBps != null) rows.push(['Avg speed', formatSpeed(entry.avgSpeedBps)]);
  if (entry.durationSec != null) rows.push(['Duration', formatDuration(entry.durationSec)]);
  if (entry.provider) rows.push(['Provider', entry.provider]);
  if (entry.bucket) rows.push(['Bucket', entry.bucket]);
  if (entry.endpoint) rows.push(['Endpoint', entry.endpoint]);
  const probe = formatProbeAnnotation(entry.probeResult);
  if (probe) rows.push(['Probe', probe]);
  if (entry.status !== 'done' && entry.errorMessage) rows.push(['Error', entry.errorMessage]);
  return rows;
}

export function UploadLog({ refreshKey }) {
  const [entries, setEntries] = useState([]);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

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
          {displayEntries.map((e, i) => {
            const key = e.completedAt != null ? `${e.completedAt}_${i}` : String(i);
            const isOpen = expanded.has(key);
            return (
              <Fragment key={key}>
                <tr class="file-row" style={{ cursor: 'pointer' }} onClick={() => toggle(key)} title="Click for full upload diagnostics">
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
                    <span aria-hidden="true" style={{ display: 'inline-block', width: '1.1em', opacity: 0.6 }}>{isOpen ? '▾' : '▸'}</span>
                    {formatStrategyAnnotation(e)}
                  </td>
                </tr>
                {isOpen && (
                  <tr class="log-detail-row">
                    <td colspan="8" style={{ padding: '.4rem 1rem .7rem 2.2rem', background: 'rgba(127,127,127,0.08)' }}>
                      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '.15rem .75rem', margin: 0, fontSize: '.82rem' }}>
                        {strategyDetails(e).map(([label, value]) => (
                          <Fragment key={label}>
                            <dt style={{ opacity: 0.65, fontWeight: 600 }}>{label}</dt>
                            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{value}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
