// Copyright (C) 2026 HidayahTech, LLC
// Create a browser-managed download job, and account for the jobs that already ran.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// The folder is listed BEFORE the job is offered, so the confirm button carries real
// numbers — "Send 412 files (840 GB) to my browser" — rather than an abstract caution.
// Most providers bill egress, and someone about to move a terabyte should see the size at
// the moment they decide, not afterwards.
//
// EVERY PERSISTED JOB RENDERS EXACTLY ONE ROW, AND EVERY ROW CARRIES DISCARD. The rows
// come from one total classifier (download-lifecycle.js), not from per-section filters —
// two independent filters once showed a job twice and, worse, stranded one entirely: no
// resume, no check, no Discard, its manifest permanent (postmortem F3/F6). Capability
// gates may hide an action (the folder check needs showDirectoryPicker, Chromium-only),
// never a row.
//
// `api` is the only seam — App supplies the record/enumeration wiring, tests supply fakes,
// and this component touches neither IndexedDB nor the SDK.
import { useState, useEffect, useRef } from 'preact/hooks';
import { Modal } from './Modal.jsx';
import { formatBytes } from '../lib/format.js';
import { NAMING_MODES } from '../lib/download-naming.js';
import { selectTier, tierLabel, TIERS } from '../lib/browser-capability.js';
import { JOB_CLASS } from '../lib/download-lifecycle.js';
import { prefixRoot } from '../lib/download-roots.js';

export function DownloadJobPanel({ bucket, scope, api, onStart, onClose, onUseTransferTool,
                                   capabilities = null }) {
  const isFolder = scope.kind === 'folder';
  const roots = isFolder ? [prefixRoot(scope.prefix || '')] : scope.roots;
  // The transfer-tool generator is prefix-scoped, so the link renders only when this
  // panel's scope is exactly one prefix root (spec decision 3).
  const showTransferTool = !!onUseTransferTool && isFolder;

  const [mode, setMode] = useState(NAMING_MODES.LEAF);
  const [phase, setPhase] = useState('options');   // options | listing | ready | error
  const [counts, setCounts] = useState({ objects: 0, bytes: 0, archived: 0, archivedBytes: 0 });
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [verifyError, setVerifyError] = useState(null);
  const scanCancelled = useRef(false);

  // showDirectoryPicker is Chromium-only. Offering a button that throws on Firefox and
  // Safari is worse than offering nothing — but only the ACTION is gated, never the row.
  const canVerify = !!capabilities?.directoryPicker;

  // What the offer may promise: archived objects are in the totals but can never be sent,
  // and the count and the size must describe the same set of files.
  const sendable = Math.max(0, counts.objects - (counts.archived || 0));
  const sendableBytes = Math.max(0, counts.bytes - (counts.archivedBytes || 0));

  const scopeText = isFolder ? (scope.prefix ? `${bucket}/${scope.prefix}` : bucket) : scope.label;

  // Only the handoff mechanism is built, so that is what is named — a browser that could do
  // better is not told about a capability the application does not yet have. When the other
  // mechanisms land this becomes selectTier(capabilities, { largestFileBytes, quotaBytes }).
  const tier = capabilities ? selectTier(capabilities, { prefer: TIERS.HANDOFF }) : TIERS.HANDOFF;

  // A job from an earlier session is the reason the manifest is durable at all, so it has
  // to be reachable here — resumable, checkable, or at minimum discardable.
  useEffect(() => { refreshJobs(); }, [api]);

  async function refreshJobs() {
    try { setJobs((await api.listJobs?.()) || []); }
    catch { /* a missing history is not worth an error banner */ }
  }

  async function discardJob(id) {
    try { await api.discard(id); } catch { /* best effort */ }
    setJobs(list => list.filter(j => j.id !== id));
  }

  // The picker must be opened from the click itself — it needs a user gesture, which is
  // why verification can never be automatic.
  async function verify(id) {
    setVerifyError(null);
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'bucketer-downloads', mode: 'read' });
    } catch (err) {
      // Dismissing the picker throws AbortError. That is the user changing their mind,
      // not a failure, and must not leave an error banner behind.
      if (err?.name !== 'AbortError') setVerifyError(err?.message || String(err));
      return;
    }
    try {
      await api.verify(id, dir);
      // The verdicts live on the job row (lastVerify) and may have changed its class —
      // a check that found missing files turns the job resumable. Re-list, don't patch.
      await refreshJobs();
    } catch (err) {
      setVerifyError(err?.message || String(err));
    }
  }

  async function scan() {
    setPhase('listing');
    setError(null);
    scanCancelled.current = false;
    let created = null;
    try {
      created = await api.startJob({ bucket, prefix: isFolder ? (scope.prefix || '') : '', roots, mode, label: isFolder ? null : scope.label });
      setJob(created);
      const result = await api.enumerate(created, {
        onProgress: p => setCounts(c => ({ ...c, ...p })),
        shouldCancel: () => scanCancelled.current,
      });

      // A half-enumerated manifest is not worth keeping: it would resume as a job that
      // silently omits everything the crawl never reached.
      if (result.cancelled) {
        try { await api.discard(created.id); } catch { /* best effort */ }
        setJob(null);
        setCounts({ objects: 0, bytes: 0, archived: 0, archivedBytes: 0 });
        setPhase('options');
        return;
      }

      setCounts({
        objects: result.objects, bytes: result.bytes,
        archived: result.archived ?? 0, archivedBytes: result.archivedBytes ?? 0,
      });
      setPhase('ready');
    } catch (err) {
      // An enumeration failure leaves nothing usable behind, so drop the empty job rather
      // than leaving a phantom in the list.
      if (created) { try { await api.discard(created.id); } catch { /* best effort */ } }
      setJob(null);
      setError(err?.message || String(err));
      setPhase('error');
    }
  }

  async function close() {
    // While a crawl is running, deleting its job would pull the record out from under it and
    // the next page it writes would fail. Signal the crawl instead; scan() discards once it
    // has actually stopped.
    if (phase === 'listing') {
      scanCancelled.current = true;
      onClose();
      return;
    }
    // Backing out after listing must not leave an orphaned job behind.
    if (job && phase !== 'started') { try { await api.discard(job.id); } catch { /* best effort */ } }
    onClose();
  }

  function start() {
    setPhase('started');
    onStart(job);
    onClose();
  }

  function lastVerifySummary(v) {
    const parts = [`${v.confirmed.toLocaleString()} confirmed`];
    if (v.missing > 0) parts.push(`${v.missing.toLocaleString()} missing`);
    if (v.mismatched > 0) parts.push(`${v.mismatched.toLocaleString()} the wrong size`);
    if (v.renamed > 0) parts.push(`${v.renamed.toLocaleString()} probably renamed by the browser`);
    if (v.ambiguous > 0) parts.push(`${v.ambiguous.toLocaleString()} impossible to tell apart`);
    return parts.join(', ');
  }

  const unfinished = jobs.filter(j => j.jobClass === JOB_CLASS.UNFINISHED);
  const sent = jobs.filter(j => j.jobClass === JOB_CLASS.SENT);
  const settled = jobs.filter(j => j.jobClass === JOB_CLASS.SETTLED);

  return (
    <Modal onClose={close} class="download-job-dialog">
      <div class="sv-header">
        <div class="modal-title">{isFolder ? 'Download this folder' : 'Download selection'}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="panel-close" onClick={close}>
          Close
        </button>
      </div>

      <div class="download-job-body">
        <p class="download-job-scope">
          {isFolder
            ? <>Downloading <code>{scopeText}</code> and everything beneath it.</>
            : <>Downloading <code>{scopeText}</code>.</>}
        </p>

        <p class="download-job-note" data-testid="tier-notice">
          <strong>{tierLabel(tier)}.</strong> Your browser does the transferring. That makes it
          reliable, but it also means Bucketer cannot see how far along each file is — it can
          only tell you which files it has handed over. Files also arrive as a flat list in
          your downloads folder, because browsers cannot create folders when downloading.
        </p>

        {capabilities?.likelyMobile && (
          <p class="download-job-warning" data-testid="mobile-warning">
            This looks like a phone or tablet. Downloads there are unreliable beyond a few
            hundred megabytes: the browser stops this tab when you switch apps, and the page
            can be closed without warning if it runs short of memory. For anything large, use
            a desktop browser or the command-line option.
          </p>
        )}

        {phase === 'options' && unfinished.length > 0 && (
          <div class="download-job-unfinished">
            <p class="download-job-unfinished-title">Unfinished from an earlier session</p>
            {unfinished.map(u => (
              <div key={u.id} class="download-job-unfinished-row">
                <span class="download-job-unfinished-scope">
                  {u.label || u.prefix || bucket} — {(u.counts.pending + u.counts.failed).toLocaleString()} of{' '}
                  {(u.counters?.sendable ?? u.counters?.total ?? 0).toLocaleString()} still to send
                  {u.counts.issued > 0 && ` (${u.counts.issued.toLocaleString()} already sent)`}
                  {/* A folder check may be what put files back in this pile; the user
                      must see the verdict that did it, not just a bigger to-send count. */}
                  {u.lastVerify && (
                    <span data-testid={`verified-${u.id}`}>
                      {' '}— last check: {lastVerifySummary(u.lastVerify)}
                    </span>
                  )}
                </span>
                <button type="button" class="btn btn-sm" data-testid={`resume-${u.id}`}
                  onClick={() => { onStart(u); onClose(); }}>
                  Resume
                </button>
                <button type="button" class="btn btn-ghost btn-sm" data-testid={`discard-${u.id}`}
                  onClick={() => discardJob(u.id)}>
                  Discard
                </button>
              </div>
            ))}
          </div>
        )}

        {/* This tier hands files to the browser and never learns whether they arrived, so
            a job stays "sent" until the user points at the folder they landed in. Reading
            it costs nothing — no request, no egress — and is the only way to turn "handed
            over" into "actually there". The row renders on every browser; only the check
            action needs the picker. */}
        {phase === 'options' && sent.length > 0 && (
          <div class="download-job-unfinished">
            <p class="download-job-unfinished-title">Sent, but not yet confirmed</p>
            {sent.map(v => (
              <div key={v.id} class="download-job-unfinished-row">
                <span class="download-job-unfinished-scope">
                  {v.label || v.prefix || bucket} — {v.counts.issued.toLocaleString()} files sent
                  {v.lastVerify && (
                    <span data-testid={`verified-${v.id}`}>
                      {' '}— last check: {lastVerifySummary(v.lastVerify)}
                    </span>
                  )}
                </span>
                {canVerify && (
                  <button type="button" class="btn btn-sm" data-testid={`verify-${v.id}`}
                    onClick={() => verify(v.id)}>
                    Check my downloads folder
                  </button>
                )}
                <button type="button" class="btn btn-ghost btn-sm" data-testid={`discard-${v.id}`}
                  onClick={() => discardJob(v.id)}>
                  Discard
                </button>
              </div>
            ))}
            {verifyError && (
              <p class="download-job-error" data-testid="verify-error">
                Could not check the folder: {verifyError}
              </p>
            )}
          </div>
        )}

        {phase === 'options' && settled.length > 0 && (
          <div class="download-job-unfinished">
            <p class="download-job-unfinished-title">Confirmed complete</p>
            {settled.map(s => (
              <div key={s.id} class="download-job-unfinished-row">
                <span class="download-job-unfinished-scope">
                  {s.label || s.prefix || bucket} — all {s.counts.done.toLocaleString()} files confirmed
                </span>
                <button type="button" class="btn btn-ghost btn-sm" data-testid={`discard-${s.id}`}
                  onClick={() => discardJob(s.id)}>
                  Discard
                </button>
              </div>
            ))}
          </div>
        )}

        {phase === 'options' && (
          <>
            <div class="download-job-modes">
              <button
                type="button"
                class={mode === NAMING_MODES.LEAF ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
                data-testid="mode-leaf"
                aria-pressed={mode === NAMING_MODES.LEAF ? 'true' : 'false'}
                onClick={() => setMode(NAMING_MODES.LEAF)}
              >
                Just the file name
              </button>
              <button
                type="button"
                class={mode === NAMING_MODES.FLATTEN ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
                data-testid="mode-flatten"
                aria-pressed={mode === NAMING_MODES.FLATTEN ? 'true' : 'false'}
                onClick={() => setMode(NAMING_MODES.FLATTEN)}
              >
                Keep the folder path in the name
              </button>
            </div>
            <p class="download-job-hint">
              {mode === NAMING_MODES.LEAF
                ? 'photos/2024/trip.jpg arrives as trip.jpg. Shorter, but files with the same name from different folders will collide.'
                : 'photos/2024/trip.jpg arrives as photos__2024__trip.jpg. Longer, but you can tell where each file came from.'}
            </p>

            <div class="download-job-actions">
              <button type="button" class="btn btn-sm" data-testid="scan" onClick={scan}>
                Check this folder
              </button>
              {showTransferTool && (
                <button type="button" class="btn btn-ghost btn-sm" data-testid="use-transfer-tool"
                  onClick={onUseTransferTool}>
                  Use a transfer tool instead
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'listing' && (
          <>
            <p class="download-job-status">
              Listing files… found {counts.objects.toLocaleString()} so far.
            </p>
            <div class="download-job-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-testid="cancel-scan"
                onClick={() => { scanCancelled.current = true; }}>
                Stop listing
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <p class="download-job-error">Could not list this folder: {error}</p>
        )}

        {phase === 'ready' && counts.objects === 0 && (
          <p class="download-job-status">There are no files here to download.</p>
        )}

        {phase === 'ready' && counts.objects > 0 && (
          <>
            <p class="download-job-status">
              Found <strong>{counts.objects.toLocaleString()}</strong> files,{' '}
              <strong>{formatBytes(counts.bytes)}</strong> in total.
            </p>
            {/* Archived objects were recorded at enumeration and will never be issued.
                Counting them in the offer would promise files that cannot arrive, and this
                tier cannot report their absence — the user would simply never see them. */}
            {counts.archived > 0 && (
              <p class="download-job-warning" data-testid="archived-notice">
                <strong>{counts.archived.toLocaleString()}</strong> of these
                ({formatBytes(counts.archivedBytes)}) are archived (Glacier or Deep Archive)
                and cannot be downloaded until you restore them in AWS. They will be left out.
              </p>
            )}
            <p class="download-job-warning">
              Most providers bill for egress — moving this much data out of your bucket may
              cost money. Check your provider's pricing if you are not sure.
            </p>
            <div class="download-job-actions">
              {sendable > 0 && (
                <button type="button" class="btn btn-sm" data-testid="start" onClick={start}>
                  Send {sendable.toLocaleString()} files ({formatBytes(sendableBytes)}) to my browser
                </button>
              )}
              {showTransferTool && (
                <button type="button" class="btn btn-ghost btn-sm" data-testid="use-transfer-tool"
                  onClick={onUseTransferTool}>
                  Use a transfer tool instead
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
