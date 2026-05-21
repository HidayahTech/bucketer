// Polls the server for a newer build and prompts the user to refresh
import { useState, useEffect } from 'preact/hooks';

const INTERVAL_MS = 60_000;

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

    const id = setInterval(async () => {
      try {
        const fetchedId = await fetchBuildId();
        if (fetchedId && fetchedId !== currentId) {
          setHasUpdate(true);
          clearInterval(id);
        }
      } catch {
        // Network error — silently skip this check
      }
    }, INTERVAL_MS);

    return () => clearInterval(id);
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
