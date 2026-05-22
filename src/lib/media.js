const KIND = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  flac: 'audio', aac: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video',
};

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
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
// Handles any image/*, audio/*, or video/* type without a lookup table.
export function mimeKind(contentType) {
  if (!contentType) return null;
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  return null;
}
