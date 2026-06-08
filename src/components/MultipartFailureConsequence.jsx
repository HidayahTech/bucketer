// Copyright (C) 2026 HidayahTech, LLC
// Provider-specific guidance shown when a multipart upload fails (§4.10).
//
// WHY THIS FILE EXISTS: MultipartFailureConsequence was defined at the bottom of
// UploadQueue.jsx but has no dependency on UploadQueue's state, props, or any
// local functions. It is a pure display component. Moving it here makes it easy
// to find and update when provider-specific behavior changes without navigating
// the 1000+ line UploadQueue.jsx file.
//
// WHAT BELONGS HERE: provider-specific explanatory text for what happens to
// incomplete multipart parts when an upload fails.
//
// WHAT DOES NOT BELONG HERE: upload state management, error detection, or any
// S3 operations. Those live in UploadQueue.jsx / upload-cleanup.js.

export function MultipartFailureConsequence({ provider }) {
  if (provider === 'r2') {
    return (
      <div style={{ marginTop: '.3rem' }}>
        <strong>R2:</strong> Incomplete multipart uploads are automatically aborted after 7 days — no manual cleanup needed.
      </div>
    );
  }
  if (provider === 'b2') {
    return (
      <div style={{ marginTop: '.3rem' }}>
        <strong>B2:</strong> Incomplete parts may remain and accrue storage charges until aborted.
        Check your bucket's incomplete multipart uploads and abort them via the B2 console or CLI.
        Consider setting a lifecycle rule to auto-abort incomplete uploads.
      </div>
    );
  }
  return (
    <div style={{ marginTop: '.3rem' }}>
      Incomplete multipart parts may remain on the provider and accrue storage charges.
      Check your provider's console for incomplete multipart uploads.
    </div>
  );
}
