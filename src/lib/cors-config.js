// Copyright (C) 2026 HidayahTech, LLC
// CORS configuration template for S3-compatible buckets (§4.2, §5 CORS setup).
//
// AllowedHeaders must include the amz-sdk headers explicitly — the x-amz-* wildcard
// does not cover amz-sdk-invocation-id or amz-sdk-request (no x-amz- prefix).
// Without these, B2 rejects the preflight for SDK-issued requests. (CORS B2 headers fix)
//
// ExposeHeaders is provider-aware (BUG-043): B2 rejects PutBucketCors with
// "illegal '*' in an exposeHeaders value" — wildcards are legal in AllowedHeaders
// but not ExposeHeaders there. For B2 we expose the app's own meta headers
// explicitly; other x-amz-meta-* headers remain unreadable from the browser on
// B2 (metadata panel and move-preservation of third-party metadata degrade).
// All other providers keep the x-amz-meta-* wildcard (BUG-028: without it, all
// stored object metadata is invisible to JavaScript).
import { PROVIDERS } from './provider.js';
import { CONTENT_HASH_KEY, FILE_MTIME_KEY } from './constants.js';

// POSIX single-quote escaping for corsCmd shell command arguments.
// Wraps s in single quotes and escapes any embedded single quotes as '\''.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export function corsJson(origin, provider) {
  const exposeMeta = provider === PROVIDERS.B2
    ? [`x-amz-meta-${CONTENT_HASH_KEY}`, `x-amz-meta-${FILE_MTIME_KEY}`]
    : ['x-amz-meta-*'];
  return JSON.stringify({
    CORSRules: [{
      AllowedOrigins: [origin],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'POST', 'DELETE'],
      AllowedHeaders: ['Authorization', 'Content-Type', 'Content-MD5', 'x-amz-*', 'amz-sdk-invocation-id', 'amz-sdk-request', 'ETag'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', ...exposeMeta],
      MaxAgeSeconds: 3600,
    }],
  }, null, 2);
}
