// Copyright (C) 2026 HidayahTech, LLC
// Standalone download landing page rendered when a #dl= fragment is detected.
// No S3 credentials needed — the presigned URL is self-contained.
import { BucketerLogo } from './BucketerLogo.jsx';
import { leafName } from '../lib/format.js';
import { CURRENT_VERSION } from '../lib/changelog.js';

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
  const expiresAt = parseExpiry(presignedUrl);
  const remaining = expiresAt ? formatTimeRemaining(expiresAt) : null;
  const expired = !remaining;

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
              <p style={{ color: 'var(--text-muted)', margin: '0 0 1.5rem' }}>
                Expires in {remaining}
              </p>
              <a class="btn btn-primary" href={presignedUrl} style={{ display: 'inline-block' }}>
                Download
              </a>
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
