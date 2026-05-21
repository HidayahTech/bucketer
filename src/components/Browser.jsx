// Object browser: listing, navigation, download (§4.2, §4.4, §4.7, §4.12)
import { useState, useEffect, useRef } from 'preact/hooks';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { formatBytes, leafName, isPermissionError } from '../lib/format.js';
import { defaultMaxKeys } from '../lib/provider.js';
import { loadMaxKeys } from '../lib/storage.js';
import { ErrorBlock } from './ErrorBlock.jsx';

const PRESIGN_EXPIRES = 3600; // 1 hour

function Breadcrumb({ prefix, onNavigate }) {
  if (!prefix) return (
    <div class="breadcrumb"><span class="current">/ (root)</span></div>
  );
  const parts = prefix.split('/').filter(Boolean);
  return (
    <div class="breadcrumb">
      <span class="crumb" onClick={() => onNavigate('')}>root</span>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/') + '/';
        const isLast = i === parts.length - 1;
        return [
          <span key={`sep-${i}`} class="sep">/</span>,
          isLast
            ? <span key={part} class="current">{part}</span>
            : <span key={part} class="crumb" onClick={() => onNavigate(target)}>{part}</span>,
        ];
      })}
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString(); } catch { return ''; }
}

export function Browser({ client, bucket, provider, credentials, onCapabilityChange, capabilities, onUploadTargetChange }) {
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState([]);
  const [commonPrefixes, setCommonPrefixes] = useState([]);
  const [continuationToken, setContinuationToken] = useState(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);
  const abortRef = useRef(null);

  const maxKeys = loadMaxKeys() || defaultMaxKeys(provider);

  // Notify parent of current prefix so upload queue knows where to target
  useEffect(() => {
    if (onUploadTargetChange) onUploadTargetChange(prefix);
  }, [prefix]);

  // Navigate to a new prefix — flush state synchronously (§4.7, §4.14)
  function navigateTo(newPrefix) {
    if (abortRef.current) abortRef.current.abort();
    setPrefix(newPrefix);
    setItems([]);
    setCommonPrefixes([]);
    setContinuationToken(null);
    setIsTruncated(false);
    setListError(null);
    setDownloadError(null);
    fetchPage(newPrefix, null, true);
  }

  async function fetchPage(targetPrefix, token, replace = false) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setListing(true);
    setListError(null);

    try {
      const cmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: targetPrefix || undefined,
        Delimiter: '/',
        MaxKeys: maxKeys,
        ContinuationToken: token || undefined,
      });
      const resp = await client.send(cmd, { abortSignal: controller.signal });

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
    } finally {
      setListing(false);
    }
  }

  // Initial load
  useEffect(() => {
    navigateTo('');
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [client, bucket]);

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

  const canDownload = capabilities.download !== 'denied';
  const canList     = capabilities.list !== 'denied';

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
    <div>
      <Breadcrumb prefix={prefix} onNavigate={navigateTo} />

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

      <div class="file-list">
        {commonPrefixes.map(cp => (
          <div key={cp} class="file-item">
            <span class="file-icon">📁</span>
            <span class="file-name file-dir" onClick={() => navigateTo(cp)}>
              {cp.slice(prefix.length).replace(/\/$/, '')}
            </span>
          </div>
        ))}

        {items.map(obj => {
          const display = obj.Key.slice(prefix.length);
          if (!display) return null;
          const isDownloading = downloadingKey === obj.Key;
          return (
            <div key={obj.Key} class="file-item">
              <span class="file-icon">📄</span>
              <span class="file-name" title={obj.Key}>{display}</span>
              <span class="file-size">{formatBytes(obj.Size)}</span>
              <span class="file-size" style={{ marginLeft: '.5rem' }}>{formatDate(obj.LastModified)}</span>
              <div class="file-actions">
                <button
                  class="btn btn-ghost btn-sm"
                  onClick={() => handleDownload(obj.Key)}
                  disabled={!canDownload || isDownloading}
                  title={!canDownload ? 'Download not permitted with current credentials' : 'Download'}
                >
                  {isDownloading ? <span class="spinner" /> : '↓'}
                </button>
              </div>
            </div>
          );
        })}

        {!listing && items.length === 0 && commonPrefixes.length === 0 && !listError && (
          <div class="empty-state">This prefix is empty.</div>
        )}
      </div>

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
    </div>
  );
}
