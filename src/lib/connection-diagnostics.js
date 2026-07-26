// Copyright (C) 2026 HidayahTech, LLC
// Connection diagnostics (spec: docs/superpowers/specs/2026-07-26-connection-diagnostics-design.md).
//
// When a request dies before an HTTP response exists, the browser surfaces a bare
// TypeError regardless of cause — CORS, DNS, TLS, mixed content, offline, and
// extension blocking are indistinguishable from the error object alone. These
// checks gather the evidence the error cannot carry: static environment checks
// plus no-cors probes. A no-cors fetch bypasses the CORS layer entirely, so an
// opaque success proves reachability (DNS + TLS + listener) independent of the
// bucket's CORS configuration. If everything is reachable yet the SDK saw a
// network-shaped TypeError, the failure is at the CORS layer: correctly
// configured CORS would surface even bad credentials as a readable 403.
import { requiresPathStyle } from './provider.js';

export const PROBE_TIMEOUT_MS = 5000;

export const VERDICT_MESSAGES = {
  'offline': 'Your browser reports no network connection. Reconnect and try again.',
  'mixed-content': 'This page is served over HTTPS but the endpoint is HTTP — browsers silently block such requests. Use an HTTPS endpoint.',
  'bad-endpoint-url': 'The endpoint is not a valid URL. Check it for typos.',
  'endpoint-unreachable': 'The endpoint host did not respond — check the URL for typos. A blocking browser extension can also cause this.',
  'bucket-host-unreachable': 'The endpoint responds, but the bucket\'s hostname does not — check the bucket name. For a brand-new bucket, DNS may still be propagating.',
  'cors-blocked': 'Your storage responded, but the browser blocked the request. This is almost certainly missing or incorrect CORS configuration on the bucket — see the Setup Guide for your provider\'s exact command. If CORS is already configured, double-check the bucket name: some providers respond even for buckets that do not exist.',
  // #52: the all-probes-pass inference is only sound for request-time blocks.
  // On an already-working connection, a mid-transfer network reset produces the
  // same masked TypeError — so connected sessions get this softer verdict.
  'cors-blocked-transient': 'Your storage responded, but this request was blocked or interrupted. Since this connection was already working, a transient network interruption is more likely than a CORS problem — retry the operation. If it keeps happening, re-check the bucket\'s CORS configuration.',
};

// Builds the ErrorBlock `diagnostics` prop from a stored credentials object.
// connected: pass true from error blocks that only render inside a working
// session (Browser, HiddenVersions) — it selects the transient variant of the
// cors-blocked verdict (#52). The connect screen leaves it false.
export function diagnosticsProps(credentials, connected = false) {
  return {
    endpoint: credentials.endpoint,
    bucket: credentials.bucket,
    forcePathStyle: requiresPathStyle(credentials.provider),
    connected,
  };
}

// Opaque success = reachable; rejection or timeout = unreachable from this browser.
async function probe(url, fetchFn, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchFn(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDiagnostics({ endpoint, bucket, forcePathStyle, connected, fetchFn, pageProtocol, onLine, timeoutMs } = {}) {
  fetchFn = fetchFn || globalThis.fetch;
  pageProtocol = pageProtocol ?? globalThis.location?.protocol;
  onLine = onLine ?? (globalThis.navigator ? globalThis.navigator.onLine : true);
  timeoutMs = timeoutMs ?? PROBE_TIMEOUT_MS;

  const checks = [];
  let verdict = null;
  const push = (id, label, status, detail = null) => checks.push({ id, label, status, detail });

  // 1. Offline
  if (onLine === false) {
    push('online', 'Browser is online', 'fail');
    verdict = 'offline';
  } else {
    push('online', 'Browser is online', 'pass');
  }

  // 2. Mixed content (HTTPS page → HTTP endpoint is silently blocked by browsers)
  if (verdict) {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'skip');
  } else if (pageProtocol === 'https:' && /^\s*http:\/\//i.test(endpoint || '')) {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'fail');
    verdict = 'mixed-content';
  } else {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'pass');
  }

  // 3. URL validity
  let endpointUrl = null;
  if (verdict) {
    push('url-valid', 'Endpoint is a valid URL', 'skip');
  } else {
    try {
      endpointUrl = new URL(endpoint);
      push('url-valid', 'Endpoint is a valid URL', 'pass');
    } catch {
      push('url-valid', 'Endpoint is a valid URL', 'fail');
      verdict = 'bad-endpoint-url';
    }
  }

  // 4. Endpoint reachability (no-cors probe of the endpoint origin)
  if (verdict) {
    push('endpoint-reachable', 'Endpoint host responds', 'skip');
  } else if (await probe(endpointUrl.origin, fetchFn, timeoutMs)) {
    push('endpoint-reachable', 'Endpoint host responds', 'pass');
  } else {
    push('endpoint-reachable', 'Endpoint host responds', 'fail');
    verdict = 'endpoint-unreachable';
  }

  // 5. Bucket virtual-host reachability (skipped for path-style addressing)
  if (verdict) {
    push('bucket-host-reachable', 'Bucket hostname responds', 'skip');
  } else if (forcePathStyle) {
    push('bucket-host-reachable', 'Bucket hostname responds', 'skip', 'Path-style addressing — bucket hostname not used');
  } else {
    const bucketUrl = new URL(endpointUrl.origin);
    bucketUrl.hostname = `${bucket}.${bucketUrl.hostname}`;
    if (await probe(bucketUrl.origin, fetchFn, timeoutMs)) {
      push('bucket-host-reachable', 'Bucket hostname responds', 'pass');
    } else {
      push('bucket-host-reachable', 'Bucket hostname responds', 'fail');
      verdict = 'bucket-host-unreachable';
    }
  }

  // 6 (implicit). Reachable everywhere yet the SDK saw a masked TypeError → CORS
  // layer for request-time blocks; on an already-working connection a transient
  // mid-transfer interruption is the likelier cause (#52).
  if (!verdict) verdict = connected ? 'cors-blocked-transient' : 'cors-blocked';
  return { checks, verdict };
}
