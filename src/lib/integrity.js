// Copyright (C) 2026 HidayahTech, LLC
// In-app honest-host integrity check.
//
// Verifies that the bytes the browser is currently serving for this page match
// the canonical artifact GitLab CI built and published for the declared version.
//
// Threat model — important:
//   - PROVES: the host has not silently replaced dist/index.html with bytes that
//     differ from what GitLab CI produced for this version.
//   - DOES NOT PROVE: that the running JavaScript was not modified. A malicious
//     host could rewrite both the bundle and this check. This is a fundamental
//     limit of in-page integrity checks and the UI must surface it explicitly.
//
// All external dependencies are injected so the library is fully testable in
// Node without jsdom or WebCrypto. In the browser, the caller passes:
//   fetchFn = window.fetch.bind(window)
//   subtle  = window.crypto.subtle

// Algorithms we know how to compute, in preferred order. The manifest's hashes
// field is intentionally an object (not a string) so future algorithms can be
// added here without a schema migration on the published manifests.
const ALGORITHMS = [
  { id: 'sha256', subtleName: 'SHA-256' },
];

const GITLAB_PROJECT = 'hidayahtech%2Fbucketer';

export function manifestUrlFor(version) {
  return `https://gitlab.com/api/v4/projects/${GITLAB_PROJECT}` +
    `/packages/generic/bucketer/${version}/bucketer-v${version}.integrity.json`;
}

function toHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function verifyIntegrity({ version, pageUrl, fetchFn, subtle }) {
  // Page self-fetch. cache:no-store forces a network round-trip so we hash the
  // currently-served bytes, not a stale HTTP-cache or service-worker copy.
  let pageBuffer;
  try {
    const res = await fetchFn(pageUrl, { cache: 'no-store' });
    if (!res.ok) {
      return { status: 'network-error', version, message: `Page fetch returned HTTP ${res.status}` };
    }
    pageBuffer = await res.arrayBuffer();
  } catch (err) {
    return { status: 'network-error', version, message: `Page fetch failed: ${err.message}` };
  }

  // Manifest fetch. 404 is a meaningful state (older releases predate this
  // feature and have no manifest) — surface it separately from generic
  // network errors so the UI can render an informative message.
  let manifest;
  try {
    const res = await fetchFn(manifestUrlFor(version));
    if (res.status === 404) {
      return { status: 'no-manifest', version };
    }
    if (!res.ok) {
      return { status: 'network-error', version, message: `Manifest fetch returned HTTP ${res.status}` };
    }
    manifest = await res.json();
  } catch (err) {
    return { status: 'network-error', version, message: `Manifest fetch failed: ${err.message}` };
  }

  const hashes = manifest && manifest.hashes;
  if (!hashes || typeof hashes !== 'object') {
    return { status: 'network-error', version, message: 'Manifest missing hashes object' };
  }

  const algo = ALGORITHMS.find(a => typeof hashes[a.id] === 'string');
  if (!algo) {
    return { status: 'unknown-algorithm', version, algorithms: Object.keys(hashes) };
  }

  const expected = hashes[algo.id];
  const digest = await subtle.digest(algo.subtleName, pageBuffer);
  const actual = toHex(digest);

  if (actual === expected) {
    return { status: 'match', version, algorithm: algo.id, hash: actual };
  }
  return { status: 'mismatch', version, algorithm: algo.id, actual, expected };
}
