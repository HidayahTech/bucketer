// Copyright (C) 2026 HidayahTech, LLC
// Standalone download landing page rendered when a #dl= fragment is detected.
// No S3 credentials needed — the presigned URL is self-contained.
import { useState, useEffect } from 'preact/hooks';
import { BucketerLogo } from './BucketerLogo.jsx';
import { PreviewMedia } from './PreviewMedia.jsx';
import { leafName } from '../lib/format.js';
import { mediaKind } from '../lib/media.js';
import { CURRENT_VERSION } from '../lib/changelog.js';
import { FILE_MTIME_KEY } from '../lib/constants.js';

const TEXT_PREVIEW_LIMIT = 100 * 1024;

// AWS basic ISO 8601 (20260611T203417Z) → extended ISO (2026-06-11T20:34:17Z)
function awsDateToIso(d) {
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(9,11)}:${d.slice(11,13)}:${d.slice(13,15)}Z`;
}

function parseExpiry(url) {
  try {
    const u = new URL(url);
    const rawDate = u.searchParams.get('X-Amz-Date');
    const expires = Number(u.searchParams.get('X-Amz-Expires'));
    if (!rawDate || !expires) return null;
    const signedAt = new Date(awsDateToIso(rawDate));
    if (isNaN(signedAt.getTime())) return null;
    return new Date(signedAt.getTime() + expires * 1000);
  } catch {
    return null;
  }
}

function formatTimeRemaining(expiresAt) {
  const s = Math.floor((expiresAt - Date.now()) / 1000);
  if (s <= 0) return null;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function DownloadPage({ presignedUrl }) {
  const fileName = leafName(new URL(presignedUrl).pathname);
  const kind = mediaKind(fileName);
  const expiresAt = parseExpiry(presignedUrl);
  const remaining = expiresAt ? formatTimeRemaining(expiresAt) : null;
  const expired = !remaining;

  const [previewText, setPreviewText] = useState(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [pixelated, setPixelated] = useState(false);
  const [fileMtime, setFileMtime] = useState(null);

  // Fetch text content directly from the presigned URL when kind is text.
  // Also reads x-amz-meta-file-mtime from the response headers.
  // No S3 client needed — the presigned URL is self-contained.
  useEffect(() => {
    if (kind !== 'text' || expired) return;
    fetch(presignedUrl, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } })
      .then(r => {
        const mtime = r.headers.get('x-amz-meta-' + FILE_MTIME_KEY);
        if (mtime) {
          const d = new Date(mtime);
          if (!isNaN(d.getTime())) setFileMtime(d);
        }
        return r.text().then(t => { setPreviewText(t); setPreviewTruncated(r.status === 206); });
      })
      .catch(() => {});
  }, [presignedUrl]);

  // Read mtime from response headers for non-text files (text path handles its own).
  // Presigned GetObject URLs are signed for GET, not HEAD — HEAD returns 403.
  // A Range: bytes=0-0 request fetches just 1 byte to stay lightweight.
  useEffect(() => {
    if (kind === 'text' || expired) return;
    fetch(presignedUrl, { headers: { Range: 'bytes=0-0' } })
      .then(r => {
        const mtime = r.headers.get('x-amz-meta-' + FILE_MTIME_KEY);
        if (mtime) {
          const d = new Date(mtime);
          if (!isNaN(d.getTime())) setFileMtime(d);
        }
      })
      .catch(() => {});
  }, [presignedUrl]);

  return (
    <div id="app">
      <header class="app-header">
        <BucketerLogo />
        <span class="spacer" />
        <button class="btn-version" disabled>v{CURRENT_VERSION}</button>
      </header>

      <div class="main-content">
        <div class="splash" style={{ maxWidth: '32rem' }}>
          <h2 style={{ wordBreak: 'break-all' }}>{fileName}</h2>

          {expired ? (
            <div class="banner banner-danger" style={{ marginTop: '1rem' }}>
              <div class="banner-body">This link has expired.</div>
            </div>
          ) : (
            <>
              {fileMtime && (
                <p style={{ color: 'var(--text-muted)', margin: '0 0 .5rem', fontSize: '.85rem' }}>
                  File Modified: {fileMtime.toLocaleString()}
                </p>
              )}
              <p style={{ color: 'var(--text-muted)', margin: '0 0 1.5rem' }}>
                Expires in {remaining}
              </p>
              <a class="btn btn-primary" href={presignedUrl} style={{ display: 'inline-block' }}>
                Download
              </a>
              {kind && (
                <div class="preview-content" style={{ marginTop: '1.5rem' }}>
                  <PreviewMedia
                    kind={kind}
                    url={kind !== 'text' ? presignedUrl : undefined}
                    text={kind === 'text' ? previewText : undefined}
                    truncated={previewTruncated}
                    alt={fileName}
                    pixelated={pixelated}
                    onLoad={e => setPixelated(e.target.naturalWidth < 128 && e.target.naturalHeight < 128)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer class="app-footer">
        Bucketer &mdash; Copyright &copy; 2026 HidayahTech, LLC
      </footer>
    </div>
  );
}
