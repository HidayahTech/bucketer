// Copyright (C) 2026 HidayahTech, LLC
// Hand one presigned URL to the browser's own download manager.
//
// This is the entire DOM surface of the browser-managed download tier, kept separate so
// download-queue.js stays free of the DOM and testable in plain Node.
//
// The `download` attribute is a *suggestion*, not a guarantee: the browser sanitises it,
// strips any path separators (which is why this tier delivers a flat list), and renames
// collisions to "file (1).ext" on its own. It is also ignored for cross-origin responses
// in WebKit (BUG-041), which navigates instead — the presigned URL therefore carries
// Content-Disposition: attachment so the server-side header does the real work.

const ANCHOR_CLEANUP_MS = 1000;

export function issueBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Removing the anchor synchronously can cancel the download in some engines, so it is
  // detached on a timer instead.
  setTimeout(() => a.remove(), ANCHOR_CLEANUP_MS);
}
