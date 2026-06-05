// Copyright (C) 2026 HidayahTech, LLC
// CORS configuration template for S3-compatible buckets (§4.2, §5 CORS setup).
//
// AllowedHeaders must include the amz-sdk headers explicitly — the x-amz-* wildcard
// does not cover amz-sdk-invocation-id or amz-sdk-request (no x-amz- prefix).
// Without these, B2 rejects the preflight for SDK-issued requests. (CORS B2 headers fix)

// POSIX single-quote escaping for corsCmd shell command arguments.
// Wraps s in single quotes and escapes any embedded single quotes as '\''.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export function corsJson(origin) {
  return JSON.stringify({
    CORSRules: [{
      AllowedOrigins: [origin],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'POST', 'DELETE'],
      AllowedHeaders: ['Authorization', 'Content-Type', 'Content-MD5', 'x-amz-*', 'amz-sdk-invocation-id', 'amz-sdk-request', 'ETag'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
      MaxAgeSeconds: 3600,
    }],
  }, null, 2);
}
