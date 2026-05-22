// Polls the server for a newer build and prompts the user to refresh
import { useState, useEffect } from 'preact/hooks';

// Poll every 60s for the first 10 minutes, then double each interval up to 30 minutes.
const BASE_MS       = 60_000;      // 1 minute
const MAX_MS        = 1_800_000;   // 30 minutes
const FAST_CHECKS   = 10;          // how many checks at BASE_MS before backoff

function nextDelay(attempt) {
  if (attempt < FAST_CHECKS) return BASE_MS;
  return Math.min(BASE_MS * 2 ** (attempt - FAST_CHECKS + 1), MAX_MS);
}

function getCurrentBuildId() {
  const el = document.querySelector('meta[name="build-id"]');
  return el ? el.getAttribute('content') : null;
}

async function fetchBuildId() {
  const url = (window.location.pathname || '/') + '?_v=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const text = await res.text();
  const m = text.match(/name="build-id"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}

export function UpdateBanner() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Only relevant when served over HTTP — no server to poll on file://
    if (window.location.protocol === 'file:') return;

    const currentId = getCurrentBuildId();
    if (!currentId) return;

    let attempt = 0;
    let timerId;

    async function check() {
      try {
        const fetchedId = await fetchBuildId();
        if (fetchedId && fetchedId !== currentId) {
          setHasUpdate(true);
          return;
        }
      } catch {
        // Network error — silently skip this check
      }
      timerId = setTimeout(check, nextDelay(++attempt));
    }

    timerId = setTimeout(check, nextDelay(attempt));
    return () => clearTimeout(timerId);
  }, []);

  if (!hasUpdate || dismissed) return null;

  return (
    <div class="banner banner-info" role="status">
      <div class="banner-body">
        A new version is available.{' '}
        <button class="btn btn-ghost btn-sm" style={{ marginLeft: '.25rem' }} onClick={() => window.location.reload()}>
          Refresh to update
        </button>
      </div>
      <button class="banner-close" onClick={() => setDismissed(true)} aria-label="Dismiss">✕</button>
    </div>
  );
}
