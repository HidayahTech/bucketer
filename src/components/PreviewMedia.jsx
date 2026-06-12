// Copyright (C) 2026 HidayahTech, LLC
// Shared media preview renderer used by both Browser (modal) and DownloadPage.
// Pure rendering — no hooks, no S3 calls. Callers supply kind + url/text.
//
// Props:
//   kind       — 'image' | 'audio' | 'video' | 'pdf' | 'text'
//   url        — presigned URL (for image/audio/video/pdf)
//   text       — fetched content string (for text)
//   truncated  — whether text was capped at 100 KB (for text)
//   alt        — accessible label used as img alt and iframe title (for image/pdf)
//   pixelated  — whether to apply the pixel-art upscaling class (for image)
//   onLoad     — img onLoad callback for pixel-size detection (for image)
export function PreviewMedia({ kind, url, text, truncated, alt, pixelated, onLoad }) {
  if (kind === 'image' && url) {
    return (
      <img
        src={url}
        alt={alt ?? ''}
        class={`preview-media${pixelated ? ' preview-media--pixelated' : ''}`}
        onLoad={onLoad}
      />
    );
  }
  if (kind === 'audio' && url) {
    return <audio controls src={url} class="preview-audio" />;
  }
  if (kind === 'video' && url) {
    return <video controls src={url} class="preview-media" />;
  }
  if (kind === 'pdf' && url) {
    return <iframe src={url} class="preview-pdf" title={alt ?? ''} sandbox="" />;
  }
  if (kind === 'text' && text !== null && text !== undefined) {
    return (
      <div class="preview-text-wrap">
        <pre class="preview-text">{text}</pre>
        {truncated && (
          <div class="preview-truncated">Preview limited to 100 KB — download for the full file.</div>
        )}
      </div>
    );
  }
  return null;
}
