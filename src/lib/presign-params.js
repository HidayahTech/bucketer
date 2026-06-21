// Wraps GetObjectCommand input for presigned GETs so the signed, content-bearing
// response is never written to the browser's disk cache. Preview and share URLs
// render content inline and embed a SigV4 signature; without
// ResponseCacheControl: 'no-store' the bytes can linger in the HTTP disk cache
// after the presigned URL has expired (#13). Callers may still override the
// default by passing their own ResponseCacheControl.
export function presignGetParams(params) {
  return { ResponseCacheControl: 'no-store', ...params };
}
