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
//
// Prefix-scoped keys (#60, #65): on the connect screen a denied first listing is very
// often a key restricted to a folder (B2 Name Prefix, IAM s3:prefix) probing the bucket
// root. The scope hint is a first-class block, rendered before any CORS note and on both
// wire shapes (readable 403 and CORS-masked TypeError), with an inline "Set base folder"
// action — the field it names sits a whole form above the error, so "in the form above"
// is a direction, not a control. Gated on basePrefixUnset (only the call site knows) and
// suppressed for bad-credential codes, where a base folder cannot help.
//
// focusOnMount (#65): the connect screen's error renders below a nine-field form — off
// screen on every viewport, with focus still on <body>. When set, the block scrolls
// itself into view and takes focus on every new error, so the failure is seen (and
// announced) instead of silently changing a header pill.
import { useState, useEffect, useRef } from 'preact/hooks';
import { parseS3Error } from '../lib/format.js';
import { runDiagnostics, VERDICT_MESSAGES } from '../lib/connection-diagnostics.js';

const STATUS_ICONS = { pass: '✓', fail: '✗', skip: '–' };

// S3 error codes meaning the credential itself is wrong (AWS convention; B2's codes for a
// bad secret / key ID are unverified — the live probe item records them). A base folder
// cannot fix these, so the scope hint stays out of the way.
const BAD_CREDENTIAL_CODES = new Set(['SignatureDoesNotMatch', 'InvalidAccessKeyId']);
// Other 403/401 codes that are not a prefix restriction either (clock skew, expired or
// invalid session tokens, account state): the provider's own message is the explanation,
// so the scope hint stays out of the way without claiming the credential is wrong.
const NON_SCOPE_CODES = new Set([
  'RequestTimeTooSkewed',
  'ExpiredToken',
  'InvalidToken',
  'AccountProblem',
  'AllAccessDisabled',
]);

export function ErrorBlock({
  error,
  title,
  consequence,
  guidance,
  diagnostics,
  basePrefixUnset,
  basePrefix,
  onSetBaseFolder,
  focusOnMount,
}) {
  const [diag, setDiag] = useState(null); // null | 'running' | { checks, verdict }
  const blockRef = useRef(null);
  // #51: results belong to the error they diagnosed — when a different error
  // lands in the same mounted block, clear them and restore the button.
  useEffect(() => {
    setDiag(null);
  }, [error]);
  // #65: bring the error to the user. Scroll first (sighted), then focus without a second
  // scroll (keyboard + screen reader). jsdom has no scrollIntoView; guard it.
  useEffect(() => {
    if (!focusOnMount || !error || !blockRef.current) return;
    blockRef.current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    blockRef.current.focus({ preventScroll: true });
  }, [error, focusOnMount]);
  if (!error) return null;
  const parsed = typeof error === 'string' ? { message: error } : parseS3Error(error);
  const isCorsLike =
    parsed.message?.toLowerCase().includes('fetch') ||
    parsed.message?.toLowerCase().includes('network') ||
    parsed.status === null;
  const isBadCredential = BAD_CREDENTIAL_CODES.has(parsed.code);
  const isDeniedLike =
    !isBadCredential &&
    !NON_SCOPE_CODES.has(parsed.code) &&
    (parsed.code === 'AccessDenied' || parsed.status === 403 || parsed.status === 401);
  // Which scope-hint variant, if any: 'unset' (no base folder, readable or masked denial),
  // 'set' (a floor is set yet the first listing was still denied — only meaningful on the
  // connect screen, signalled by the action callback), or null.
  let scopeHint = null;
  if (basePrefixUnset && (isDeniedLike || isCorsLike))
    scopeHint = isCorsLike && !isDeniedLike ? 'unset-masked' : 'unset';
  else if (!basePrefixUnset && basePrefix && onSetBaseFolder && isDeniedLike) scopeHint = 'set';
  // The masked variant already explains the CORS possibility and the curl escape hatch, so
  // the generic CORS note would say it twice.
  const showCorsNote = isCorsLike && scopeHint !== 'unset-masked';

  async function handleDiagnose() {
    setDiag('running');
    setDiag(await runDiagnostics(diagnostics));
  }

  const setBaseFolderButton = onSetBaseFolder ? (
    <div style={{ marginTop: '.3rem' }}>
      <button type="button" class="btn btn-sm" onClick={onSetBaseFolder}>
        Set base folder
      </button>
    </div>
  ) : null;

  return (
    <div class="error-block" role="alert" ref={blockRef} tabIndex={focusOnMount ? -1 : undefined}>
      <div class="error-title">{title || 'Error'}</div>
      <div>{parsed.message}</div>
      {consequence && <div style={{ marginTop: '.3rem', fontStyle: 'italic' }}>{consequence}</div>}
      {scopeHint === 'unset' && (
        <div class="scope-hint" style={{ marginTop: '.5rem' }}>
          <div>
            <strong>The most likely reason:</strong> your access key is limited to one folder inside the bucket rather
            than the whole bucket. Backblaze B2 calls this the key's "Name Prefix"; AWS calls it a prefix condition.
          </div>
          <div style={{ marginTop: '.3rem' }}>
            If that's your key, enter that folder as the <strong>Base folder</strong> and connect again.
          </div>
          {setBaseFolderButton}
          <div style={{ marginTop: '.3rem' }}>
            If your key isn't limited to a folder, then the key ID or secret key is wrong for this bucket.
          </div>
        </div>
      )}
      {scopeHint === 'unset-masked' && (
        <div class="scope-hint" style={{ marginTop: '.5rem' }}>
          <div>The browser won't show us why, so there are two likely causes:</div>
          <div style={{ marginTop: '.3rem' }}>
            <strong>1.</strong> Your access key is limited to a folder inside the bucket (Backblaze B2 calls this the
            key's "Name Prefix"). Some providers don't attach CORS headers to a denial, which hides it exactly like
            this. This is free to test: enter that folder as the <strong>Base folder</strong> and connect again.
          </div>
          {setBaseFolderButton}
          <div style={{ marginTop: '.3rem' }}>
            <strong>2.</strong> Your bucket's CORS rules don't allow this page. See the setup guide under the form for
            your provider's exact command.
          </div>
          <div style={{ marginTop: '.3rem' }}>
            To see the real error, run the same request with curl or the AWS CLI — those aren't subject to CORS.
          </div>
        </div>
      )}
      {scopeHint === 'set' && (
        <div class="scope-hint" style={{ marginTop: '.5rem' }}>
          <div>
            Your <strong>Base folder</strong> is set to <code>{basePrefix}</code>, but the key was still denied there.
            If the key is limited to a different folder, correct the Base folder and connect again.
          </div>
          {setBaseFolderButton}
          <div style={{ marginTop: '.3rem' }}>Otherwise the key ID or secret key may be wrong for this bucket.</div>
        </div>
      )}
      {isBadCredential && onSetBaseFolder && (
        <div style={{ marginTop: '.3rem' }}>The key ID or secret key is wrong for this bucket.</div>
      )}
      {showCorsNote && (
        <div style={{ marginTop: '.3rem' }}>
          <strong>Note:</strong> This may be a CORS error, or it may be an authentication or routing failure masked by
          the browser's CORS layer. Verify your endpoint URL, bucket name, and credentials using a non-browser tool
          (e.g. curl or the AWS CLI) to see the actual error response.
        </div>
      )}
      {isCorsLike && diagnostics && !diag && (
        <div style={{ marginTop: '.3rem' }}>
          <button type="button" onClick={handleDiagnose}>
            Run diagnostics
          </button>
        </div>
      )}
      {diag === 'running' && <div style={{ marginTop: '.3rem' }}>Running diagnostics…</div>}
      {diag && diag !== 'running' && (
        <div style={{ marginTop: '.3rem' }}>
          <div>
            {/* #66: the two-cause verdict defers to the hint block above, so no emphasis */}
            {diag.verdict === 'cors-blocked-or-scoped' ? (
              VERDICT_MESSAGES[diag.verdict]
            ) : (
              <strong>{VERDICT_MESSAGES[diag.verdict]}</strong>
            )}
          </div>
          <ul style={{ margin: '.3rem 0 0', paddingLeft: '1.2rem', listStyle: 'none' }}>
            {diag.checks.map((c) => (
              <li key={c.id}>
                {STATUS_ICONS[c.status]} {c.label}
                {c.detail ? ` — ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* (ux built-review 2) the masked two-cause block already ends with the curl escape
          hatch; the caller's generic CORS guidance would contradict the honest verdict. */}
      {guidance && scopeHint !== 'unset-masked' && <div style={{ marginTop: '.3rem' }}>{guidance}</div>}
      {(parsed.code || parsed.status || parsed.requestId) && (
        <details>
          <summary>Provider response details</summary>
          <pre>
            {JSON.stringify(
              { code: parsed.code, status: parsed.status, requestId: parsed.requestId, message: parsed.message },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}
