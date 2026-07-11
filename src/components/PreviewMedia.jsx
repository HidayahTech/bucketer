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
    // sandbox="allow-scripts" (not "") so Firefox's script-based pdf.js viewer can render the
    // PDF (BUG #46). Safe here despite allow-scripts because:
    //   (1) the preview URL is presigned with ResponseContentType: 'application/pdf'
    //       (usePreview.js), so the frame is always served AS a PDF — the browser hands it to
    //       its PDF viewer and never interprets the bytes as executable HTML; and
    //   (2) there is NO allow-same-origin, so any script runs in an opaque origin with no
    //       access to our credentials (sessionStorage), cookies, DOM, or storage.
    // allow-scripts also still blocks forms, top-navigation, popups, and plugins.
    return <iframe src={url} class="preview-pdf" title={alt ?? ''} sandbox="allow-scripts" />;
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
