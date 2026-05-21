// Structured error display (§4.10)
import { parseS3Error } from '../lib/format.js';

export function ErrorBlock({ error, title, consequence, guidance }) {
  if (!error) return null;
  const parsed = typeof error === 'string' ? { message: error } : parseS3Error(error);
  const isCorsLike = parsed.message?.toLowerCase().includes('fetch') ||
                     parsed.message?.toLowerCase().includes('network') ||
                     parsed.status === null;

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
