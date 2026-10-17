// Copyright (C) 2026 HidayahTech, LLC
// Where the connected bucket lives, on the line under the bucket title (layout A, v1.67.0; it sat
// in the header in accounts A, v1.66.0, beside the tab that already named the bucket).
// REPORT C6: once connected the bucket name appeared nowhere; S4: a link naming another endpoint
// showed its host nowhere either.
import { useEffect } from 'preact/hooks';
import { PROVIDER_LABELS } from '../lib/provider.js';
import { endpointHost } from '../lib/saved-bucket-labels.js';

const KEY_TAIL = 4;

export function BucketIdentity({ bucket, endpoint, provider, keyId = '', basePrefix = '' }) {
  const host = endpointHost(endpoint);
  // The tab title names the bucket too, so several Bucketer tabs can be told apart.
  useEffect(() => {
    const before = document.title;
    document.title = `${bucket} — Bucketer`;
    return () => {
      document.title = before;
    };
  }, [bucket]);
  const providerName = (provider && PROVIDER_LABELS[provider]) || 'S3';
  const tail = keyId.length > KEY_TAIL ? `…${keyId.slice(-KEY_TAIL)}` : keyId;
  return (
    <p class="bucket-identity">
      {providerName}
      {tail && ` · key ${tail}`}
      {' · '}
      <span class="bucket-identity-host">{host}</span>
      {' · Base folder: '}
      {basePrefix ? <strong>{basePrefix}</strong> : 'none (whole bucket)'}
    </p>
  );
}
