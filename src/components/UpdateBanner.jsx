// Polls the server for a newer build and prompts the user to refresh.
//
// Strategy (cheapest to most expensive):
//   1. HEAD request — compare ETag/Last-Modified against a stored baseline.
//      If they match, nothing has changed; reschedule without fetching any body.
//   2. Range fetch (bytes 0–511) — if HEAD is inconclusive (no baseline yet, or
//      headers changed/absent), fetch just enough bytes to extract the build-id
//      and compare it with the running page's build-id.
//   3. Full fetch — once a real version change is confirmed, fetch the whole page
//      with the default cache mode so the browser can store it. The user's
//      subsequent reload will be served from cache. Extract app-version for display.
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

async function fetchRangeBuildId(url) {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/name="build-id"\s+content="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function fetchFullVersion(url) {
  try {
    // No cache override — let the browser cache this response so the reload
    // after the user clicks "Refresh to update" is served from cache.
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/name="app-version"\s+content="([^"]+)"/);
    return m ? m[1] : null;
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

        // Step 2: Range fetch — compare build-id
        const fetchedBuildId = await fetchRangeBuildId(checkUrl);
        if (fetchedBuildId === null) {
          timerId = setTimeout(check, nextDelay(++attempt));
          return;
        }

        if (fetchedBuildId === currentId) {
          // Same version — establish or refresh the HEAD baseline, then reschedule
          const hk = await tryHead(checkUrl);
          if (hk) headBaseline = hk;
          timerId = setTimeout(check, nextDelay(++attempt));
          return;
        }

        // Step 3: Different build-id — confirmed update.
        // Fetch the full page without cache override so the browser stores it.
        const cacheUrl = window.location.pathname || '/';
        const version = await fetchFullVersion(cacheUrl);
        setNewVersion(version);
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
