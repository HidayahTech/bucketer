// Copyright (C) 2026 HidayahTech, LLC
// UI formatting utilities: byte sizes, speeds, ETAs, S3 key leaf names, and S3 error normalization.

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

export function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Leaf name from an object key (everything after the last /)
export function leafName(key) {
  const i = key.lastIndexOf('/');
  return i >= 0 ? key.slice(i + 1) : key;
}

// Normalize AWS SDK v3 error objects (§4.10, §4.12). Provider implementations use
// varying field names (Code vs name, $metadata.httpStatusCode, etc.). parseS3Error
// extracts canonical fields. isPermissionError detects AccessDenied / 403 / 401 to
// transition capability state from 'unknown' or 'permitted' to 'denied'.
export function parseS3Error(err) {
  return {
    message: err?.message || String(err),
    code: err?.Code || err?.name || null,
    status: err?.$metadata?.httpStatusCode || null,
    requestId: err?.$metadata?.requestId || null,
  };
}

export function isPermissionError(err) {
  const code = err?.Code || err?.name || '';
  const status = err?.$metadata?.httpStatusCode;
  return code === 'AccessDenied' || status === 403 || status === 401;
}
