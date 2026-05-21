import { useState } from 'preact/hooks';
import { detectProvider, extractRegion, PROVIDERS, PROVIDER_LABELS, needsCorsConfig } from '../lib/provider.js';

// Credential entry form (§4.5, §4.8)

const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';

function CorsSetupGuide({ provider, bucket, endpoint }) {
  if (!provider || !needsCorsConfig(provider)) return null;

  const origin = isFileProtocol ? '"null"' : (typeof window !== 'undefined' ? `"${window.location.origin}"` : '"https://yourdomain.com"');
  const endpointDisplay = endpoint || 'https://s3.<region>.backblazeb2.com';
  const bucketDisplay = bucket || '<your-bucket-name>';

  const corsJson = JSON.stringify({
    CORSRules: [{
      AllowedOrigins: [isFileProtocol ? 'null' : (typeof window !== 'undefined' ? window.location.origin : 'https://yourdomain.com')],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'POST'],
      AllowedHeaders: ['Authorization', 'Content-Type', 'Content-MD5', 'x-amz-*', 'ETag'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
      MaxAgeSeconds: 3600,
    }],
  }, null, 2);

  const cliCommand = `aws s3api put-bucket-cors \\
  --endpoint-url ${endpointDisplay} \\
  --bucket ${bucketDisplay} \\
  --cors-configuration '${corsJson}'`;

  return (
    <details class="cors-guide">
      <summary>
        {isFileProtocol
          ? '⚠ CORS setup required before connecting'
          : 'CORS setup required before connecting'}
      </summary>
      <div class="cors-guide-body">
        {isFileProtocol && (
          <p class="cors-note cors-note-warn">
            You are running from <code>file://</code>. The browser sends <code>Origin: null</code>
            for local files — your bucket's CORS rules must explicitly allow <code>"null"</code> as
            an origin or every request will be blocked.
          </p>
        )}
        {provider === PROVIDERS.B2 && (
          <p class="cors-note">
            B2: do not use your master application key — create a dedicated application key.
            If B2 says "bucket contains B2 Native CORS rules", remove them with the B2 CLI first.
          </p>
        )}
        <p style={{ marginBottom: '.4rem' }}>Run this command with the AWS CLI:</p>
        <pre class="cors-cmd">{cliCommand}</pre>
        <p class="cors-note">
          If you're deploying to a domain later, replace the origin with your domain URL
          (e.g. <code>"https://yourdomain.com"</code>) or add both to <code>AllowedOrigins</code>.
        </p>
      </div>
    </details>
  );
}

const PROVIDER_OPTIONS = [
  { value: '', label: 'Auto-detect from endpoint' },
  ...Object.entries(PROVIDER_LABELS).map(([v, l]) => ({ value: v, label: l })),
];

export function CredentialForm({ initial, onSave, loading }) {
  const [form, setForm] = useState({
    endpoint: initial.endpoint || '',
    bucket: initial.bucket || '',
    keyId: initial.keyId || '',
    secretKey: initial.secretKey || '',
    providerOverride: initial.provider || '',
    regionOverride: initial.regionOverride || '',
  });

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  // Auto-detect provider label for display
  const detected = form.endpoint ? detectProvider(form.endpoint) : null;
  const detectedLabel = detected ? PROVIDER_LABELS[detected] : null;
  const regionHint = detected && form.endpoint
    ? extractRegion(form.endpoint, detected)
    : null;

  function handleSubmit(e) {
    e.preventDefault();
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
        <label>Endpoint URL</label>
        <input
          type="url"
          value={form.endpoint}
          onInput={set('endpoint')}
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
        <label>Bucket Name</label>
        <input
          type="text"
          value={form.bucket}
          onInput={set('bucket')}
          placeholder="my-bucket"
          required
          autocomplete="off"
          spellcheck={false}
        />
      </div>

      <div class="form-group">
        <label>Key ID</label>
        <input
          type="text"
          value={form.keyId}
          onInput={set('keyId')}
          placeholder="Access Key ID"
          required
          autocomplete="username"
          spellcheck={false}
        />
      </div>

      <div class="form-group">
        <label>Secret Key</label>
        <input
          type="password"
          value={form.secretKey}
          onInput={set('secretKey')}
          placeholder="Secret Access Key"
          required
          autocomplete="current-password"
        />
        <span class="hint">Stored in sessionStorage — cleared on tab close.</span>
      </div>

      <div class="form-group">
        <label>Provider Override</label>
        <select value={form.providerOverride} onChange={set('providerOverride')}>
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
          <label>Region</label>
          <input
            type="text"
            value={form.regionOverride}
            onInput={set('regionOverride')}
            placeholder="us-east-1"
            autocomplete="off"
            spellcheck={false}
          />
          <span class="hint">Cannot be auto-detected for this endpoint. For R2, use "auto".</span>
        </div>
      )}

      <div class="form-group">
        <span class="hint" style={{ color: 'var(--text-warn)' }}>
          Use a bucket-scoped application key with minimum required permissions.
          {detected === PROVIDERS.B2 && ' B2: do not use the master application key with the S3 API.'}
        </span>
      </div>

      <CorsSetupGuide
        provider={form.providerOverride || detected}
        bucket={form.bucket}
        endpoint={form.endpoint}
      />

      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={loading}>
          {loading ? <><span class="spinner" /> Connecting…</> : 'Connect'}
        </button>
      </div>
    </form>
  );
}
