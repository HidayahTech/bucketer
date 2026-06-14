// Copyright (C) 2026 HidayahTech, LLC
// Storage viewer and privacy controls (see docs/design-storage-viewer.md).
//
// Renders a point-in-time snapshot of every value the app has stored in
// localStorage, sessionStorage, and IndexedDB. Each category has a scoped
// clear action. "Clear All App Data" at the bottom removes everything and
// reloads. Secret key is never shown — only presence is indicated.
import { useState, useEffect } from 'preact/hooks';
import {
  loadCredentials, clearCredentials,
  loadMaxKeys, loadPartConcurrency, loadPartSizeMB,
  loadFileConcurrency, loadListingCacheTTL, loadUpdateCheckEnabled,
  loadCapabilities, clearCapabilities,
  loadProfiles, deleteProfile,
  wipeAllAppData, resetSettings, deleteAllProfiles,
} from '../lib/storage.js';
import {
  loadUploadLog, clearUploadLog,
  loadAllResumeRecords, clearAllResumeRecords,
  deleteDatabase, loadActiveUploads, clearActiveUploads,
} from '../lib/indexeddb.js';
import { formatBytes } from '../lib/format.js';
import { Modal } from './Modal.jsx';
import { ConfirmDialog } from './ConfirmDialog.jsx';

function age(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function truncate(str, n = 32) {
  if (!str) return null;
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function capIcon(state) {
  if (state === 'permitted') return <span class="sv-cap-ok">✓</span>;
  if (state === 'denied')    return <span class="sv-cap-denied">✗</span>;
  return <span class="sv-cap-unknown">?</span>;
}

function Empty({ text }) {
  return <p class="sv-empty-state">{text}</p>;
}

// Muted monospace annotation shown below a label or header — the raw storage
// key name or JSON field name that corresponds to what's displayed.
function KeyName({ name }) {
  return <span class="sv-key-name">{name}</span>;
}

// Small line at the top of each section body naming where the data lives.
function StoreLoc({ children }) {
  return <p class="sv-store-loc">{children}</p>;
}

function SectionHead({ title, badge }) {
  return (
    <summary class="sv-summary">
      <span class="sv-summary-title">{title}</span>
      {badge != null && badge > 0 && <span class="sv-badge">{badge}</span>}
    </summary>
  );
}

function Actions({ children }) {
  return <div class="sv-actions">{children}</div>;
}

export function StorageModal({ onClose, isConnected }) {
  const [data, setData]               = useState(null);
  const [confirmAction, setConfirm]   = useState(null);
  const [cleared, setCleared]         = useState(null);
  const [wiping, setWiping]           = useState(false);

  async function load() {
    const creds   = loadCredentials();
    const secret  = !!sessionStorage.getItem('s3b_secret_key');
    const { profiles } = loadProfiles();
    const log     = await loadUploadLog().catch(() => []);
    const resume  = await loadAllResumeRecords().catch(() => []);
    const caps    = loadCapabilities();
    const active  = loadActiveUploads();
    const settings = {
      maxKeys:            loadMaxKeys(),
      partConcurrency:    loadPartConcurrency(),
      partSizeMB:         loadPartSizeMB(),
      fileConcurrency:    loadFileConcurrency(),
      listingCacheTTL:    loadListingCacheTTL(),
      updateCheckEnabled: loadUpdateCheckEnabled(),
    };
    setData({ creds, secret, profiles, log, resume, caps, active, settings });
  }

  useEffect(() => {
    load();
    const esc = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  async function act(action) {
    setConfirm(null);
    if (action === 'credentials') {
      clearCredentials();
      window.location.reload();
      return;
    }
    if (action === 'wipe') {
      setWiping(true);
      wipeAllAppData();
      await deleteDatabase();
      window.location.reload();
      return;
    }
    if (action === 'profiles') deleteAllProfiles();
    else if (action === 'log')      await clearUploadLog();
    else if (action === 'resume')   await clearAllResumeRecords();
    else if (action === 'settings') resetSettings();
    else if (action === 'caps')     clearCapabilities();
    else if (action === 'active')   clearActiveUploads();
    setCleared(action);
    setTimeout(() => setCleared(c => c === action ? null : c), 2500);
    await load();
  }

  const val = v => v != null ? String(v) : <span class="sv-nil">— default</span>;
  const controller = { confirmAction, cleared, setConfirm, act };

  return (
    <Modal onClose={onClose} class="storage-dialog">

        <div class="sv-header">
          <div class="modal-title">Storage &amp; Privacy</div>
          <button type="button" class="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
        </div>

        {!data ? (
          <div class="sv-loading">Loading…</div>
        ) : (
          <div class="storage-modal-body">

            {/* ── Connection ────────────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Connection" />
              <div class="sv-section-body">
                <StoreLoc>localStorage · sessionStorage (secret key only)</StoreLoc>
                {!data.creds.endpoint && !data.creds.bucket && !data.creds.keyId ? (
                  <Empty text="No connection data stored." />
                ) : (
                  <table class="sv-table">
                    <tbody>
                      <tr>
                        <td class="sv-key">Endpoint<br/><KeyName name="s3b_endpoint" /></td>
                        <td class="sv-val" title={data.creds.endpoint}>{truncate(data.creds.endpoint, 40) || <span class="sv-nil">—</span>}</td>
                      </tr>
                      <tr>
                        <td class="sv-key">Bucket<br/><KeyName name="s3b_bucket" /></td>
                        <td class="sv-val">{data.creds.bucket || <span class="sv-nil">—</span>}</td>
                      </tr>
                      <tr>
                        <td class="sv-key">Key ID<br/><KeyName name="s3b_key_id" /></td>
                        <td class="sv-val sv-mono">{data.creds.keyId ? truncate(data.creds.keyId, 12) : <span class="sv-nil">—</span>}</td>
                      </tr>
                      <tr>
                        <td class="sv-key">Provider<br/><KeyName name="s3b_provider" /></td>
                        <td class="sv-val">{data.creds.provider || <span class="sv-nil">—</span>}</td>
                      </tr>
                      <tr>
                        <td class="sv-key">Region override<br/><KeyName name="s3b_region_override" /></td>
                        <td class="sv-val">{data.creds.regionOverride || <span class="sv-nil">—</span>}</td>
                      </tr>
                      <tr>
                        <td class="sv-key">Secret key<br/><KeyName name="s3b_secret_key · sessionStorage" /></td>
                        <td class={`sv-val ${data.secret ? 'sv-secret-present' : 'sv-nil'}`}>
                          {data.secret ? 'Present (session only)' : 'Not stored'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                <ConfirmDialog id="credentials" controller={controller}
                  label={isConnected ? 'Clear & disconnect' : 'Clear connection'}
                  warning={isConnected ? 'You are connected. This will disconnect and reload.' : 'This will reload the page.'}
                  danger reload />
              </div>
            </details>

            {/* ── Profiles ──────────────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Saved Profiles" badge={data.profiles.length} />
              <div class="sv-section-body">
                <StoreLoc>localStorage · <KeyName name="s3b_profiles" /> (JSON array) · <KeyName name="s3b_last_profile_id" /> (selected profile)</StoreLoc>
                {data.profiles.length === 0 ? (
                  <Empty text="No saved profiles." />
                ) : (
                  <table class="sv-table">
                    <thead>
                      <tr>
                        <th>Name<br/><KeyName name="name" /></th>
                        <th>Bucket<br/><KeyName name="bucket" /></th>
                        <th>Provider<br/><KeyName name="provider" /></th>
                        <th>Key ID<br/><KeyName name="keyId" /></th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.profiles.map(p => (
                        <tr key={p.id}>
                          <td class="sv-val" title={p.name}>{truncate(p.name, 24)}</td>
                          <td class="sv-val" title={p.bucket}>{truncate(p.bucket, 20)}</td>
                          <td class="sv-val">{p.provider || <span class="sv-nil">—</span>}</td>
                          <td class="sv-val sv-mono" title={p.keyId}>{truncate(p.keyId, 10)}</td>
                          <td>
                            <button type="button" class="btn btn-ghost btn-sm sv-del-btn"
                              onClick={async () => { deleteProfile(p.id); await load(); }}
                              title="Delete this profile">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <ConfirmDialog id="profiles" controller={controller} label="Delete all profiles"
                  warning="All saved profiles will be removed. Credentials on your storage provider are unaffected."
                  danger />
              </div>
            </details>

            {/* ── Upload History ─────────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Upload History" badge={data.log.length} />
              <div class="sv-section-body">
                <StoreLoc>IndexedDB: <KeyName name="s3browser" /> (v2) → <KeyName name="bucketer_upload_log" /> · auto-increment key</StoreLoc>
                {data.log.length === 0 ? (
                  <Empty text="No upload history." />
                ) : (
                  <>
                    <p class="sv-summary-line">
                      {data.log.length} {data.log.length === 1 ? 'entry' : 'entries'}
                      {' · '}{formatBytes(data.log.reduce((s, e) => s + (e.fileSize || 0), 0))}
                      {data.log.filter(e => e.status === 'error').length > 0 &&
                        ` · ${data.log.filter(e => e.status === 'error').length} failed`}
                    </p>
                    <table class="sv-table">
                      <thead>
                        <tr>
                          <th><KeyName name="status" /></th>
                          <th>File<br/><KeyName name="fileName" /></th>
                          <th>Destination<br/><KeyName name="destinationKey" /></th>
                          <th>Size<br/><KeyName name="fileSize" /></th>
                          <th>When<br/><KeyName name="completedAt" /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.log.slice(0, 20).map((e, i) => (
                          <tr key={i}>
                            <td class="sv-status">{e.status === 'done'
                              ? <span class="sv-cap-ok">✓</span>
                              : <span class="sv-cap-denied" title={e.errorMessage}>✗</span>}
                            </td>
                            <td class="sv-val" title={e.fileName}>{truncate(e.fileName, 22)}</td>
                            <td class="sv-val sv-muted" title={e.destinationKey}>{truncate(e.destinationKey, 22)}</td>
                            <td class="sv-num">{formatBytes(e.fileSize)}</td>
                            <td class="sv-num sv-muted">{age(e.completedAt)}</td>
                          </tr>
                        ))}
                        {data.log.length > 20 && (
                          <tr><td colSpan={5} class="sv-more">…and {data.log.length - 20} more</td></tr>
                        )}
                      </tbody>
                    </table>
                  </>
                )}
                <ConfirmDialog id="log" controller={controller} label="Clear history" />
              </div>
            </details>

            {/* ── Incomplete Uploads ─────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Incomplete Uploads" badge={data.resume.length} />
              <div class="sv-section-body">
                <StoreLoc>IndexedDB: <KeyName name="s3browser" /> (v2) → <KeyName name="s3browser_uploads" /> · key: <KeyName name="provider:endpoint:bucket:destinationKey" /></StoreLoc>
                {data.resume.length === 0 ? (
                  <Empty text="No incomplete uploads being tracked." />
                ) : (
                  <table class="sv-table">
                    <thead>
                      <tr>
                        <th>Destination<br/><KeyName name="destinationKey" /></th>
                        <th>Bucket<br/><KeyName name="bucket" /></th>
                        <th>Provider<br/><KeyName name="provider" /></th>
                        <th>Started<br/><KeyName name="startedAt" /></th>
                        <th>Part size<br/><KeyName name="partSize" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.resume.map((r, i) => (
                        <tr key={i}>
                          <td class="sv-val" title={r.destinationKey}>{truncate(r.destinationKey, 26)}</td>
                          <td class="sv-val" title={r.bucket}>{truncate(r.bucket, 18)}</td>
                          <td class="sv-val">{r.provider || <span class="sv-nil">—</span>}</td>
                          <td class="sv-num sv-muted">{age(r.startedAt)}</td>
                          <td class="sv-num sv-muted">{formatBytes(r.partSize)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <ConfirmDialog id="resume" controller={controller} label="Discard all resume records"
                  warning="In-progress uploads cannot be resumed after discarding. Incomplete multipart sessions may remain on the server until they expire or are aborted." />
              </div>
            </details>

            {/* ── Settings ──────────────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Settings" />
              <div class="sv-section-body">
                <StoreLoc>localStorage · cleared on disconnect (same as connection fields)</StoreLoc>
                <table class="sv-table">
                  <tbody>
                    <tr>
                      <td class="sv-key">Max keys per listing<br/><KeyName name="s3b_max_keys" /></td>
                      <td class="sv-val">{val(data.settings.maxKeys)}</td>
                    </tr>
                    <tr>
                      <td class="sv-key">Part concurrency<br/><KeyName name="s3b_part_concurrency" /></td>
                      <td class="sv-val">{val(data.settings.partConcurrency)}</td>
                    </tr>
                    <tr>
                      <td class="sv-key">Part size (MB)<br/><KeyName name="s3b_part_size_mb" /></td>
                      <td class="sv-val">{val(data.settings.partSizeMB)}</td>
                    </tr>
                    <tr>
                      <td class="sv-key">File concurrency<br/><KeyName name="s3b_file_concurrency" /></td>
                      <td class="sv-val">{val(data.settings.fileConcurrency)}</td>
                    </tr>
                    <tr>
                      <td class="sv-key">Listing cache TTL (s)<br/><KeyName name="s3b_listing_cache_ttl" /></td>
                      <td class="sv-val">{val(data.settings.listingCacheTTL)}</td>
                    </tr>
                    <tr>
                      <td class="sv-key">Background update check<br/><KeyName name="s3b_update_check_enabled" /></td>
                      <td class="sv-val">{data.settings.updateCheckEnabled ? 'Enabled' : 'Disabled'}</td>
                    </tr>
                  </tbody>
                </table>
                <ConfirmDialog id="settings" controller={controller} label="Reset to defaults" />
              </div>
            </details>

            {/* ── Runtime State ─────────────────────────────────── */}
            <details class="sv-section" open>
              <SectionHead title="Runtime State" />
              <div class="sv-section-body">
                <p class="sv-sub-heading">Capabilities</p>
                <StoreLoc><KeyName name="s3b_capabilities" /> (JSON) · localStorage · values: <KeyName name="'unknown' | 'permitted' | 'denied'" /></StoreLoc>
                <table class="sv-table">
                  <tbody>
                    {['list', 'download', 'upload', 'delete'].map(op => (
                      <tr key={op}>
                        <td class="sv-key" style={{ textTransform: 'capitalize' }}>{op}</td>
                        <td class="sv-val">{capIcon(data.caps[op])} {data.caps[op]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Actions>
                  {cleared === 'caps' && <span class="sv-cleared-msg">✓ Reset</span>}
                  {confirmAction === 'caps' ? (
                    <>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => act('caps')}>Reset capabilities</button>
                    </>
                  ) : (
                    <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm('caps')}>Reset capabilities</button>
                  )}
                </Actions>

                <p class="sv-sub-heading" style={{ marginTop: '.75rem' }}>Active uploads tracker</p>
                <StoreLoc><KeyName name="s3b_active_uploads" /> (JSON) · localStorage · cross-tab collision detection</StoreLoc>
                <p class="sv-muted-text">
                  {Object.keys(data.active).length === 0
                    ? 'No active uploads registered.'
                    : `${Object.keys(data.active).length} upload slot(s) registered across tabs.`}
                </p>
                <Actions>
                  {cleared === 'active' && <span class="sv-cleared-msg">✓ Cleared</span>}
                  {confirmAction === 'active' ? (
                    <>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => act('active')}>Clear tracker</button>
                    </>
                  ) : (
                    <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm('active')}>Clear tracker</button>
                  )}
                </Actions>
              </div>
            </details>

            {/* ── Wipe All ──────────────────────────────────────── */}
            <div class="sv-wipe-block">
              <div class="sv-wipe-title">Remove all Bucketer data from this browser</div>
              <p class="sv-wipe-desc">
                Removes every key written to localStorage, sessionStorage, and IndexedDB:
              </p>
              <ul class="sv-wipe-list">
                <li>Connection details and credential fields</li>
                <li>All saved profiles</li>
                <li>Upload history and resume records</li>
                <li>All settings</li>
                <li>Capability state and the active-uploads tracker</li>
              </ul>
              <p class="sv-wipe-note">
                After clearing, the app reloads to a fresh state.{' '}
                <strong>Your files on your storage provider are untouched.</strong>
              </p>
              {wiping ? (
                <p class="sv-muted-text">Clearing…</p>
              ) : confirmAction === 'wipe' ? (
                <div class="sv-wipe-confirm">
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
                  <button type="button" class="btn btn-danger btn-sm" onClick={() => act('wipe')}>
                    Yes, clear everything
                  </button>
                </div>
              ) : (
                <button type="button" class="btn btn-danger btn-sm" onClick={() => setConfirm('wipe')}>
                  Clear all app data
                </button>
              )}
            </div>

          </div>
        )}

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
    </Modal>
  );
}
