import { useState } from 'preact/hooks';

// Browser context warning when running from file:// (§4.13)

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'unknown';
}

const CAVEATS = {
  chrome: [
    'Multi-file deployments blocked (ES module CORS) — this build uses inlined JS, so you\'re OK.',
    'localStorage uses a shared null-origin namespace — all local HTML files share the same storage.',
    'Credential Management API unavailable from file://.',
  ],
  firefox: [
    'Most permissive browser for file:// usage — no known blockers.',
    'Credential Management API unavailable from file://.',
  ],
  safari: [
    'SubtleCrypto may be inconsistent — file resume hashing might not work.',
    'Storage APIs may be unreliable in Private Browsing mode.',
    'Credential Management API unavailable from file://.',
  ],
  unknown: [
    'Browser-specific behavior unknown in file:// context.',
  ],
};

const DISMISS_KEY = 's3b_file_banner_dismissed';

export function FileBanner() {
  const [dismissed, setDismissed] = useState(
    () => !!sessionStorage.getItem(DISMISS_KEY)
  );

  if (dismissed || window.location.protocol !== 'file:') return null;

  const browser = detectBrowser();
  const caveats = CAVEATS[browser] || CAVEATS.unknown;

  return (
    <div class="banner banner-warn" role="alert">
      <div class="banner-body">
        <div class="banner-title">Running from a local file ({browser === 'unknown' ? 'unknown browser' : browser})</div>
        <ul style={{ paddingLeft: '1.2rem', marginTop: '.3rem' }}>
          {caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
        <div style={{ marginTop: '.4rem' }}>
          For the most reliable experience, serve via <code>http://localhost</code> instead.
        </div>
      </div>
      <button class="banner-close" onClick={() => { sessionStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); }} aria-label="Dismiss">✕</button>
    </div>
  );
}
