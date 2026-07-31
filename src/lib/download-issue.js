// Copyright (C) 2026 HidayahTech, LLC
// Hand one presigned URL to the browser's own download manager.
//
// This is the entire DOM surface of the browser-managed download tier, kept separate so
// download-queue.js stays free of the DOM and testable in plain Node.
//
// The `download` attribute does NOTHING for our URLs. MDN: "download only works for
// same-origin URLs, or the blob: and data: schemes" — and presigned S3 URLs are
// cross-origin, in every engine, not just WebKit (BUG-041 described this as a WebKit quirk;
// it is actually spec-conformant behaviour everywhere).
//
// What makes these downloads work, and what names the saved file, is the
// Content-Disposition: attachment header carried by the presigned URL itself — see
// presignDownloadParams(). MDN also confirms the header's filename wins over the attribute
// when both are present.
//
// The attribute is set anyway: it is free, and it becomes load-bearing the moment a
// same-origin or blob: source is added. Note the browser flattens path separators in it and
// renames collisions to "file (1).ext" on its own, which is why this tier delivers a flat
// list and why the app cannot know a file's final name.

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
