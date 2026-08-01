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
// application itself, unmounted mid-job with a queue still running (BUG-050). Loading the
// URL in a hidden frame contains both outcomes: a real download is still taken over by the
// download manager, and an error renders into a frame nobody sees.
//
// WHY A POOL AND NOT ONE REUSED FRAME. Assigning src to a frame with a navigation still in
// flight REPLACES that navigation: the pending request is cancelled and its download never
// starts. With one shared frame, any file whose first response byte took longer than the
// issue pacing was silently lost — measured at half of a 40-file job at 400 ms latency, in
// Chromium and Firefox alike (BUG-053). Issuing each file into its own frame removes that
// coupling; recycling the oldest frame bounds the DOM cost at MAX_DOWNLOAD_FRAMES. A frame
// is only recycled after the pool cycles through, which at the issue pacing gives its
// navigation MAX_DOWNLOAD_FRAMES × the pacing gap to reach headers — and the per-file
// probe in download-queue.js has already absorbed one full round trip before each issue.
//
// Deliberately NO sandbox attribute. `sandbox` without `allow-downloads` blocks downloads
// outright, and BUG-038 is the local precedent for a sandbox value breaking one engine.
//
// The `download` attribute is gone with the anchor, and nothing is lost: MDN says it "only
// works for same-origin URLs, or the blob: and data: schemes", and presigned S3 URLs are
// cross-origin in every engine. What names the saved file is the Content-Disposition
// header carried by the presigned URL — see presignDownloadParams().
//
// The browser flattens path separators and renames collisions to "file (1).ext" on its
// own, which is why this tier delivers a flat list and why the app cannot know a file's
// final name.

const CONTAINER_ID = 'bucketer-download-frames';

export const MAX_DOWNLOAD_FRAMES = 8;

// The container is looked up by id rather than held in a module variable so that a wiped
// DOM re-creates it instead of silently issuing into a detached node.
function frameContainer() {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing) return existing;

  const div = document.createElement('div');
  div.id = CONTAINER_ID;
  div.style.display = 'none';
  document.body.appendChild(div);
  return div;
}

// `filename` is unused: this tier cannot name the file, Content-Disposition does. It stays
// in the signature because `issue(url, filename)` is the seam shared with the tiers that
// write to a real filesystem and do control the name.
// eslint-disable-next-line no-unused-vars
export function issueBrowserDownload(url, filename) {
  const container = frameContainer();

  let frame;
  if (container.childElementCount >= MAX_DOWNLOAD_FRAMES) {
    // Recycle the oldest frame. Chromium detaches a transfer from its frame once the
    // download manager takes over; the pool depth exists so that by the time a frame is
    // recycled, its navigation has had pool × pacing-gap (plus the probe round trip) to
    // get there.
    frame = container.firstElementChild;
    container.appendChild(frame);   // move to the back of the recycling order
  } else {
    frame = document.createElement('iframe');
    container.appendChild(frame);
  }

  frame.src = url;
}
