// Copyright (C) 2026 HidayahTech, LLC
// IntegrityCheck — honest-host integrity check UI.
//
// Threat model honesty is non-negotiable: every result state must surface that
// this proves the host is serving the canonical artifact, not that the running
// JavaScript was not modified. A malicious host could rewrite both the bundle
// and this check. See src/lib/integrity.js for the verification logic.
//
// The `verify` prop is injectable so the component can be tested without a real
// fetch or WebCrypto. In production it defaults to the real verifyIntegrity
// bound to window.fetch and window.crypto.subtle.
import { useState } from 'preact/hooks';
import { verifyIntegrity } from '../lib/integrity.js';

function defaultVerify({ version, pageUrl }) {
  return verifyIntegrity({
    version,
    pageUrl,
    fetchFn: window.fetch.bind(window),
    subtle: window.crypto.subtle,
  });
}

function getRunningVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  return meta ? meta.getAttribute('content') : null;
}

function shortHash(hex) {
  return hex.length > 16 ? hex.slice(0, 16) + '…' : hex;
}

function ResultBanner({ result }) {
  const v = result.version || '?';

  if (result.status === 'match') {
    return (
      <div class="banner banner-success" role="status" style={{ marginTop: '.5rem' }}>
        <div class="banner-body">
          <div class="banner-title">Match</div>
          This page is bit-identical to the build GitLab CI published for v{v}.
          <div style={{ fontSize: '.75rem', opacity: 0.8, marginTop: '.25rem' }}>
            {result.algorithm}: <code>{shortHash(result.hash)}</code>
          </div>
          <div style={{ fontSize: '.75rem', opacity: 0.8, marginTop: '.25rem' }}>
            Note: this proves the host is serving the canonical artifact. It does not prove
            the running JavaScript was not modified — a malicious host could rewrite both.
          </div>
        </div>
      </div>
    );
  }

  if (result.status === 'mismatch') {
    return (
      <div class="banner banner-danger" role="alert" style={{ marginTop: '.5rem' }}>
        <div class="banner-body">
          <div class="banner-title">Mismatch</div>
          The bytes this page is serving do NOT match the build GitLab CI published for v{v}.
          <div style={{ fontSize: '.75rem', marginTop: '.4rem', fontFamily: 'monospace' }}>
            <div>served&nbsp;&nbsp;{result.algorithm}: <code>{shortHash(result.actual)}</code></div>
            <div>expected {result.algorithm}: <code>{shortHash(result.expected)}</code></div>
          </div>
        </div>
      </div>
    );
  }

  if (result.status === 'no-manifest') {
    return (
      <div class="banner banner-warn" role="status" style={{ marginTop: '.5rem' }}>
        <div class="banner-body">
          No integrity manifest is published for v{v}. This version predates the integrity-check feature.
        </div>
      </div>
    );
  }

  if (result.status === 'unknown-algorithm') {
    return (
      <div class="banner banner-warn" role="status" style={{ marginTop: '.5rem' }}>
        <div class="banner-body">
          The manifest for v{v} uses hash algorithms this app cannot compute
          ({result.algorithms.join(', ')}). Update the app to verify.
        </div>
      </div>
    );
  }

  // network-error and any unrecognized status
  return (
    <div class="banner banner-warn" role="status" style={{ marginTop: '.5rem' }}>
      <div class="banner-body">
        Could not verify against GitLab.{result.message ? ` ${result.message}` : ''}
      </div>
    </div>
  );
}

export function IntegrityCheck({ verify = defaultVerify }) {
  const [phase, setPhase] = useState('idle');   // 'idle' | 'running' | 'result'
  const [result, setResult] = useState(null);

  async function handleVerify() {
    const version = getRunningVersion();
    const pageUrl = window.location.href;
    setPhase('running');
    try {
      const r = await verify({ version, pageUrl });
      setResult(r);
      setPhase('result');
    } catch (err) {
      setResult({ status: 'network-error', version, message: err && err.message });
      setPhase('result');
    }
  }

  return (
    <div class="form-group" style={{ marginTop: '.75rem' }}>
      <label>Verify build integrity</label>
      <span class="hint">
        Compares the bytes this page is currently serving against the build GitLab CI
        published for this version. This proves the host is serving the canonical artifact;
        it does not prove the running JavaScript was not modified — a malicious host could
        rewrite both the bundle and this check.
      </span>
      <div style={{ marginTop: '.4rem' }}>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={handleVerify}
          disabled={phase === 'running'}
        >
          {phase === 'running' ? 'Verifying…' : 'Verify now'}
        </button>
      </div>
      {phase === 'result' && result && <ResultBanner result={result} />}
    </div>
  );
}
