// File type detection for preview and Content-Type handling.
//
// Two complementary strategies:
//   mediaKind(key) / mimeType(key) — extension-based; fast; handles the common case
//   mimeKind(contentType)          — header-based; handles correct Content-Type with
//                                    missing or non-standard extension
//
// SECURITY: text preview always forces ResponseContentType='text/plain' at the call site
// (in Browser.jsx handlePreview). This prevents an uploaded HTML or script file from
// being rendered by the browser when previewed — only raw source text is shown.

const KIND = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  flac: 'audio', aac: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video',
  pdf: 'pdf',
  txt: 'text', text: 'text', log: 'text', md: 'text', markdown: 'text',
  rst: 'text', csv: 'text', tsv: 'text',
  json: 'text', xml: 'text', yaml: 'text', yml: 'text', toml: 'text',
  ini: 'text', cfg: 'text', conf: 'text', sql: 'text',
  js: 'text', ts: 'text', jsx: 'text', tsx: 'text',
  py: 'text', rb: 'text', sh: 'text', bash: 'text', zsh: 'text',
  css: 'text', html: 'text', htm: 'text',
};

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain', text: 'text/plain', log: 'text/plain',
  md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  yaml: 'text/yaml', yml: 'text/yaml', csv: 'text/csv',
};

function fileExt(key) {
  const parts = key.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function mediaKind(key) {
  return KIND[fileExt(key)] || null;
}

export function mimeType(key) {
  return MIME[fileExt(key)] || null;
}

// Derive a previewable kind from a Content-Type header value.
// Handles any image/*, audio/*, video/*, text/* without a lookup table.
export function mimeKind(contentType) {
  if (!contentType) return null;
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('text/')) return 'text';
  if (base === 'application/pdf') return 'pdf';
  if (base === 'application/json' || base === 'application/xml' ||
      base === 'application/javascript' || base === 'application/x-yaml') return 'text';
  return null;
}
