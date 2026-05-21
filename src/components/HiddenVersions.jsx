// Read-only view of hidden object versions and delete markers for the current prefix
import { useState } from 'preact/hooks';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { formatBytes } from '../lib/format.js';
import { ErrorBlock } from './ErrorBlock.jsx';

function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(); } catch { return ''; }
}

function shortVersionId(id) {
  if (!id) return '—';
  return id.length > 18 ? id.slice(0, 18) + '…' : id;
}

export function HiddenVersions({ client, bucket, prefix }) {
  const [rows, setRows] = useState(null); // null = not yet fetched
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [nextKeyMarker, setNextKeyMarker] = useState(null);
  const [nextVersionIdMarker, setNextVersionIdMarker] = useState(null);

  async function fetchPage(keyMarker, versionIdMarker, replace) {
    setLoading(true);
    setError(null);
    try {
      const resp = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix || undefined,
        KeyMarker: keyMarker || undefined,
        VersionIdMarker: versionIdMarker || undefined,
      }));

      const hidden = [];
      for (const v of (resp.Versions || [])) {
        if (!v.IsLatest) {
          hidden.push({ key: v.Key, versionId: v.VersionId, type: 'old-version', size: v.Size, date: v.LastModified });
        }
      }
      for (const dm of (resp.DeleteMarkers || [])) {
        hidden.push({ key: dm.Key, versionId: dm.VersionId, type: 'delete-marker', isLatest: dm.IsLatest, size: null, date: dm.LastModified });
      }

      hidden.sort((a, b) => {
        const kc = a.key.localeCompare(b.key);
        if (kc !== 0) return kc;
        return new Date(b.date) - new Date(a.date);
      });

      setRows(prev => replace ? hidden : [...(prev || []), ...hidden]);
      setIsTruncated(!!resp.IsTruncated);
      setNextKeyMarker(resp.NextKeyMarker || null);
      setNextVersionIdMarker(resp.NextVersionIdMarker || null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  function load() { fetchPage(null, null, true); }

  const rel = (key) => key.slice((prefix || '').length) || key;

  if (rows === null && !loading && !error) {
    return (
      <div class="hidden-versions-bar">
        <button class="btn btn-ghost btn-sm" onClick={load}>Show hidden versions…</button>
      </div>
    );
  }

  return (
    <div class="hidden-versions">
      <div class="hidden-versions-header">
        <span class="section-heading" style={{ margin: 0 }}>Hidden versions</span>
        <button class="btn btn-ghost btn-sm" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {error && (
        <ErrorBlock
          error={error}
          title="Failed to list versions"
          guidance="Check that your credentials have the ListBucketVersions (s3:ListObjectVersions) permission, and that versioning is supported by this provider."
        />
      )}

      {loading && (
        <div class="empty-state"><span class="spinner" style={{ marginRight: '.5rem' }} />Loading…</div>
      )}

      {!loading && rows !== null && rows.length === 0 && (
        <div class="empty-state">No hidden versions found in this prefix.</div>
      )}

      {rows && rows.length > 0 && (
        <table class="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Version ID</th>
              <th style={{ textAlign: 'right' }}>Size</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.key}-${r.versionId}-${i}`} class="file-row">
                <td class="col-name">
                  <span class="file-name" title={r.key}>{rel(r.key)}</span>
                </td>
                <td>
                  {r.type === 'delete-marker'
                    ? <span class="version-badge version-badge-dm">{r.isLatest ? 'Delete marker' : 'Delete marker (superseded)'}</span>
                    : <span class="version-badge version-badge-old">Old version</span>
                  }
                </td>
                <td class="col-version-id" title={r.versionId}>{shortVersionId(r.versionId)}</td>
                <td class="col-size">{r.size != null ? formatBytes(r.size) : '—'}</td>
                <td class="col-modified">{formatDate(r.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isTruncated && !loading && (
        <div class="load-more-bar">
          <button class="btn btn-ghost" onClick={() => fetchPage(nextKeyMarker, nextVersionIdMarker, false)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
