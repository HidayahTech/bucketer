// Copyright (C) 2026 HidayahTech, LLC
// Structured error display (§4.10).
//
// Parses AWS SDK v3 error objects (Code, $metadata.httpStatusCode, $metadata.requestId)
// and renders them with optional consequence and guidance strings from the call site.
//
// CORS heuristic: when the parsed error has no HTTP status (null) or the message mentions
// 'fetch'/'network', the error is likely CORS-masked. In this case an extra note is shown
// explaining that the actual auth/routing error may be hidden by the browser's CORS layer.
// Users should verify with curl or the AWS CLI to see the real response.
//
// When the `diagnostics` prop ({ endpoint, bucket, forcePathStyle }) is provided and the
// error is CORS-like, a "Run diagnostics" button offers an in-browser differential
// diagnosis (see lib/connection-diagnostics.js). Nothing runs until the user clicks.
import { useState } from 'preact/hooks';
import { parseS3Error } from '../lib/format.js';
import { runDiagnostics, VERDICT_MESSAGES } from '../lib/connection-diagnostics.js';

const STATUS_ICONS = { pass: '✓', fail: '✗', skip: '–' };

export function ErrorBlock({ error, title, consequence, guidance, diagnostics }) {
  const [diag, setDiag] = useState(null); // null | 'running' | { checks, verdict }
  if (!error) return null;
  const parsed = typeof error === 'string' ? { message: error } : parseS3Error(error);
  const isCorsLike = parsed.message?.toLowerCase().includes('fetch') ||
                     parsed.message?.toLowerCase().includes('network') ||
                     parsed.status === null;

  async function handleDiagnose() {
    setDiag('running');
    setDiag(await runDiagnostics(diagnostics));
  }

  return (
    <div class="error-block" role="alert">
      <div class="error-title">{title || 'Error'}</div>
      <div>{parsed.message}</div>
      {consequence && <div style={{ marginTop: '.3rem', fontStyle: 'italic' }}>{consequence}</div>}
      {isCorsLike && (
        <div style={{ marginTop: '.3rem' }}>
          <strong>Note:</strong> This may be a CORS error, or it may be an authentication or
          routing failure masked by the browser's CORS layer. Verify your endpoint URL, bucket
          name, and credentials using a non-browser tool (e.g. curl or the AWS CLI) to see the
          actual error response.
        </div>
      )}
      {isCorsLike && diagnostics && !diag && (
        <div style={{ marginTop: '.3rem' }}>
          <button type="button" onClick={handleDiagnose}>Run diagnostics</button>
        </div>
      )}
      {diag === 'running' && (
        <div style={{ marginTop: '.3rem' }}>Running diagnostics…</div>
      )}
      {diag && diag !== 'running' && (
        <div style={{ marginTop: '.3rem' }}>
          <div><strong>{VERDICT_MESSAGES[diag.verdict]}</strong></div>
          <ul style={{ margin: '.3rem 0 0', paddingLeft: '1.2rem', listStyle: 'none' }}>
            {diag.checks.map(c => (
              <li key={c.id}>
                {STATUS_ICONS[c.status]} {c.label}
                {c.detail ? ` — ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {guidance && <div style={{ marginTop: '.3rem' }}>{guidance}</div>}
      {(parsed.code || parsed.status || parsed.requestId) && (
        <details>
          <summary>Provider response details</summary>
          <pre>{JSON.stringify({ code: parsed.code, status: parsed.status, requestId: parsed.requestId, message: parsed.message }, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
