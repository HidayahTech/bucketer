// Copyright (C) 2026 HidayahTech, LLC
// Hand one presigned URL to the browser's own download manager.
//
// This is the entire DOM surface of the browser-managed download tier, kept separate so
// download-queue.js stays free of the DOM and testable in plain Node.
//
// WHY A FRAME AND NOT AN ANCHOR. A download only stays a download while the response
// carries Content-Disposition: attachment. An error response does not: a 403 or 404 is a
// small XML body the browser is happy to *render*. Clicking an anchor at that URL therefore
// navigates whatever frame the anchor lives in — and from a top-level anchor that is the
// application itself, unmounted mid-job with a queue still running. Measured in all three
// engines. Loading the URL in a hidden frame contains both outcomes: a real download is
// still taken over by the download manager, and an error renders into a frame nobody sees.
//
// ONE FRAME, REUSED. A job can be thousands of files, so an element per file is an
// unbounded DOM leak; the frame is looked up by id rather than held in a module variable so
// that a wiped DOM re-creates it instead of silently issuing into a detached node.
//
// Deliberately NO sandbox attribute. `sandbox` without `allow-downloads` blocks downloads
// outright, and the configuration proven across the three engines was a plain hidden frame.
// BUG-038 is the local precedent for a sandbox value breaking one engine's rendering.
//
// The `download` attribute is gone with the anchor, and nothing is lost: MDN says it "only
// works for same-origin URLs, or the blob: and data: schemes", and presigned S3 URLs are
// cross-origin in every engine, so it never applied here (BUG-041 recorded this as a WebKit
// quirk; it is spec-conformant behaviour everywhere). What names the saved file is the
// Content-Disposition header carried by the presigned URL — see presignDownloadParams().
//
// The browser flattens path separators and renames collisions to "file (1).ext" on its own,
// which is why this tier delivers a flat list and why the app cannot know a file's final name.

const FRAME_ID = 'bucketer-download-frame';

function downloadFrame() {
  const existing = document.getElementById(FRAME_ID);
  if (existing) return existing;

  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.style.display = 'none';
  document.body.appendChild(frame);
  return frame;
}

// `filename` is unused: this tier cannot name the file, Content-Disposition does. It stays
// in the signature because `issue(url, filename)` is the seam shared with the tiers that
// write to a real filesystem and do control the name.
// eslint-disable-next-line no-unused-vars
export function issueBrowserDownload(url, filename) {
  downloadFrame().src = url;
}
