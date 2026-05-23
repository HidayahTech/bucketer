// Persistent upload history log
import { useState, useEffect } from 'preact/hooks';
import { loadUploadLog, clearUploadLog } from '../lib/indexeddb.js';
import { formatBytes, formatSpeed } from '../lib/format.js';

function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatCompletedAt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'short', timeStyle: 'medium',
    });
  } catch { return '—'; }
}

export function UploadLog({ refreshKey }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    loadUploadLog()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  async function handleClear() {
    await clearUploadLog().catch(() => {});
    setEntries([]);
  }

  if (loading || entries.length === 0) return null;

  const totalBytes = entries.reduce((s, e) => s + (e.fileSize || 0), 0);
  const errorCount = entries.filter(e => e.status !== 'done').length;
  const summary = `${entries.length} file${entries.length !== 1 ? 's' : ''} · ${formatBytes(totalBytes)}${errorCount > 0 ? ` · ${errorCount} failed` : ''}`;

  return (
    <details class="upload-log">
      <summary class="upload-log-summary">
        <span class="section-heading" style={{ margin: 0, display: 'inline' }}>Upload history</span>
        <span class="upload-log-summary-meta">{summary}</span>
      </summary>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '.5rem' }}>
        <button class="btn btn-ghost btn-sm" onClick={handleClear}>Clear</button>
      </div>

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
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} class="file-row">
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
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
