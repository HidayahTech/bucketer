// Copyright (C) 2026 HidayahTech, LLC
// Cheap liveness probe for a download job: is this job going to work at all?
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// THE PROBLEM THIS SOLVES. The browser-managed tier cannot observe whether a download
// succeeded — the transfer belongs to the browser. So a job with bad credentials, a missing
// CORS rule, a skewed clock, or a wholesale deny issues thousands of downloads that all fail
// silently, and the app reports every one of them as ISSUED. One probe before the first file
// turns that into an error the user can act on.
//
// EVERY FILE IS PROBED — the original design sampled ~20 probes per job to halve request
// count, and that saving bought two things: per-file failures issued as if they would
// succeed, and (BUG-053) no network round trip pacing most issues, so pending download
// navigations were replaced before their responses arrived. download-queue.js owns the
// per-file semantics; this module only classifies one probe's result.
//
// WHY A RANGE GET AND NOT A HEAD. The presigned URL signs the method: SigV4 covers it, so a
// HEAD against a GET signature is rejected. `Range: bytes=0-0` is a GET that transfers one
// byte.
//
// WHY RAW fetch AND NOT client.send(GetObjectCommand). `Range` is a CORS-safelisted request
// header, so this costs one round trip with no OPTIONS preflight. Going through the SDK
// attaches `Authorization` and `x-amz-*`, none of which are safelisted, adding a preflight to
// every probe. Same reasoning as the chunk transport in the design doc.

export const PROBE_KIND = {
  OK:        'ok',
  DENIED:    'denied',
  MISSING:   'missing',
  TRANSIENT: 'transient',
  NETWORK:   'network',
};

// A 416 means the object exists and simply has no byte 0 — it is empty. That is a readable
// object, not a failure, and a job of empty files must not be blocked by it.
function kindForStatus(status) {
  if (status === 416 || status < 400) return PROBE_KIND.OK;
  if (status === 404) return PROBE_KIND.MISSING;
  if (status === 408 || status === 429 || status >= 500) return PROBE_KIND.TRANSIENT;
  // Everything else in the 4xx range — 401, 403, and the 400 a malformed signature earns —
  // is treated as a denial, because each of those causes is job-wide rather than per-key.
  return PROBE_KIND.DENIED;
}

// probeUrl(url, { fetchImpl }) -> { kind, status, message }
// `url` must be the exact presigned URL that will be handed to the download manager:
// the signature covers the query string, so appending or reordering anything invalidates it.
export async function probeUrl(url, { fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return { kind: kindForStatus(resp.status), status: resp.status, message: `HTTP ${resp.status}` };
  } catch (err) {
    // A thrown fetch is the CORS and offline case: the browser will not say which, by design.
    return { kind: PROBE_KIND.NETWORK, status: null, message: err?.message || String(err) };
  }
}

// WHAT BLOCKS A JOB lives in download-queue.js, not here: NETWORK blocks immediately
// (CORS/offline is job-wide by nature); a single DENIED fails only its own file, and only
// a streak of consecutive denials blocks — because AWS answers 403, not 404, for a
// missing key when the caller lacks s3:ListBucket, so one DENIED may be one deleted
// object [documented AWS behavior, not yet measured against real AWS — see
// docs/manual-checks/preflight-real-providers.md].

// What to tell the user when a job stops. The two blocking kinds have entirely different
// remedies — rotate a key versus edit a bucket's CORS rules — so they are never collapsed
// into one generic failure. The browser deliberately refuses to distinguish a CORS rejection
// from an offline network, which is why that message names both.
export function blockedMessage(probe) {
  switch (probe?.kind) {
    case PROBE_KIND.DENIED:
      return `The bucket refused the download (HTTP ${probe.status ?? '4xx'}). The credentials may `
           + 'have expired, the access key may not have read permission for these objects, or this '
           + "computer's clock may be too far off for the signature to be accepted.";
    case PROBE_KIND.NETWORK:
      return 'The download could not reach the bucket. This is usually a missing CORS rule on the '
           + 'bucket, but it is also what a dropped network connection looks like — the browser '
           + `does not say which. (${probe.message || 'request failed'})`;
    default:
      return 'The download was stopped by a problem affecting the whole job.';
  }
}
