// Copyright (C) 2026 HidayahTech, LLC
// Create a browser-managed download job.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// The folder is listed BEFORE the job is offered, so the confirm button carries real
// numbers — "Send 412 files (840 GB) to my browser" — rather than an abstract caution.
// Most providers bill egress, and someone about to move a terabyte should see the size at
// the moment they decide, not afterwards.
//
// This panel is also where the tier's limits are stated plainly: the files arrive flat
// rather than as folders, and Bucketer cannot report transfer progress once the browser
// takes over. Saying so here is what lets the queue row stay honest later.
//
// `api` is the only seam — App supplies the record/enumeration wiring, tests supply fakes,
// and this component touches neither IndexedDB nor the SDK.
import { useState, useEffect } from 'preact/hooks';
import { Modal } from './Modal.jsx';
import { formatBytes } from '../lib/format.js';
import { NAMING_MODES } from '../lib/download-naming.js';
import { selectTier, tierLabel, TIERS } from '../lib/browser-capability.js';

export function DownloadJobPanel({ bucket, prefix = '', api, onStart, onClose, onUseTransferTool,
                                   capabilities = null }) {
  const [mode, setMode] = useState(NAMING_MODES.LEAF);
  const [phase, setPhase] = useState('options');   // options | listing | ready | error
  const [counts, setCounts] = useState({ objects: 0, bytes: 0 });
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [unfinished, setUnfinished] = useState([]);

  const scope = prefix ? `${bucket}/${prefix}` : bucket;

  // Only the handoff mechanism is built, so that is what is named — a browser that could do
  // better is not told about a capability the application does not yet have. When the other
  // mechanisms land this becomes selectTier(capabilities, { largestFileBytes, quotaBytes }).
  const tier = capabilities ? selectTier(capabilities, { prefer: TIERS.HANDOFF }) : TIERS.HANDOFF;

  // A job interrupted in an earlier session is the reason the manifest is durable at all,
  // so it has to be reachable. The download entry point is where someone will look.
  useEffect(() => {
    let live = true;
    api.listUnfinished?.().then(
      jobs => { if (live) setUnfinished(jobs || []); },
      () => { /* a missing history is not worth an error banner */ },
    );
    return () => { live = false; };
  }, [api]);

  async function discardUnfinished(id) {
    try { await api.discard(id); } catch { /* best effort */ }
    setUnfinished(list => list.filter(j => j.id !== id));
  }

  async function scan() {
    setPhase('listing');
    setError(null);
    let created = null;
    try {
      created = await api.startJob({ bucket, prefix, mode });
      setJob(created);
      const result = await api.enumerate(created, { onProgress: p => setCounts({ ...p }) });
      setCounts({ objects: result.objects, bytes: result.bytes });
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
    // Backing out after listing must not leave an orphaned job behind.
    if (job && phase !== 'started') { try { await api.discard(job.id); } catch { /* best effort */ } }
    onClose();
  }

  function start() {
    setPhase('started');
    onStart(job);
    onClose();
  }

  return (
    <Modal onClose={close} class="download-job-dialog">
      <div class="sv-header">
        <div class="modal-title">Download this folder</div>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="panel-close" onClick={close}>
          Close
        </button>
      </div>

      <div class="download-job-body">
        <p class="download-job-scope">
          Downloading <code>{scope}</code> and everything beneath it.
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
                  {u.prefix || bucket} — {u.remaining.toLocaleString()} of{' '}
                  {(u.counters?.total ?? 0).toLocaleString()} still to send
                </span>
                <button type="button" class="btn btn-sm" data-testid={`resume-${u.id}`}
                  onClick={() => { onStart(u); onClose(); }}>
                  Resume
                </button>
                <button type="button" class="btn btn-ghost btn-sm" data-testid={`discard-${u.id}`}
                  onClick={() => discardUnfinished(u.id)}>
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
              {onUseTransferTool && (
                <button type="button" class="btn btn-ghost btn-sm" data-testid="use-transfer-tool"
                  onClick={onUseTransferTool}>
                  Use a transfer tool instead
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'listing' && (
          <p class="download-job-status">
            Listing files… found {counts.objects.toLocaleString()} so far.
          </p>
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
            <p class="download-job-warning">
              Most providers bill for egress — moving this much data out of your bucket may
              cost money. Check your provider's pricing if you are not sure.
            </p>
            <div class="download-job-actions">
              <button type="button" class="btn btn-sm" data-testid="start" onClick={start}>
                Send {counts.objects.toLocaleString()} files ({formatBytes(counts.bytes)}) to my browser
              </button>
              {onUseTransferTool && (
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
