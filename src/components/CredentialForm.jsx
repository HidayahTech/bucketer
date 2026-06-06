// Copyright (C) 2026 HidayahTech, LLC
import { useState } from 'preact/hooks';
import { detectProvider, extractRegion, PROVIDERS, PROVIDER_LABELS } from '../lib/provider.js';
import { credentialErrors } from '../lib/credential-validation.js';
import { SetupGuide } from './SetupGuide.jsx';

// Credential entry form (REQ-1, §4.5, §4.8).
//
// Provider auto-detection: calls detectProvider(endpoint) as the user types. Detected
// provider and region are shown as display hints — the user can override via dropdown
// when auto-detection is wrong (reverse proxies, custom domains).
//
// Region input: shown only when the endpoint doesn't embed the region. For B2/Wasabi/AWS,
// region is extracted from the URL. For R2, 'auto' is recommended. For MinIO and GENERIC,
// the field appears with a placeholder.
//
// Secret key: type="password" prevents on-screen display and excludes from autofill history.
// Storage policy: sessionStorage only (cleared on tab close, never in localStorage).
//
// Endpoint URL is trimmed and trailing slashes stripped before saving — ensures
// 'https://example.com/' and 'https://example.com' produce identical S3Clients.

const PROVIDER_OPTIONS = [
  { value: '', label: 'Auto-detect from endpoint' },
  ...Object.entries(PROVIDER_LABELS).map(([v, l]) => ({ value: v, label: l })),
];

export function CredentialForm({ initial, onSave, onFormChange, loading }) {
  const [form, setForm] = useState({
    endpoint: initial.endpoint || '',
    bucket: initial.bucket || '',
    keyId: initial.keyId || '',
    secretKey: initial.secretKey || '',
    providerOverride: initial.provider || '',
    regionOverride: initial.regionOverride || '',
  });

  const set = (k) => (e) => setForm(f => {
    const next = { ...f, [k]: e.target.value };
    onFormChange?.(next);
    return next;
  });

  // Trim leading/trailing whitespace from pasted values. Paste-introduced
  // whitespace is a common copy/paste artifact; for all credential fields it is
  // never meaningful, so trimming is unambiguously safe. Only intercepts when
  // the pasted text actually contains surrounding whitespace — normal typing
  // and clean pastes fall through to the default handler unchanged.
  const onPaste = (k) => (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || text === text.trim()) return;
    e.preventDefault();
    const trimmed = text.trim();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end   = el.selectionEnd   ?? el.value.length;
    setForm(f => {
      const cur  = f[k] || '';
      const next = { ...f, [k]: cur.slice(0, start) + trimmed + cur.slice(end) };
      onFormChange?.(next);
      return next;
    });
  };

  const errors = credentialErrors(form);
  const hasErrors = Object.keys(errors).length > 0;

  // Auto-detect provider label for display
  const detected = form.endpoint ? detectProvider(form.endpoint) : null;
  const detectedLabel = detected ? PROVIDER_LABELS[detected] : null;
  const regionHint = detected && form.endpoint
    ? extractRegion(form.endpoint, detected)
    : null;

  function handleSubmit(e) {
    e.preventDefault();
    if (hasErrors) return;
    const provider = form.providerOverride || detected || PROVIDERS.GENERIC;
    onSave({
      endpoint: form.endpoint.trim().replace(/\/$/, ''),
      bucket: form.bucket.trim(),
      keyId: form.keyId.trim(),
      secretKey: form.secretKey,
      provider,
      regionOverride: form.regionOverride.trim(),
    });
  }

  const needsRegion = !regionHint && form.endpoint;

  return (
    <form class="cred-panel" onSubmit={handleSubmit}>
      <div class="form-group">
        <label htmlFor="cred-endpoint">Endpoint URL</label>
        <input
          id="cred-endpoint"
          type="url"
          value={form.endpoint}
          onInput={set('endpoint')}
          onPaste={onPaste('endpoint')}
          placeholder="https://s3.us-west-004.backblazeb2.com"
          required
          autocomplete="off"
          spellcheck={false}
        />
        {detectedLabel && !form.providerOverride && (
          <span class="hint">Detected: {detectedLabel}{regionHint ? ` · Region: ${regionHint}` : ''}</span>
        )}
      </div>

      <div class="form-group">
        <label htmlFor="cred-bucket">Bucket Name</label>
        <input
          id="cred-bucket"
          type="text"
          value={form.bucket}
          onInput={set('bucket')}
          onPaste={onPaste('bucket')}
          placeholder="my-bucket"
          required
          autocomplete="off"
          spellcheck={false}
        />
        {errors.bucket && <span class="field-error">{errors.bucket}</span>}
      </div>

      <div class="form-group">
        <label htmlFor="cred-keyid">Key ID</label>
        <input
          id="cred-keyid"
          type="text"
          value={form.keyId}
          onInput={set('keyId')}
          onPaste={onPaste('keyId')}
          placeholder="Access Key ID"
          required
          autocomplete="username"
          spellcheck={false}
        />
        {errors.keyId && <span class="field-error">{errors.keyId}</span>}
      </div>

      <div class="form-group">
        <label htmlFor="cred-secretkey">Secret Key</label>
        <input
          id="cred-secretkey"
          type="password"
          value={form.secretKey}
          onInput={set('secretKey')}
          onPaste={onPaste('secretKey')}
          placeholder="Secret Access Key"
          required
          autocomplete="current-password"
        />
        {errors.secretKey && <span class="field-error">{errors.secretKey}</span>}
        <span class="hint">Stored in sessionStorage — cleared on tab close.</span>
      </div>

      <div class="form-group">
        <label htmlFor="cred-provider">Provider Override</label>
        <select id="cred-provider" value={form.providerOverride} onChange={set('providerOverride')}>
          {PROVIDER_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {form.providerOverride === PROVIDERS.MINIO && (
          <span class="hint">MinIO typically requires path-style — this is applied automatically.</span>
        )}
      </div>

      {needsRegion && (
        <div class="form-group">
          <label htmlFor="cred-region">Region</label>
          <input
            id="cred-region"
            type="text"
            value={form.regionOverride}
            onInput={set('regionOverride')}
            onPaste={onPaste('regionOverride')}
            placeholder="us-east-1"
            autocomplete="off"
            spellcheck={false}
          />
          <span class="hint">Cannot be auto-detected for this endpoint. For R2, use "auto".</span>
          {errors.regionOverride && <span class="field-error">{errors.regionOverride}</span>}
        </div>
      )}

      <div class="form-group">
        <span class="hint" style={{ color: 'var(--text-warn)' }}>
          Use a bucket-scoped application key with minimum required permissions.
          {detected === PROVIDERS.B2 && ' B2: do not use the master application key with the S3 API.'}
        </span>
      </div>

      <SetupGuide
        provider={form.providerOverride || detected}
        endpoint={form.endpoint}
        bucket={form.bucket}
        keyId={form.keyId}
      />

      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={loading || hasErrors}>
          {loading ? <><span class="spinner" /> Connecting…</> : 'Connect'}
        </button>
      </div>
    </form>
  );
}
