// Polls the server for a newer build and prompts the user to refresh.
//
// Strategy (cheapest to most expensive):
//   1. HEAD request — compare ETag/Last-Modified against a stored baseline.
//      If they match, nothing has changed; reschedule without fetching any body.
//   2. Range fetch (bytes 0–511) — if HEAD is inconclusive (no baseline yet, or
//      headers changed/absent), fetch just enough bytes to extract build-id and
//      app-version (both are guaranteed within the first 512 bytes by the build
//      invariant). If build-id differs from the running page, stop polling and
//      show the update banner. No full fetch is performed.
//
// RANGE_BYTES must match UPDATE_CHECK_RANGE_BYTES in build.mjs.
import { useState, useEffect } from 'preact/hooks';

const BASE_MS     = 60_000;
const MAX_MS      = 1_800_000;
const FAST_CHECKS = 10;
const JITTER      = 0.25;
const RANGE_BYTES = 512; // must match UPDATE_CHECK_RANGE_BYTES in build.mjs

function nextDelay(attempt) {
  const base = attempt < FAST_CHECKS
    ? BASE_MS
    : Math.min(BASE_MS * 2 ** (attempt - FAST_CHECKS + 1), MAX_MS);
  return Math.round(base + base * JITTER * (Math.random() * 2 - 1));
}

function getCurrentBuildId() {
  const el = document.querySelector('meta[name="build-id"]');
  return el ? el.getAttribute('content') : null;
}

// Returns a stable comparison key from HEAD response headers.
// Prefers ETag; falls back to Last-Modified; null if neither is present.
function headKey(headers) {
  return headers.get('etag') || headers.get('last-modified') || null;
}

async function tryHead(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? headKey(res.headers) : null;
  } catch { return null; }
}

async function fetchRangeMetadata(url) {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const buildIdMatch = text.match(/name="build-id"\s+content="([^"]+)"/);
    if (!buildIdMatch) return null;
    const versionMatch = text.match(/name="app-version"\s+content="([^"]+)"/);
    return { buildId: buildIdMatch[1], appVersion: versionMatch ? versionMatch[1] : null };
  } catch { return null; }
}

export function UpdateBanner() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [newVersion, setNewVersion] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (window.location.protocol === 'file:') return;
    const currentId = getCurrentBuildId();
    if (!currentId) return;

    let attempt = 0;
    let timerId;
    let headBaseline = null; // null = not yet established

    async function check() {
      try {
        const checkUrl = (window.location.pathname || '/') + '?_v=' + Date.now();

        // Step 1: HEAD fast path — skip body fetch if headers match baseline
        if (headBaseline !== null) {
          const currentHead = await tryHead(checkUrl);
          if (currentHead !== null && currentHead === headBaseline) {
            timerId = setTimeout(check, nextDelay(++attempt));
            return;
          }
        }

        // Step 2: Range fetch — compare build-id, extract app-version
        const metadata = await fetchRangeMetadata(checkUrl);
        if (metadata === null) {
          timerId = setTimeout(check, nextDelay(++attempt));
          return;
        }

        if (metadata.buildId === currentId) {
          // Same build — establish or refresh the HEAD baseline, then reschedule
          const hk = await tryHead(checkUrl);
          if (hk) headBaseline = hk;
          timerId = setTimeout(check, nextDelay(++attempt));
          return;
        }

        // Different build-id — confirmed update. Stop polling and show banner.
        setNewVersion(metadata.appVersion);
        setHasUpdate(true);
        // Polling stops — an update has been found.
      } catch {
        timerId = setTimeout(check, nextDelay(++attempt));
      }
    }

    timerId = setTimeout(check, nextDelay(attempt));
    return () => clearTimeout(timerId);
  }, []);

  if (!hasUpdate || dismissed) return null;

  return (
    <div class="banner banner-info" role="status">
      <div class="banner-body">
        {newVersion ? `Version ${newVersion} is available.` : 'A new version is available.'}{' '}
        <button class="btn btn-ghost btn-sm" style={{ marginLeft: '.25rem' }} onClick={() => window.location.reload()}>
          Refresh to update
        </button>
      </div>
      <button class="banner-close" onClick={() => setDismissed(true)} aria-label="Dismiss">✕</button>
    </div>
  );
}
