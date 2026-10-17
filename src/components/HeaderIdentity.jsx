// Copyright (C) 2026 HidayahTech, LLC
// Which bucket, on which storage address, this tab is connected to (accounts A, v1.66.0).
// REPORT C6: once connected the bucket name appeared nowhere (header said "Generic S3 ·
// Connected"); S4: a link naming another endpoint showed its host nowhere either.
import { useEffect } from 'preact/hooks';
import { PROVIDER_LABELS } from '../lib/provider.js';
import { endpointHost } from '../lib/saved-bucket-labels.js';

export function HeaderIdentity({ bucket, endpoint, provider }) {
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
  return (
    <span class="header-identity" title={`${bucket} on ${host} (${providerName})`}>
      <span class="header-bucket">{bucket}</span>
      <span class="header-host">{host}</span>
    </span>
  );
}
