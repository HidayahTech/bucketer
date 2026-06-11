// Copyright (C) 2026 HidayahTech, LLC
// Presigned URL encoding for fragment-based sharing.
//
// Presigned URLs are encoded as base64url and placed in the #dl= hash parameter.
// The fragment is never transmitted in HTTP requests, so the presigned URL
// (which contains credentials and a signature) is invisible to all servers.
//
// Encoding: btoa(url) with standard base64 → base64url conversion (+ → -, / → _, strip =).
// Presigned URLs are always ASCII (non-ASCII path characters are percent-encoded by the SDK),
// so btoa() is safe without any additional encoding step.

function toBase64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(encoded) {
  const padded = encoded + '=='.slice((encoded.length % 4) || 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

export function encodePresignedUrl(url) {
  return toBase64url(url);
}

export function decodePresignedUrl(encoded) {
  let decoded;
  try {
    decoded = fromBase64url(encoded);
  } catch {
    throw new Error('Invalid encoded URL: base64url decoding failed');
  }
  if (!decoded.startsWith('https://')) {
    throw new Error('Invalid encoded URL: decoded value must start with https://');
  }
  return decoded;
}

export function buildShareLink(presignedUrl) {
  if (window.location.protocol === 'file:') return null;
  const encoded = encodePresignedUrl(presignedUrl);
  const base = window.location.origin + window.location.pathname;
  return `${base}#dl=${encoded}`;
}

export function readShareLink() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const encoded = new URLSearchParams(hash).get('dl');
  if (!encoded) return null;
  try {
    return decodePresignedUrl(encoded);
  } catch {
    return null;
  }
}
