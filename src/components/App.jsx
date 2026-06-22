// Copyright (C) 2026 HidayahTech, LLC
// Root session state machine (§4.14).
//
// Four mutually exclusive session states drive what the user sees:
//   disconnected: no credentials; only credential entry UI shown
//   connecting:   credentials saved, initial ListObjectsV2 probe in flight
//   connected:    probe succeeded; full Browser UI rendered
//   failed:       probe failed (auth, CORS, network); error + option to reconfigure
//
// Credential lifecycle: load from localStorage on mount, merge URL hash params
// (endpoint/bucket from a share link override stored values; secret key never comes
// from the URL). Save on connect; clear all on disconnect.
//
// Capability state (list/download/upload/delete: permitted|denied|unknown) is stored in
// localStorage and updated reactively when operations fail. Cleared on credential change.
//
// Browser component is re-mounted (key={browserKey} increment) on every reconnect to
// flush its in-memory listing cache and force a fresh listing probe.
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import logoUrl from '../assets/bucketer-logo.svg';
import { BucketerLogo } from './BucketerLogo.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { ToastHost } from './ToastHost.jsx';
import { showToast } from '../lib/toast.js';
import { createS3Client } from '../lib/s3-client.js';
import { detectProvider, PROVIDER_LABELS } from '../lib/provider.js';
import {
  loadCredentials, saveCredentials, clearCredentials,
  loadCapabilities, saveCapabilities, clearCapabilities, defaultCapabilities,
  loadUpdateCheckEnabled, saveUpdateCheckEnabled,
  loadPrefetchSizeLimit, savePrefetchSizeLimit,
  loadProfiles, saveProfile, deleteProfile, loadLastProfileId, saveLastProfileId,
  migrateProfilesFromLegacy, repairStorageInvariants,
} from '../lib/storage.js';
import { readUrlParams, hasUrlParams, buildShareUrl } from '../lib/url-params.js';
import { FileBanner } from './FileBanner.jsx';
import { CredentialForm } from './CredentialForm.jsx';
import { Browser } from './Browser.jsx';
import { UploadQueue } from './UploadQueue.jsx';
import { DeleteQueue } from './DeleteQueue.jsx';
import { runDeleteOperation } from '../lib/delete-queue.js';
import { MoveQueue } from './MoveQueue.jsx';
import { runMoveOperation } from '../lib/move-queue.js';
import { CapabilityPanel } from './CapabilityPanel.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { UploadLog } from './UploadLog.jsx';
import { ErrorBlock } from './ErrorBlock.jsx';
import { UpdateBanner } from './UpdateBanner.jsx';
import { ChangelogModal } from './ChangelogModal.jsx';
import { AboutModal } from './AboutModal.jsx';
import { ProfilePicker } from './ProfilePicker.jsx';
import { StorageModal } from './StorageModal.jsx';
import { DuplicatesModal } from './DuplicatesModal.jsx';
import { CURRENT_VERSION } from '../lib/changelog.js';
import { useWindowDragDrop } from '../hooks/useWindowDragDrop.js';
import { useModalStates } from '../hooks/useModalStates.js';

const _iconLink = document.querySelector('link[rel="icon"]');
if (_iconLink) _iconLink.href = logoUrl;

// Session states: disconnected | connecting | connected | failed
export function App() {
  const [session, setSession] = useState('disconnected');
  // selectedProfileId must be declared before credentials so the credentials
  // initializer can pre-fill the form from the saved profile on first load.
  const [selectedProfileId, setSelectedProfileId] = useState(() => loadLastProfileId());
  const [credentials, setCredentials] = useState(() => {
    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const lastId = loadLastProfileId();
    if (lastId) {
      const profile = loadProfiles().profiles.find(p => p.id === lastId);
      if (profile) return { ...profile, secretKey: stored.secretKey || '', ...fromUrl };
    }
    return { ...stored, ...fromUrl };
  });
  const [client, setClient] = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  const [capabilities, setCapabilities] = useState(() => loadCapabilities());
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [browserKey, setBrowserKey] = useState(0); // force re-mount on reconnect
  const [logKey, setLogKey] = useState(0);         // incremented to refresh upload log
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { changelogOpen, setChangelogOpen, aboutOpen, setAboutOpen, storageOpen, setStorageOpen, duplicatesOpen, setDuplicatesOpen } = useModalStates();
  const [liveFormData, setLiveFormData] = useState(credentials);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(() => loadUpdateCheckEnabled());
  const [prefetchSizeLimit, setPrefetchSizeLimit] = useState(() => loadPrefetchSizeLimit());
  const [profiles, setProfiles] = useState(() => loadProfiles().profiles);
  const [deleteOps, setDeleteOps] = useState([]);
  const [moveOps, setMoveOps] = useState([]);
  const addFilesRef = useRef(null);
  const browserActionsRef = useRef(null);
  const logKeyDebounceRef = useRef(null);
  const urlParamsPresent = hasUrlParams();

  // Capability state is updated reactively as operations fail (§4.12).
  // The idempotency check (prev[op] === state) prevents unnecessary re-renders and
  // storage writes when the same operation fails multiple times in rapid succession.
  const handleCapabilityChange = useCallback((op, state) => {
    setCapabilities(prev => {
      if (prev[op] === state) return prev;
      const next = { ...prev, [op]: state };
      saveCapabilities(next);
      return next;
    });
  }, []);

  // Resets all capabilities to 'unknown' and re-mounts Browser to trigger a fresh probe.
  // Called from CapabilityPanel when the user wants to re-check permissions after
  // changing bucket policy or key permissions without disconnecting and reconnecting.
  function handleRefreshPermissions() {
    const fresh = defaultCapabilities();
    setCapabilities(fresh);
    saveCapabilities(fresh);
    setBrowserKey(k => k + 1); // re-mount browser → triggers new listing probe
  }

  async function handleConnect(creds, { reconnect = false } = {}) {
    // reconnect:true keeps session='connected' to avoid a flash to the splash view when
    // the user updates credentials from the sidebar while already browsing (§4.14).
    if (!reconnect) setSession('connecting');
    setConnectionError(null);

    const provider = creds.provider || detectProvider(creds.endpoint);
    const fullCreds = { ...creds, provider };

    saveCredentials(fullCreds);
    clearCapabilities();
    setCapabilities(defaultCapabilities());
    setCredentials(fullCreds);

    try {
      const c = createS3Client(fullCreds);
      setClient(c);
      setSession('connected');
      setBrowserKey(k => k + 1);
    } catch (err) {
      setSession('failed');
      setConnectionError(err);
    }
  }

  // Clears all session state atomically. Credentials and capabilities are removed from
  // localStorage so the next page load starts at the disconnected splash screen.
  // browserKey increment remounts Browser to discard any cached listing state.
  function handleDisconnect() {
    setSession('disconnected');
    setClient(null);
    setConnectionError(null);
    clearCredentials();
    clearCapabilities();
    setCapabilities(defaultCapabilities());
    // Repopulate form from the selected profile (minus secret key) so the user only
    // has to re-enter their secret key to reconnect. Without this, the form is blank
    // while the profile row still appears highlighted, and clicking it is a no-op
    // (same selectedProfileId → same key → CredentialForm doesn't remount).
    const profile = selectedProfileId ? profiles.find(p => p.id === selectedProfileId) : null;
    const nextCreds = profile
      ? { ...profile, secretKey: '' }
      : { endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' };
    setCredentials(nextCreds);
    setLiveFormData(nextCreds);
    setBrowserKey(k => k + 1);
  }

  // Auto-connect if credentials are stored. Merge URL params so endpoint/bucket
  // from the URL override stored values (secret key never comes from URL).
  // Migration runs first so the profile list is populated before state reads it.
  useEffect(() => {
    repairStorageInvariants();
    migrateProfilesFromLegacy();
    const updatedProfiles = loadProfiles().profiles;
    setProfiles(updatedProfiles);
    const lastId = loadLastProfileId();
    if (lastId) setSelectedProfileId(lastId);

    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const profile = lastId ? updatedProfiles.find(p => p.id === lastId) : null;
    // Prefer flat credentials (written by saveCredentials on every connect) over profile
    // data. This ensures that connecting with modified credentials — without saving a new
    // profile — is correctly restored on reload. Flat credentials are absent only after a
    // disconnect (clearCredentials wipes them) or on first load, in which case we fall
    // back to the saved profile so the form is pre-filled.
    const base = stored.endpoint
      ? stored
      : (profile ? { ...profile, secretKey: stored.secretKey || '' } : stored);
    const merged = { ...base, ...fromUrl };
    if (merged.endpoint && merged.bucket && merged.keyId && merged.secretKey) {
      handleConnect(merged);
    }
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e) => { if (e.key === 'Escape') setSidebarOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sidebarOpen]);

  const { windowDragOver, handleWindowDrop } = useWindowDragDrop({
    enabled: session === 'connected' && capabilities.upload !== 'denied',
    addFilesRef,
  });

  function handleDeleteRequest({ files, prefixes, capturedPrefix }) {
    setDeleteOps(prev => [...prev, {
      id: String(Date.now() + Math.random()),
      phase: 'confirm',
      files,
      prefixes,
      capturedPrefix,
      bucket: credentials.bucket,
      total: null,
      deleted: 0,
      errors: [],
      collapsed: false,
    }]);
  }

  function updateDeleteOp(id, update) {
    setDeleteOps(prev => prev.map(op => op.id === id ? { ...op, ...update } : op));
  }

  async function handleDeleteConfirm(id) {
    const op = deleteOps.find(o => o.id === id);
    if (!op) return;
    try {
      await runDeleteOperation(client, op.bucket, op, (update) => {
        if (update.deletedKeys?.length) {
          browserActionsRef.current?.removeItems(update.deletedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.deletedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.deletedPrefixes);
          }
          browserActionsRef.current?.invalidateCache(op.capturedPrefix);
          handleCapabilityChange('delete', 'permitted');
          if (update.errors.length === 0) {
            const n = (op.files?.length || 0) + (op.prefixes?.length || 0);
            showToast(`Deleted ${n} item${n === 1 ? '' : 's'}`);
            setTimeout(() => setDeleteOps(prev => prev.filter(o => o.id !== id)), 3000);
          }
        }
        updateDeleteOp(id, update);
      });
    } catch (err) {
      updateDeleteOp(id, {
        phase: 'done',
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
        deletedPrefixes: [],
      });
    }
  }

  function handleDeleteDismiss(id) {
    setDeleteOps(prev => prev.filter(o => o.id !== id));
  }

  function handleDeleteCollapse(id) {
    setDeleteOps(prev => prev.map(op =>
      op.id === id ? { ...op, collapsed: !op.collapsed } : op
    ));
  }

  // Move ops are owned by App (like delete ops) so they survive folder navigation. The
  // MovePickerModal is the confirmation step, so a request starts the operation directly.
  function updateMoveOp(id, update) {
    setMoveOps(prev => prev.map(op => op.id === id ? { ...op, ...update } : op));
  }

  async function handleMoveRequest({ files, prefixes, dest, capturedPrefix }) {
    const id = String(Date.now() + Math.random());
    const op = {
      id, phase: 'checking', files, prefixes, dest, capturedPrefix,
      bucket: credentials.bucket, moved: 0, total: null, errors: [], collapsed: false,
    };
    setMoveOps(prev => [...prev, op]);
    try {
      await runMoveOperation(client, op.bucket, op, (update) => {
        // Remove moved source rows incrementally (copy+delete confirmed for those keys).
        if (update.movedKeys?.length) {
          browserActionsRef.current?.removeItems(update.movedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.movedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.movedPrefixes);
          }
          // Invalidate both the source view and the destination so each refetches.
          browserActionsRef.current?.invalidateCache(op.capturedPrefix);
          browserActionsRef.current?.invalidateCache(op.dest);
          if (update.moved > 0) {
            handleCapabilityChange('upload', 'permitted');
            handleCapabilityChange('delete', 'permitted');
          }
          if (update.errors.length === 0) {
            showToast(`Moved ${update.moved} item${update.moved === 1 ? '' : 's'}`);
            setTimeout(() => setMoveOps(prev => prev.filter(o => o.id !== id)), 3000);
          }
        }
        updateMoveOp(id, update);
      });
    } catch (err) {
      updateMoveOp(id, {
        phase: 'done',
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
        movedPrefixes: [],
      });
    }
  }

  function handleMoveDismiss(id) {
    setMoveOps(prev => prev.filter(o => o.id !== id));
  }

  function handleMoveCollapse(id) {
    setMoveOps(prev => prev.map(op =>
      op.id === id ? { ...op, collapsed: !op.collapsed } : op
    ));
  }

  async function handleCopyLink() {
    const url = buildShareUrl(credentials);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Share link copied to clipboard');
    } catch { /* clipboard API unavailable */ }
  }

  function handleSelectProfile(id) {
    const profile = profiles.find(p => p.id === id);
    if (!profile) return;
    setSelectedProfileId(id);
    saveLastProfileId(id);
    const creds = { ...profile, secretKey: '' };
    setCredentials(creds);
    setLiveFormData(creds);
  }

  function handleSaveProfile(name) {
    const ep = (liveFormData.endpoint || '').trim().replace(/\/$/, '');
    // Resolve provider: if the form has been edited (onFormChange fired, giving us
    // providerOverride), use that; otherwise fall back to liveFormData.provider
    // (set from the profile/credentials on load, before any edits). This prevents
    // a stale providerOverride from a previous session from leaking into the saved
    // profile, while preserving genuine explicit overrides (e.g. MinIO on a generic URL).
    const providerSource = 'providerOverride' in liveFormData
      ? liveFormData.providerOverride
      : liveFormData.provider;
    const provider = providerSource || detectProvider(ep);

    // If a profile is currently selected, update it in place (same id) rather than
    // always creating a new one, so repeated saves don't accumulate duplicates.
    const existingProfile = selectedProfileId ? profiles.find(p => p.id === selectedProfileId) : null;
    const profile = {
      id: existingProfile ? existingProfile.id : Date.now(),
      name,
      endpoint: ep,
      bucket: (liveFormData.bucket || '').trim(),
      keyId: (liveFormData.keyId || '').trim(),
      provider,
      regionOverride: (liveFormData.regionOverride || '').trim(),
    };
    saveProfile(profile);
    const updated = loadProfiles().profiles;
    setProfiles(updated);
    setSelectedProfileId(profile.id);
    saveLastProfileId(profile.id);
    // Sync credentials so the form doesn't reset when it remounts on key change.
    const creds = { ...profile, secretKey: liveFormData.secretKey || '' };
    setCredentials(creds);
    setLiveFormData(creds);
  }

  function handleDeleteProfile(id) {
    deleteProfile(id);
    setProfiles(loadProfiles().profiles);
    if (selectedProfileId === id) {
      setSelectedProfileId(null);
      saveLastProfileId(null);
    }
  }

  const providerLabel = credentials.provider ? PROVIDER_LABELS[credentials.provider] : null;

  return (
    <div id="app">
      <ToastHost />
      {changelogOpen && <ChangelogModal onClose={() => setChangelogOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {storageOpen && <StorageModal onClose={() => setStorageOpen(false)} isConnected={session === 'connected'} />}
      {duplicatesOpen && session === 'connected' && (
        <DuplicatesModal
          client={client}
          bucket={credentials.bucket}
          endpoint={credentials.endpoint}
          currentPrefix={currentPrefix}
          provider={credentials.provider}
          capabilities={capabilities}
          onDeleteRequest={handleDeleteRequest}
          onClose={() => setDuplicatesOpen(false)}
        />
      )}
      <header class="app-header">
        {session === 'connected' && (
          <button
            class="hamburger"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
          >
            {sidebarOpen ? '✕' : '☰'}
          </button>
        )}
        <BucketerLogo />
        <span class="spacer" />
        {providerLabel && session === 'connected' && (
          <span class="header-status">{providerLabel}</span>
        )}
        <StatusBadge session={session} />
        {session === 'connected' && buildShareUrl(credentials) && (
          <>
            <button
              class="btn btn-ghost btn-sm"
              style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
              onClick={handleCopyLink}
              title="Copy a shareable link with endpoint and bucket pre-filled (no credentials)"
            >
              Copy link
            </button>
          </>
        )}
        {session === 'connected' && capabilities.list !== 'denied' && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
            onClick={() => setDuplicatesOpen(true)}
            title="Scan this bucket or folder for duplicate files"
          >
            Find duplicates
          </button>
        )}
        {session === 'connected' && (
          <button type="button" class="btn btn-ghost btn-sm" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }} onClick={handleDisconnect}>
            Disconnect
          </button>
        )}
        <ThemeToggle />
        <button class="btn-version" onClick={() => setChangelogOpen(true)} title="View changelog">
          v{CURRENT_VERSION}
        </button>
      </header>

      <UpdateBanner enabled={updateCheckEnabled} />
      <FileBanner />

      {session === 'disconnected' || session === 'connecting' || session === 'failed' ? (
        <div class="main-content">
          <div class="splash">
            <h2>Connect to a bucket</h2>
            <ProfilePicker
              profiles={profiles}
              selectedId={selectedProfileId}
              onSelect={handleSelectProfile}
              onDelete={handleDeleteProfile}
              onSave={handleSaveProfile}
              currentFormData={liveFormData}
            />
            {urlParamsPresent && (
              <div class="banner banner-info" style={{ marginBottom: '1rem' }}>
                <div class="banner-body">
                  Endpoint and bucket pre-filled from URL — enter your Key ID and Secret Key to connect.
                </div>
              </div>
            )}
            <CredentialForm
              key={selectedProfileId ?? 'manual'}
              initial={credentials}
              onSave={handleConnect}
              onFormChange={setLiveFormData}
              loading={session === 'connecting'}
            />
            {session === 'failed' && connectionError && (
              <div style={{ marginTop: '1rem' }}>
                <ErrorBlock
                  error={connectionError}
                  title="Connection failed"
                  guidance="Check your endpoint URL, bucket name, and credentials. If this looks like a CORS error, ensure CORS is configured on your bucket."
                />
              </div>
            )}

            <hr class="splash-divider" />

            <div class="splash-info">
              <div class="splash-info-section">
                <div class="splash-info-heading">About Bucketer</div>
                <p>Every S3 GUI tool asks you to make a trade. Desktop clients require installation and don't travel with you. SaaS browser tools skip the install but route your credentials through servers you don't control. Self-hosted web UIs solve the credential trust problem by asking you to run and maintain a backend. Something always gives.</p>
                <p><strong>Bucketer doesn't make you choose.</strong></p>
                <p>It runs entirely in the browser — no installation, no backend, no server to maintain. The whole application ships as a single self-contained HTML file. Your secret key never leaves your browser except as a SigV4 signature on requests sent over TLS directly to your storage endpoint. Close the tab; the credentials are gone.</p>
                <p>It handles multipart uploads of any size with cross-session resume, works first-class against B2, R2, Wasabi, AWS S3, MinIO, and any S3-compatible API, and shares state as deep-linkable URLs that never expose your bucket name in server logs.</p>
                <p><button class="splash-about-link" onClick={() => setAboutOpen(true)}>Learn more →</button></p>
              </div>

              <div class="splash-info-section">
                <div class="splash-info-heading">What is an S3-compatible bucket?</div>
                <p>
                  S3 is a widely-adopted standard for cloud storage, originally created by Amazon
                  Web Services. Many providers use the same interface: Backblaze B2, Cloudflare R2,
                  Wasabi, MinIO, and others.
                </p>
                <p>To connect you need three things from your storage provider:</p>
                <ul class="splash-info-list">
                  <li><strong>Endpoint</strong> — the provider's storage URL (e.g. <code>https://s3.us-east-1.amazonaws.com</code>)</li>
                  <li><strong>Bucket name</strong> — the name of your storage container</li>
                  <li><strong>Key ID and Secret Key</strong> — access credentials, similar to a username and password</li>
                </ul>
                <p>
                  There is no account to create here. Access is controlled entirely by the
                  credentials your storage provider gives you.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div class="app-body">
          {sidebarOpen && <div class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
          <aside class={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
            {selectedProfileId && profiles.find(p => p.id === selectedProfileId) && (
              <div class="profile-active-name">
                {profiles.find(p => p.id === selectedProfileId).name}
              </div>
            )}
            <CredentialForm
              initial={credentials}
              onSave={(creds) => handleConnect(creds, { reconnect: true })}
              loading={false}
            />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <CapabilityPanel capabilities={capabilities} onRefresh={handleRefreshPermissions} />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <SettingsPanel
              provider={credentials.provider}
              updateCheckEnabled={updateCheckEnabled}
              onUpdateCheckChange={(val) => { saveUpdateCheckEnabled(val); setUpdateCheckEnabled(val); }}
              prefetchSizeLimit={prefetchSizeLimit}
              onPrefetchSizeLimitChange={(val) => { savePrefetchSizeLimit(val); setPrefetchSizeLimit(val); }}
            />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <details class="s3-primer">
              <summary class="s3-primer-summary">About S3 buckets</summary>
              <div class="s3-primer-body">
                <p>
                  S3 buckets don't have real folders. What looks like a folder is just a
                  shared prefix in the file name — a file stored as{' '}
                  <code>photos/2024/trip.jpg</code> appears inside{' '}
                  <code>photos / 2024</code>, but its full name is the entire path.
                </p>
                <p>A few things that follow from this:</p>
                <ul>
                  <li>Empty folders don't exist — they disappear when the last file inside them is deleted.</li>
                  <li>Files can only be in one place — there are no shortcuts or aliases.</li>
                  <li>
                    Deleting a file is permanent unless your bucket has versioning enabled,
                    in which case older versions can be recovered.
                  </li>
                </ul>
                <p>
                  Access is controlled by your Key ID and Secret Key, not by user accounts.
                  Anyone with those credentials has whatever permissions were granted to that key.
                </p>
              </div>
            </details>
          </aside>

          <main class="main-content" data-testid="app-connected">
            {/* Upload zone above the browser */}
            <UploadQueue
              client={client}
              bucket={credentials.bucket}
              provider={credentials.provider}
              currentPrefix={currentPrefix}
              credentials={credentials}
              onCapabilityChange={handleCapabilityChange}
              capabilities={capabilities}
              onUploadsComplete={(prefixSet) => browserActionsRef.current?.onUploadsDrained?.(prefixSet)}
              onLogEntry={() => {
                if (logKeyDebounceRef.current) return;
                logKeyDebounceRef.current = setTimeout(() => {
                  setLogKey(k => k + 1);
                  logKeyDebounceRef.current = null;
                }, 500);
              }}
              onMount={({ addFiles }) => { addFilesRef.current = addFiles; }}
            />

            <DeleteQueue
              ops={deleteOps}
              onConfirm={handleDeleteConfirm}
              onDismiss={handleDeleteDismiss}
              onCollapse={handleDeleteCollapse}
              provider={credentials.provider}
            />

            <MoveQueue
              ops={moveOps}
              onDismiss={handleMoveDismiss}
              onCollapse={handleMoveCollapse}
            />

            <UploadLog refreshKey={logKey} />

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1rem 0' }} />

            <Browser
              key={browserKey}
              isFirstMount={browserKey === 0}
              client={client}
              bucket={credentials.bucket}
              provider={credentials.provider}
              credentials={credentials}
              onCapabilityChange={handleCapabilityChange}
              capabilities={capabilities}
              onInitialListFailed={(err) => { setSession('failed'); setConnectionError(err); }}
              onUploadTargetChange={setCurrentPrefix}
              onExternalDrop={(entries) => addFilesRef.current?.(entries)}
              onDeleteRequest={handleDeleteRequest}
              onMoveRequest={handleMoveRequest}
              onMount={(actions) => { browserActionsRef.current = actions; }}
              prefetchSizeLimit={prefetchSizeLimit}
            />
          </main>
        </div>
      )}
      {windowDragOver && session === 'connected' && capabilities.upload !== 'denied' && (
        <div
          class="window-drop-overlay"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleWindowDrop}
        >
          <div class="window-drop-inner">Drop files anywhere to upload</div>
        </div>
      )}
      <footer class="app-footer">
        <a href="https://gitlab.com/hidayahtech/bucketer" target="_blank" rel="noopener noreferrer">Bucketer</a>
        {' '}&mdash;{' '}
        <button class="footer-link-btn" onClick={() => setAboutOpen(true)}>About</button>
        {' '}&mdash;{' '}
        <button class="footer-link-btn" onClick={() => setStorageOpen(true)}>Storage &amp; Privacy</button>
        {' '}&mdash;{' '}
        Copyright &copy; 2026 <a href="https://hidayahtech.com" target="_blank" rel="noopener noreferrer">HidayahTech, LLC</a>
      </footer>
    </div>
  );
}

function StatusBadge({ session }) {
  const cls = {
    disconnected: 'status-disconnected',
    connecting:   'status-connecting',
    connected:    'status-connected',
    failed:       'status-failed',
  }[session] || 'status-disconnected';

  const label = {
    disconnected: 'Disconnected',
    connecting:   'Connecting',
    connected:    'Connected',
    failed:       'Failed',
  }[session];

  return (
    <span class={`status-badge ${cls}`}>
      <span class="dot" />
      {label}
    </span>
  );
}
