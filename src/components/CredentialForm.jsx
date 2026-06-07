// Copyright (C) 2026 HidayahTech, LLC
import { useState, useRef } from 'preact/hooks';
import { detectProvider, extractRegion, buildEndpoint, PROVIDERS, PROVIDER_LABELS } from '../lib/provider.js';
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
  // Only treat stored provider as an explicit override if it differs from what
  // auto-detection returns for the stored endpoint. Auto-detected providers should
  // leave the dropdown at "Auto-detect from endpoint".
  const _autoDetected = initial.provider && initial.endpoint
    ? detectProvider(initial.endpoint)
    : null;
  const _initProviderOverride = (initial.provider && initial.provider !== _autoDetected)
    ? initial.provider
    : '';

  // Compute initial inferred region: if the endpoint is stored but no regionOverride
  // is, extract the region so it's visible in the field on load.
  const _initExtractedRegion = (() => {
    if (initial.regionOverride || !initial.endpoint) return null;
    const prov = _initProviderOverride || detectProvider(initial.endpoint);
    return extractRegion(initial.endpoint, prov);
  })();

  // userEditedRef: which fields the user has directly typed/pasted into.
  // Inference only flows from user-edited fields into non-user-edited fields.
  // This is a ref (not state) because it does not affect rendering.
  const userEditedRef = useRef({
    endpoint: !!initial.endpoint,
    // region is user-edited only when a stored regionOverride exists and differs from
    // what extraction gives — a stored value that matches auto-extraction is treated as
    // inferred so that changing the endpoint can update it.
    region: !!(initial.regionOverride && initial.regionOverride !== _initExtractedRegion),
  });

  const [form, setForm] = useState({
    endpoint:         initial.endpoint || '',
    bucket:           initial.bucket || '',
    keyId:            initial.keyId || '',
    secretKey:        initial.secretKey || '',
    providerOverride: _initProviderOverride,
    regionOverride:   initial.regionOverride || _initExtractedRegion || '',
    _infEndpoint:     false,
    _infRegion:       !!(_initExtractedRegion && !initial.regionOverride),
  });

  // applyChange: compute the next form state for a field change, including all
  // inference side-effects. Called by both `set` (input) and `onPaste`.
  function applyChange(prev, k, value) {
    const ue = userEditedRef.current;
    if (k === 'endpoint')       ue.endpoint = true;
    if (k === 'regionOverride') ue.region   = true;

    const next = { ...prev, [k]: value };

    // Editing a field removes its own inferred marker.
    if (k === 'endpoint')       next._infEndpoint = false;
    if (k === 'regionOverride') next._infRegion   = false;

    // ── Endpoint → region ──────────────────────────────────────────────────────
    if (k === 'endpoint' && !ue.region) {
      const prov = next.providerOverride || detectProvider(next.endpoint);
      const extracted = next.endpoint ? extractRegion(next.endpoint, prov) : null;
      if (extracted) {
        next.regionOverride = extracted;
        next._infRegion = true;
      } else if (prev._infRegion) {
        // Endpoint changed and no longer contains a region — clear the inferred value.
        next.regionOverride = '';
        next._infRegion = false;
      }
    }

    // ── Region → endpoint ──────────────────────────────────────────────────────
    if (k === 'regionOverride' && !ue.endpoint) {
      const prov = next.providerOverride
        || (next.endpoint ? detectProvider(next.endpoint) : null);
      const built = (prov && value) ? buildEndpoint(prov, value) : null;
      if (built) {
        next.endpoint = built;
        next._infEndpoint = true;
      } else if (!value && prev._infEndpoint) {
        // Region cleared — remove the inferred endpoint too.
        next.endpoint = '';
        next._infEndpoint = false;
      }
    }

    // ── Provider override change ───────────────────────────────────────────────
    if (k === 'providerOverride') {
      const newProv = value;

      // R2 auto-fills 'auto' as region; clear it when switching away from R2.
      if (prev._infRegion && prev.regionOverride === 'auto' && newProv !== PROVIDERS.R2) {
        next.regionOverride = '';
        next._infRegion = false;
      }

      // Re-extract region from current endpoint using the new provider.
      if (!ue.region && next.endpoint && !next.regionOverride) {
        const extracted = extractRegion(next.endpoint, newProv || detectProvider(next.endpoint));
        if (extracted) {
          next.regionOverride = extracted;
          next._infRegion = true;
        }
      }

      // R2 always uses 'auto' as the SigV4 region.
      if (!ue.region && newProv === PROVIDERS.R2) {
        next.regionOverride = 'auto';
        next._infRegion = true;
      }

      // Rebuild endpoint from new provider + current region (if endpoint not user-owned).
      if (!ue.endpoint && next.regionOverride && newProv) {
        const built = buildEndpoint(newProv, next.regionOverride);
        if (built) {
          next.endpoint = built;
          next._infEndpoint = true;
        } else if (prev._infEndpoint) {
          // New provider can't build an endpoint (e.g. switching to MinIO) — clear inferred.
          next.endpoint = '';
          next._infEndpoint = false;
        }
      }
    }

    return next;
  }

  const set = (k) => (e) => setForm(prev => {
    const next = applyChange(prev, k, e.target.value);
    onFormChange?.(next);
    return next;
  });

  // onPaste: intercepts only when pasted text has surrounding whitespace (common
  // copy/paste artifact). Uses applyChange so inference fires on trimmed pastes too.
  const onPaste = (k) => (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || text === text.trim()) return;
    e.preventDefault();
    const trimmed = text.trim();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end   = el.selectionEnd   ?? el.value.length;
    setForm(prev => {
      const cur  = prev[k] || '';
      const next = applyChange(prev, k, cur.slice(0, start) + trimmed + cur.slice(end));
      onFormChange?.(next);
      return next;
    });
  };

  const errors = credentialErrors(form);
  const hasErrors = Object.keys(errors).length > 0;

  const detected = form.endpoint ? detectProvider(form.endpoint) : null;
  const detectedLabel = detected ? PROVIDER_LABELS[detected] : null;
  // regionHint and needsRegion are removed — the region field is always shown,
  // and inference fills it when the endpoint contains a region.

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
        {form._infEndpoint && (
          <span class="hint">Auto-filled from provider and region</span>
        )}
        {detectedLabel && !form.providerOverride && (
          <span class="hint">Detected: {detectedLabel}</span>
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
        {form._infRegion && (
          <span class="hint">Auto-filled from endpoint URL</span>
        )}
        {!form._infRegion && !form.regionOverride && (
          <span class="hint">
            {form.providerOverride === PROVIDERS.R2
              ? 'R2 uses "auto" as the region — enter your endpoint above to auto-fill.'
              : 'Enter the region for this endpoint (e.g. us-east-1).'}
          </span>
        )}
        {errors.regionOverride && <span class="field-error">{errors.regionOverride}</span>}
      </div>

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
