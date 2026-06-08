// Copyright (C) 2026 HidayahTech, LLC
import { isBlockedByExtension, parseS3Error } from '../lib/format.js';
import { MultipartFailureConsequence } from './MultipartFailureConsequence.jsx';

export function ErrorDetailsPanel({ error, isMultipart, isError, provider }) {
  return (
    <div class="upload-error-detail">
      {isBlockedByExtension(error) && (
        <div class="banner banner-warn" style={{ marginBottom: '.4rem', padding: '.4rem .6rem', fontSize: '.78rem' }}>
          <div class="banner-body">
            <strong>Request may have been blocked by a browser extension.</strong>{' '}
            Ad and content blockers (such as uBlock Origin) can intercept uploads
            to URLs matching their filter rules — common targets include filenames
            like <code>analytics.js</code>, <code>tracking.js</code>, and similar.
            Try disabling the extension for this page, or adding the destination
            domain to its allowlist.
          </div>
        </div>
      )}
      <details open>
        <summary>Error details</summary>
        <pre>{JSON.stringify(parseS3Error(error), null, 2)}</pre>
      </details>
      {isMultipart && isError && <MultipartFailureConsequence provider={provider} />}
      {(error.Code === 'NoSuchUpload' || error.name === 'NoSuchUpload') && (
        <div style={{ marginTop: '.3rem' }}>
          The multipart upload session has expired. Incomplete parts have been cleaned up.
        </div>
      )}
    </div>
  );
}
