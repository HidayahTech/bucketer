// Wraps GetObjectCommand input for presigned GETs so the signed, content-bearing
// response is never written to the browser's disk cache. Preview and share URLs
// render content inline and embed a SigV4 signature; without
// ResponseCacheControl: 'no-store' the bytes can linger in the HTTP disk cache
// after the presigned URL has expired (#13). Callers may still override the
// default by passing their own ResponseCacheControl.
export function presignGetParams(params) {
  return { ResponseCacheControl: 'no-store', ...params };
}

// Build a Content-Disposition header value that survives the trip to disk (BUG-049).
//
// This is load-bearing rather than cosmetic. MDN is explicit that the `download`
// attribute "only works for same-origin URLs, or the blob: and data: schemes", and our
// presigned S3 URLs are cross-origin — so in every browser this header is the ONLY thing
// naming the saved file. It also wins over the attribute when both are present.
//
// Two parameters, per RFC 6266:
//   filename="…"        an ASCII-only fallback, safe inside a quoted string
//   filename*=UTF-8''…  the real name, percent-encoded per RFC 5987
//
// Percent-encoding is correct in the ext-value and WRONG in the quoted string — encoding
// the whole name with encodeURIComponent is what made "my file.jpg" land as
// "my%20file.jpg".
export function contentDispositionAttachment(filename) {
  // A header value can never carry CR/LF.
  const clean = String(filename ?? '').replace(/[\r\n]/g, '');

  // Quoted-string fallback: ASCII only, and no " or \ that could end the parameter early.
  const ascii = clean.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

  // RFC 5987 ext-value. encodeURIComponent leaves ! ~ * ' ( ) alone; of those, attr-char
  // forbids * ' ( ), so they need finishing by hand.
  const encoded = encodeURIComponent(clean)
    .replace(/[*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// GetObject params for a "save this to disk" download, as opposed to an inline preview.
// Every download call site goes through here so the disposition is built one way.
export function presignDownloadParams({ Bucket, Key, filename }) {
  return presignGetParams({
    Bucket,
    Key,
    ResponseContentDisposition: contentDispositionAttachment(filename),
  });
}
