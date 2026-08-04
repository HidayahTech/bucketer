// Copyright (C) 2026 HidayahTech, LLC
// Root session state machine (§4.14).
//
// Five mutually exclusive session states drive what the user sees:
//   locked:       a vault exists but has not been unlocked this session; only the
//                 vault passphrase screen (VaultUnlock) is shown
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
import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logoUrl from '../assets/bucketer-logo.svg';
import { BucketerLogo } from './BucketerLogo.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { ToastHost } from './ToastHost.jsx';
import { showToast } from '../lib/toast.js';
import { createS3Client } from '../lib/s3-client.js';
import { diagnosticsProps } from '../lib/connection-diagnostics.js';
import { detectProvider, PROVIDER_LABELS } from '../lib/provider.js';
import {
  loadCredentials, saveCredentials, clearCredentials,
  loadUpdateCheckEnabled, saveUpdateCheckEnabled,
  loadPrefetchSizeLimit, savePrefetchSizeLimit,
  loadLastProfileId, saveLastProfileId, repairStorageInvariants,
  migrateProfilesFromLegacy,
} from '../lib/storage.js';
import {
  listResolvedConnections, resolveConnection, findOrCreateCredential,
  saveConnectionRecord, deleteConnectionRecord, migrateProfilesToConnections,
  defaultCapabilities, loadConnectionCapabilities, saveConnectionCapabilities,
  defaultConnectionName, hasMigratedConnections,
} from '../lib/connections.js';
import { readUrlParams, hasUrlParams, buildShareUrl } from '../lib/url-params.js';
import {
  vaultExists, isUnlocked, recallSecret, rememberSecret, createVault, VAULT_ENABLED,
} from '../lib/vault.js';
import { FileBanner } from './FileBanner.jsx';
import { CredentialForm } from './CredentialForm.jsx';
import { VaultUnlock, VAULT_USERNAME } from './VaultUnlock.jsx';
import { ShareLinkMenu } from './ShareLinkMenu.jsx';
import { Browser } from './Browser.jsx';
import { UploadQueue } from './UploadQueue.jsx';
import { DeleteConfirmModal } from './DeleteConfirmModal.jsx';
import { MasterQueue } from './MasterQueue.jsx';
import { runDeleteOperation } from '../lib/delete-queue.js';
import { runMoveOperation, runCopyOperation, runRenameOperation } from '../lib/move-queue.js';
import { taskStore } from '../lib/task-store.js';
import { createDeleteTask, createTransferTask, createDownloadTask, engineUpdateToPatch } from '../lib/queue-tasks.js';
import { DownloadJobPanel } from './DownloadJobPanel.jsx';
import {
  saveJob, loadJob, loadAllJobs, deleteJob, updateJob, countItemsByStatus,
  eachItemByStatus, resetFailedToPending, ITEM_STATUS, JOB_STATUS, loadZipDetail,
} from '../lib/download-records.js';
import { enumerateJob } from '../lib/download-manifest.js';
import { runDownloadJob, jobOutcome } from '../lib/download-queue.js';
import { classifyJob } from '../lib/download-lifecycle.js';
import { verifyJob } from '../lib/download-verify.js';
import { issueBrowserDownload } from '../lib/download-issue.js';
import { probeUrl, blockedMessage } from '../lib/download-preflight.js';
import { runZipJob, discardZipStaging, zipFileName, openZipStaging, zipGate } from '../lib/zip-job.js';
import { exportZip } from '../lib/zip-export.js';
import { detectCapabilities, readStorageQuota } from '../lib/browser-capability.js';
import { presignDownloadParams } from '../lib/presign-params.js';
import { normalizeRoots, selectionLabel } from '../lib/download-roots.js';
import { DOWNLOAD_PRESIGN_EXPIRES, DOWNLOAD_ISSUE_DELAY_MS } from '../lib/constants.js';
import { CapabilityPanel } from './CapabilityPanel.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { UploadLog } from './UploadLog.jsx';
import { ErrorBlock } from './ErrorBlock.jsx';
import { UpdateBanner } from './UpdateBanner.jsx';
import { ChangelogModal } from './ChangelogModal.jsx';
import { AboutModal } from './AboutModal.jsx';
import { ProfilePicker } from './ProfilePicker.jsx';
import { StorageModal } from './StorageModal.jsx';
import { TransferHandoff } from './TransferHandoff.jsx';
import { DuplicatesModal } from './DuplicatesModal.jsx';
import { CURRENT_VERSION } from '../lib/changelog.js';
import { useWindowDragDrop } from '../hooks/useWindowDragDrop.js';
import { useModalStates } from '../hooks/useModalStates.js';

const _iconLink = document.querySelector('link[rel="icon"]');
if (_iconLink) _iconLink.href = logoUrl;

// Persists that the user dismissed the post-connect vault offer, so it is never
// shown twice — the offer itself also stops appearing once a vault exists, but a
// user who dismisses without ever creating one needs this separate, durable flag.
// localStorage (not sessionStorage): "never shown twice" must survive a tab close.
const VAULT_OFFER_DISMISSED_KEY = 's3b_vault_offer_dismissed';
function isVaultOfferDismissed() {
  try { return localStorage.getItem(VAULT_OFFER_DISMISSED_KEY) === '1'; } catch { return false; }
}
function dismissVaultOfferPermanently() {
  try { localStorage.setItem(VAULT_OFFER_DISMISSED_KEY, '1'); } catch { /* private mode — offer may reappear next session, acceptable degradation */ }
}

// navigator.storage.persisted() can itself throw on a browser where storage.estimate
// exists but the permission surface does not; treated as "not persisted" rather than
// propagating, since zipGate() only needs a boolean.
async function zipStoragePersisted() {
  try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
}

// Session states: locked | disconnected | connecting | connected | failed
export function App() {
  // Computed once at mount from vault.js's own storage reads — unlike recalling a
  // secret, vaultExists()/isUnlocked() do not depend on connection migration having
  // run yet, so (unlike recallSecret) this is safe inside a useState initializer.
  const [session, setSession] = useState(() => (VAULT_ENABLED && vaultExists() && !isUnlocked()) ? 'locked' : 'disconnected');
  // selectedConnectionId must be declared before credentials so the credentials
  // initializer can pre-fill the form from the saved connection on first load.
  const [selectedConnectionId, setSelectedConnectionId] = useState(() => loadLastProfileId());
  const [credentials, setCredentials] = useState(() => {
    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const lastId = loadLastProfileId();
    if (lastId) {
      const conn = resolveConnection(lastId);
      if (conn) return { ...conn, secretKey: stored.secretKey || '', ...fromUrl };
    }
    return { ...stored, ...fromUrl };
  });
  const [client, setClient] = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  const [capabilities, setCapabilities] = useState(() => {
    const lastId = loadLastProfileId();
    return lastId ? loadConnectionCapabilities(lastId) : defaultCapabilities();
  });
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [browserKey, setBrowserKey] = useState(0); // force re-mount on reconnect
  // Bumped once when the mount effect hydrates `credentials` from a just-migrated
  // connection (see the `else if (conn)` branch below). CredentialForm reads
  // `initial` only in its own useState initializer, so without a key change,
  // setCredentials() alone is invisible to an already-mounted form.
  const [formResetKey, setFormResetKey] = useState(0);
  const [logKey, setLogKey] = useState(0);         // incremented to refresh upload log
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { changelogOpen, setChangelogOpen, aboutOpen, setAboutOpen, storageOpen, setStorageOpen, duplicatesOpen, setDuplicatesOpen, handoffOpen, setHandoffOpen, downloadOpen, setDownloadOpen } = useModalStates();
  // The scope the DownloadJobPanel was opened with (folder or a batch-bar selection),
  // and the prefix a "Use a transfer tool" handoff should target — see handleDownloadRequest.
  const [downloadScope, setDownloadScope] = useState(null);
  const [handoffPrefix, setHandoffPrefix] = useState(null);
  const [liveFormData, setLiveFormData] = useState(credentials);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(() => loadUpdateCheckEnabled());
  const [prefetchSizeLimit, setPrefetchSizeLimit] = useState(() => loadPrefetchSizeLimit());
  // True when the incoming share link pre-filled the access key ID — used to focus the
  // Secret Key field and adapt the pre-fill banner. Seeded from the URL hash at mount
  // and re-derived by the hashchange effect below, so the banner cannot keep claiming
  // the link omitted a key ID after a newer link supplied one (BUG-047).
  const [urlHadKeyId, setUrlHadKeyId] = useState(() => !!readUrlParams().keyId);
  const [connections, setConnections] = useState(() => listResolvedConnections());
  // Delete requests confirm BEFORE entering the master queue (a queued task is
  // always already authorized). One pending request at a time; a new request
  // replaces an unconfirmed one.
  const [pendingDelete, setPendingDelete] = useState(null);
  // The post-connect vault offer ("Save this key so you don't have to retype it next
  // time?"). Shown after a successful connect when no vault exists yet and the user
  // has not already dismissed it (see isVaultOfferDismissed above); reset on
  // disconnect since the "you just connected" context it refers to is gone.
  const [showVaultOffer, setShowVaultOffer] = useState(false);
  const [vaultOfferBusy, setVaultOfferBusy] = useState(false);
  const [vaultOfferError, setVaultOfferError] = useState(null);
  const addFilesRef = useRef(null);
  const browserActionsRef = useRef(null);
  const logKeyDebounceRef = useRef(null);
  const urlParamsPresent = hasUrlParams();

  // Capability state is updated reactively as operations fail (§4.12).
  // The idempotency check (prev[op] === state) prevents unnecessary re-renders and
  // storage writes when the same operation fails multiple times in rapid succession.
  //
  // Persisted against the selected connection. With no connection selected the
  // credentials are ad-hoc, and their capabilities are session-only — persisting
  // them to a global key is what let bucket A's state apply to bucket B.
  const handleCapabilityChange = useCallback((op, state) => {
    setCapabilities(prev => {
      if (prev[op] === state) return prev;
      const next = { ...prev, [op]: state };
      if (selectedConnectionId) saveConnectionCapabilities(selectedConnectionId, next);
      return next;
    });
  }, [selectedConnectionId]);

  // Resets all capabilities to 'unknown' and re-mounts Browser to trigger a fresh probe.
  function handleRefreshPermissions() {
    const fresh = defaultCapabilities();
    setCapabilities(fresh);
    if (selectedConnectionId) saveConnectionCapabilities(selectedConnectionId, fresh);
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
    // Always reset to 'unknown' on connect, regardless of whether a connection is
    // selected — matches pre-branch behaviour exactly. A stale 'denied' hides UI
    // (upload section, drop overlay, Find duplicates, download/delete/move/copy),
    // so it must self-heal on the next connect rather than persist forever just
    // because the user fixed their bucket policy at the provider. Do NOT change
    // this to restore the stored per-connection value — that was tried on this
    // branch and reverted (whole-branch review, Finding 2).
    const resetCaps = defaultCapabilities();
    setCapabilities(resetCaps);
    // Reset the stored record too, so it stays consistent with in-memory state:
    // handleCapabilityChange merges new observations against in-memory `prev` and
    // saveConnectionCapabilities overwrites the whole stored field, so a stored
    // record that disagreed with the fresh in-memory reset would be silently
    // truncated by the very first post-connect capability write (Browser's initial
    // listing probe fires almost immediately). This mirrors the pre-branch
    // reset-on-connect behaviour for the stored record too, not just in-memory.
    // The record still accumulates normally after this point via
    // handleCapabilityChange/saveConnectionCapabilities, and
    // selecting a connection without reconnecting (handleSelectProfile, and
    // eventually Phase 3's connection switcher) still reads its full history via
    // loadConnectionCapabilities — only an actual connect resets it.
    if (selectedConnectionId) saveConnectionCapabilities(selectedConnectionId, resetCaps);
    setCredentials(fullCreds);

    try {
      const c = createS3Client(fullCreds);
      setClient(c);
      setSession('connected');
      setBrowserKey(k => k + 1);
      // The post-connect vault offer (§ decisions: never gate first-run behind a
      // passphrase — offer only after the app has demonstrated it works). Gated on
      // both conditions so it never re-appears once accepted (vaultExists() becomes
      // true) or dismissed (isVaultOfferDismissed() persists that).
      if (VAULT_ENABLED && !vaultExists() && !isVaultOfferDismissed()) setShowVaultOffer(true);
    } catch (err) {
      setSession('failed');
      setConnectionError(err);
    }
  }

  // Recalls the remembered secret for `connId`'s credential (when the vault is
  // unlocked and an entry exists) and connects with it — used both by the mount
  // effect (a same-tab reload after an earlier unlock: sessionStorage's vault key
  // survives a reload) and immediately after a fresh unlock (VaultUnlock's onUnlock
  // below), so unlocking and connecting happen in one motion per the design.
  // recallSecret can reject on a malformed vault session key from external
  // tampering only — caught so that degrades to the ordinary manual-entry screen
  // instead of surfacing an unhandled rejection. Returns whether it connected, so
  // callers can fall back (e.g. to pre-filling the form) when it did not.
  function tryAutoConnectViaVault(connId, extraFields = {}) {
    if (!VAULT_ENABLED || !connId) return Promise.resolve(false);
    const conn = resolveConnection(connId);
    if (!conn) return Promise.resolve(false);
    return recallSecret(conn.credentialId, window.crypto.subtle)
      .then(secret => {
        if (!secret) return false;
        handleConnect({ ...conn, ...extraFields, secretKey: secret });
        return true;
      })
      .catch(() => false);
  }

  // VaultUnlock has already unlocked and persisted the session key by the time this
  // fires (see VaultUnlock.jsx) — App just needs to leave the locked screen and, per
  // the design ("unlocking and connecting happen in one motion"), try to connect
  // straight into whatever connection is already selected.
  function handleVaultUnlock() {
    setSession('disconnected');
    tryAutoConnectViaVault(selectedConnectionId);
  }

  // VaultUnlock's onReset already called resetVault() (destroys the vault record and
  // locks) before invoking this — nothing left to unlock, so fall through to the
  // ordinary connect screen.
  function handleVaultReset() {
    setSession('disconnected');
  }

  async function handleAcceptVaultOffer(passphrase) {
    setVaultOfferBusy(true);
    setVaultOfferError(null);
    let result;
    try {
      result = await createVault(passphrase, window.crypto.subtle, window.crypto.getRandomValues.bind(window.crypto));
    } catch {
      result = { ok: false };
    }
    if (!result.ok) {
      setVaultOfferBusy(false);
      setVaultOfferError('Could not save the vault on this device.');
      return;
    }

    // A plain "Connect" submission never carries a credentialId — CredentialForm's
    // onSave only produces the six raw form fields — so find-or-create one from the
    // values that were just used to connect (the same fingerprint handleSaveProfile
    // itself uses). If this connect never went through an already-saved connection,
    // also persist one (auto-named): without a saved connection there is nothing for
    // a future launch to select and recall from, and the remembered secret would be
    // unreachable. liveFormData is deliberately NOT used here (unlike
    // handleSaveProfile) — it goes stale for the sidebar's reconnect CredentialForm,
    // which is not wired to onFormChange, so it can lag behind the connection that
    // actually just succeeded; `credentials` is what handleConnect itself just set.
    const existing = selectedConnectionId ? connections.find(c => c.id === selectedConnectionId) : null;
    const cred = findOrCreateCredential({
      endpoint:       credentials.endpoint,
      keyId:          credentials.keyId,
      provider:       credentials.provider,
      regionOverride: credentials.regionOverride,
    });
    if (!existing) {
      const id = Date.now();
      saveConnectionRecord({
        id,
        name:         defaultConnectionName({ provider: credentials.provider, bucket: credentials.bucket }),
        credentialId: cred.id,
        bucket:       credentials.bucket,
        capabilities: null,
      });
      setConnections(listResolvedConnections());
      setSelectedConnectionId(id);
      saveLastProfileId(id);
    }

    // rememberSecret can reject on a malformed vault session key (external
    // tampering only) — the vault was just created above, so unreachable in
    // practice, but guarded per house policy against any promise rejection here.
    try {
      await rememberSecret(cred.id, credentials.secretKey, window.crypto.subtle);
    } catch { /* see above */ }

    dismissVaultOfferPermanently();
    setShowVaultOffer(false);
    setVaultOfferBusy(false);
  }

  function handleDismissVaultOffer() {
    dismissVaultOfferPermanently();
    setShowVaultOffer(false);
    setVaultOfferError(null);
  }

  // Clears all session state atomically. Credentials and capabilities are removed from
  // localStorage so the next page load starts at the disconnected splash screen.
  // browserKey increment remounts Browser to discard any cached listing state.
  // Deliberately does NOT lock the vault (contract: disconnect is switching
  // connections, not leaving — only a tab close ends the vault session), and hides
  // the post-connect offer since the "you just connected" context it refers to is gone.
  function handleDisconnect() {
    setSession('disconnected');
    setShowVaultOffer(false);
    setVaultOfferError(null);
    setClient(null);
    setConnectionError(null);
    clearCredentials();
    setCapabilities(defaultCapabilities());
    // Repopulate form from the selected connection (minus secret key) so the user
    // only has to re-enter their secret key to reconnect.
    const conn = selectedConnectionId ? resolveConnection(selectedConnectionId) : null;
    const base = conn
      ? { ...conn, secretKey: '' }
      : { endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' };
    // Disconnecting does not change the URL, so if the address bar still carries a
    // share link's connection details, keep them rather than blanking the form —
    // otherwise the page contradicts its own URL, and re-entering that URL cannot
    // fix it: a fragment-only navigation never reloads the page (BUG-047).
    const fromUrl = readUrlParams();
    const nextCreds = { ...base, ...fromUrl };
    setCredentials(nextCreds);
    setLiveFormData(nextCreds);
    // CredentialForm reads `initial` only at mount, so a state update alone is
    // invisible; force a remount only when the URL actually supplied values, to
    // keep the ordinary disconnect path byte-for-byte as it was.
    if (Object.keys(fromUrl).length > 0) setFormResetKey(k => k + 1);
    setBrowserKey(k => k + 1);
  }

  // A share link opened while Bucketer is already loaded is a SAME-DOCUMENT
  // navigation: the browser fires hashchange and never reloads, so the mount-time
  // readUrlParams() never runs again and the link silently does nothing. Every
  // deep-link parameter lives in the fragment by design — it must never reach a
  // server — so this affects every share link, not an edge case (BUG-047).
  //
  // Scoped to the non-connected states on purpose: pushPrefixHistory() only runs
  // while Browser is mounted, so there is no self-inflicted hash churn to react to
  // here, and a pasted link must never silently swap the credentials of a live
  // session out from under an in-flight operation.
  //
  // Note the limit: re-entering an IDENTICAL URL fires no event at all, so nothing
  // can be done for that case from JavaScript. handleDisconnect above covers the
  // common shape of it.
  useEffect(() => {
    if (session === 'connected' || session === 'connecting') return;
    const onHashChange = () => {
      const fromUrl = readUrlParams();
      if (Object.keys(fromUrl).length === 0) return;
      setUrlHadKeyId(!!fromUrl.keyId);
      setCredentials(prev => ({ ...prev, ...fromUrl }));
      setLiveFormData(prev => ({ ...prev, ...fromUrl }));
      setFormResetKey(k => k + 1);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [session]);

  // Auto-connect if credentials are stored. Merge URL params so endpoint/bucket
  // from the URL override stored values (secret key never comes from URL).
  // Migration runs first so the profile list is populated before state reads it.
  useEffect(() => {
    repairStorageInvariants();
    // Restores the pre-branch migration chain: a user who last opened Bucketer
    // before profiles shipped (~v1.15.0) still has only bare flat credential keys,
    // not an s3b_profiles record. migrateProfilesToConnections() reads s3b_profiles
    // only, so without this call such a user gets no connection created at all.
    //
    // Only reach for the legacy flat-key chain when the connection migration has
    // never run. migrateProfilesFromLegacy() decides for itself by inspecting
    // s3b_profiles, which connections-model users never write — so calling it
    // unconditionally makes it synthesise a phantom profile from the flat keys
    // that saveCredentials() rewrites on every connect, and clobber
    // s3b_last_profile_id with an id that matches no connection.
    if (!hasMigratedConnections()) migrateProfilesFromLegacy();
    migrateProfilesToConnections();
    const updated = listResolvedConnections();
    setConnections(updated);
    const lastId = loadLastProfileId();
    if (lastId) setSelectedConnectionId(lastId);

    const stored = loadCredentials();
    const fromUrl = readUrlParams();
    const conn = lastId ? updated.find(c => c.id === lastId) : null;
    // Prefer flat credentials (written by saveCredentials on every connect) over
    // connection data, so connecting with modified credentials — without saving —
    // is restored correctly on reload.
    const base = stored.endpoint
      ? stored
      : (conn ? { ...conn, secretKey: stored.secretKey || '' } : stored);
    const merged = { ...base, ...fromUrl };
    // First load after migration: the `credentials` initializer above ran BEFORE
    // migrateProfilesToConnections(), so resolveConnection() found nothing and the
    // form fell back to the (empty) flat credential keys. Now that connections
    // exist, populate the form from the selected one — otherwise every upgrading
    // user gets a blank form on first load with their profile row highlighted.
    // Gated on `!stored.endpoint`: when flat credentials DO exist, `base` above
    // already picked them (by design — they are the last-connected values), and
    // this branch must not override that choice with the connection's values,
    // or the picker can highlight connection A while the form shows B's data.
    function prefillFromMigratedConnection() {
      setCredentials(merged);
      setLiveFormData(merged);
      // selectedConnectionId is unchanged (it was already `lastId` before migration
      // ran), so CredentialForm's key does not change and it will not remount to
      // pick up the credentials update above — force it explicitly.
      setFormResetKey(k => k + 1);
    }
    if (merged.endpoint && merged.bucket && merged.keyId && merged.secretKey) {
      handleConnect(merged);
    } else if (isUnlocked() && conn) {
      // Vault-backed auto-connect (contract: "auto-connect through the vault" — this
      // is the whole point of the feature). The flat-credential check above requires
      // a secret in sessionStorage, which is empty in a fresh tab and cleared on
      // disconnect; a same-tab reload after an earlier unlock still has the vault's
      // session key, though, so recall from it instead. Falls back to the ordinary
      // pre-fill below when this credential has no remembered secret.
      tryAutoConnectViaVault(lastId, fromUrl).then(connected => {
        if (!connected && !stored.endpoint) prefillFromMigratedConnection();
      });
    } else if (conn && !stored.endpoint) {
      prefillFromMigratedConnection();
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
    setPendingDelete({ files, prefixes, capturedPrefix });
  }

  function handleDownloadRequest(payload) {
    if (payload.kind === 'selection') {
      const count = payload.files.length + payload.prefixes.length;
      setDownloadScope({
        kind: 'selection',
        roots: normalizeRoots(payload),
        label: selectionLabel(count, credentials.bucket, payload.capturedPrefix),
      });
    } else {
      setDownloadScope({ kind: 'folder', prefix: payload.prefix });
    }
    setDownloadOpen(true);
  }

  async function handleDeleteConfirm() {
    const req = pendingDelete;
    setPendingDelete(null);
    const task = createDeleteTask({ ...req, bucket: credentials.bucket });
    const id = taskStore.add(task);
    try {
      await runDeleteOperation(client, task.bucket, task, (update) => {
        if (update.deletedKeys?.length) {
          browserActionsRef.current?.removeItems(update.deletedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.deletedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.deletedPrefixes);
          }
          browserActionsRef.current?.invalidateCache(task.capturedPrefix);
          // A run cancelled before any request proves nothing about permissions.
          if (update.deleted > 0 || !update.cancelled) {
            handleCapabilityChange('delete', 'permitted');
          }
          if (update.errors.length === 0 && !update.cancelled) {
            const n = req.files.length + req.prefixes.length;
            showToast(`Deleted ${n} item${n === 1 ? '' : 's'}`);
          }
        }
        taskStore.update(id, engineUpdateToPatch(update, 'deleted'), !!update.phase);
      }, () => taskStore.isCancelRequested(id));
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    }
  }

  // What this browser can actually do, by feature detection. Constant for the session, and
  // never derived from the browser's name — see src/lib/browser-capability.js.
  const browserCapabilities = useMemo(() => detectCapabilities(), []);

  // A run in flight is the task queue's business; its job must not also appear in the
  // panel's lists (it would offer Resume on a job already running). Ref, not state: the
  // download API is a stable memo and reads it at call time.
  const activeDownloadJobs = useRef(new Set());

  // Record/enumeration wiring handed to DownloadJobPanel, which stays free of IndexedDB
  // and the SDK. Rebuilt only when the connection changes.
  const downloadApi = useMemo(() => ({
    // Every persisted job of this bucket, classified. ONE list, one classifier — the two
    // independent filters this replaces could show a job twice or, worse, not at all
    // (postmortem F3/F6): a job invisible to every list has no Discard, so its manifest
    // was permanent. classifyJob is total, so every job lands in exactly one section.
    listJobs: async () => {
      const jobs = await loadAllJobs();
      const mine = jobs.filter(j => j.bucket === credentials.bucket && !activeDownloadJobs.current.has(j.id));
      return Promise.all(mine.map(async j => {
        // Jobs enumerated before the sendable counters existed self-heal on first sight:
        // SKIPPED rows are bounded by the archived count, so this walk is small.
        let counters = j.counters ?? {};
        if (counters.sendable == null) {
          let skipped = 0, skippedBytes = 0;
          await eachItemByStatus(j.id, ITEM_STATUS.SKIPPED, (it) => { skipped += 1; skippedBytes += it.size || 0; });
          counters = {
            ...counters,
            sendable:      (counters.total ?? 0) - skipped,
            bytesSendable: (counters.bytesTotal ?? 0) - skippedBytes,
          };
          await updateJob(j.id, { counters });
        }
        const counts = {
          pending: await countItemsByStatus(j.id, ITEM_STATUS.PENDING),
          failed:  await countItemsByStatus(j.id, ITEM_STATUS.FAILED),
          issued:  await countItemsByStatus(j.id, ITEM_STATUS.ISSUED),
          done:    await countItemsByStatus(j.id, ITEM_STATUS.DONE),
        };
        return { ...j, counters, counts, jobClass: classifyJob(counts) };
      }));
    },
    startJob: async ({ bucket, prefix, roots, mode, label }) => {
      const job = {
        id: crypto.randomUUID(),
        bucket, prefix, roots, mode, label: label ?? null,
        // Recorded because a manifest outlives the session that built it, and the archived
        // check at enumeration is provider-specific. Jobs created before this field
        // existed have none, which correctly flags nothing rather than guessing AWS.
        provider: credentials.provider || detectProvider(credentials.endpoint),
        status: JOB_STATUS.ENUMERATING,
        enumeration: {},
        counters: { total: 0, bytesTotal: 0, sendable: 0, bytesSendable: 0 },
        createdAt: Date.now(),
      };
      await saveJob(job);
      return job;
    },
    // The directory handle is obtained in the component, because showDirectoryPicker
    // needs a user gesture and cannot be called from here. The bucket is re-checked for
    // the same reason handleDownloadStart re-checks it: a manifest outlives the session
    // that built it, and a stale list surviving a reconnect would otherwise verify one
    // bucket's job against another bucket's session.
    verify: async (jobId, dirHandle) => {
      const job = await loadJob(jobId);
      if (!job || job.bucket !== credentials.bucket) {
        throw new Error('That download was created for a different bucket. Reconnect to it to check it.');
      }
      return verifyJob(jobId, dirHandle);
    },
    enumerate: (job, opts) => enumerateJob(client, job, opts),
    // A zip job's manifest isn't the only thing to clean up — its staged bytes sit in
    // OPFS under the job's id and outlive the job record otherwise.
    discard: async (id) => {
      const j = await loadJob(id);
      if (j?.delivery === 'zip') await discardZipStaging(id, { root: await navigator.storage.getDirectory() });
      return deleteJob(id);
    },
    // The gate's async I/O — quota and the persist() flag — is kept here rather than in
    // the panel, which must stay free of navigator.storage the same way it stays free of
    // IndexedDB and the SDK. caps are the same browserCapabilities used everywhere else.
    zipGate: async ({ sendableBytes }) => {
      const quota = await readStorageQuota();
      const persisted = await zipStoragePersisted();
      return zipGate({ caps: browserCapabilities, sendableBytes, quota, persisted });
    },
    // The lazy-persist path (design spec): ask for persistent storage, then re-evaluate
    // the same gate with fresh numbers. persist() can silently fail to grant anything, so
    // persisted() is re-read rather than assumed — that is what lets a still-too-big job
    // correctly land back on 'needs-storage' (offer the retry) instead of a wrong,
    // permanent-looking 'unavailable'.
    requestPersist: async ({ sendableBytes }) => {
      try { await navigator.storage?.persist?.(); } catch { /* best effort; re-evaluate regardless */ }
      const quota = await readStorageQuota();
      const persisted = await zipStoragePersisted();
      return zipGate({ caps: browserCapabilities, sendableBytes, quota, persisted });
    },
    // Patches the job record for zip delivery and hands back the patched job so the panel
    // can feed it straight into its existing start-flow (onStart routes delivery:'zip' to
    // handleZipStart).
    startZipJob: async (job) => {
      const patch = { delivery: 'zip', zipName: zipFileName(job.bucket, job.prefix ?? '') };
      await updateJob(job.id, patch);
      return { ...job, ...patch };
    },
    // Re-export from the intact OPFS staging for a zip job that finished (every item DONE)
    // but never got its export written — exportZip threw, or the save dialog was
    // cancelled. The same recoverable "DONE, no exportedAt" state handleZipStart itself
    // leaves a job in when export fails.
    exportZipAgain: async (id) => {
      const j = await loadJob(id);
      if (!j) return;
      const root = await navigator.storage.getDirectory();
      const zipName = j.zipName || zipFileName(j.bucket, j.prefix ?? '');
      await exportZip(async () => {
        const staging = await openZipStaging(id, { root });
        return staging.getFile();
      }, zipName);
      await updateJob(id, { exportedAt: Date.now() });
    },
  }), [client, credentials.bucket, credentials.provider, credentials.endpoint, browserCapabilities]);

  // The panel has already listed the folder and taken the user's confirmation, so this
  // starts issuing straight away. Note it never touches capabilities: presigning is a
  // local signing operation, so its success proves nothing about read permission.
  async function handleDownloadStart(job) {
    const fresh = await loadJob(job.id);
    if (!fresh) return;

    // A manifest outlives the session that built it. Nothing today can reach here with a
    // job from another connection — listJobs() filters by bucket, and new jobs take
    // theirs from the live one — but the two are separate facts stored in separate places,
    // so the match is checked rather than assumed. Without this, a stale job would presign
    // its own recorded bucket using the *current* client, signing for a bucket the user is
    // not connected to.
    if (fresh.bucket !== credentials.bucket) {
      showToast('That download was created for a different bucket. Reconnect to it to continue.');
      return;
    }

    // Resuming must actually retry what failed last time; items are left in FAILED so the
    // previous run could report them, and a resume only picks up PENDING.
    await resetFailedToPending(fresh.id);

    // The task total is what THIS run will send: the live PENDING count, taken after the
    // failed-reset. Not counters.total — SKIPPED (archived) items are in the manifest but
    // can never be issued, and a row that ends "Sent 400 of 412" reads as 12 files lost
    // (postmortem F5). Not counters.sendable either — a resume sends the remainder, and
    // "Sent 2 of 2" is what a completed 2-file resume looks like, not "Sent 2 of 3".
    const total = await countItemsByStatus(fresh.id, ITEM_STATUS.PENDING);
    const task = createDownloadTask({ fileCount: total, bucket: fresh.bucket, capturedPrefix: fresh.prefix });
    const id = taskStore.add(task);
    taskStore.update(id, { subPhase: null, total }, true);
    activeDownloadJobs.current.add(fresh.id);
    await updateJob(fresh.id, { status: JOB_STATUS.RUNNING });

    const presign = (key, filename) => getSignedUrl(
      client,
      new GetObjectCommand(presignDownloadParams({ Bucket: fresh.bucket, Key: key, filename })),
      { expiresIn: DOWNLOAD_PRESIGN_EXPIRES },
    );

    try {
      const result = await runDownloadJob(fresh, {
        presign,
        issue: issueBrowserDownload,
        probe: probeUrl,
        shouldCancel: () => taskStore.isCancelRequested(id),
        onProgress: ({ issued }) => taskStore.update(id, { current: issued }, false),
      }, { delayMs: DOWNLOAD_ISSUE_DELAY_MS });

      // A job-wide stop leads the error list rather than joining it: it explains why the
      // run ended, whereas the per-item entries are only the keys that individually failed.
      const errors = result.blocked
        ? [{ key: '(job stopped)', message: blockedMessage(result.blocked) }, ...result.errors]
        : result.errors;

      taskStore.update(id, {
        status:   result.cancelled ? 'cancelled' : 'done',
        subPhase: null,
        current:  result.issued,
        errors,
      }, true);

      // A manifest is kept whenever the run left something to act on — failures to retry,
      // a block to resume, or issued files whose arrival can still be verified. A run
      // that issued cleanly is DONE rather than PAUSED: nothing left to send, only to
      // check. updateJob, not saveJob({...fresh}): the run-start snapshot is stale by now
      // and a whole-record write would clobber anything written to the row meanwhile
      // (postmortem F6).
      if (jobOutcome(result).keep) {
        const resumable = result.failed > 0 || result.cancelled || result.blocked;
        await updateJob(fresh.id, { status: resumable ? JOB_STATUS.PAUSED : JOB_STATUS.DONE });
      } else {
        await deleteJob(fresh.id);
      }
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    } finally {
      activeDownloadJobs.current.delete(fresh.id);
    }
  }

  // Same shell as handleDownloadStart — bucket re-check, resetFailedToPending, the
  // activeDownloadJobs/updateJob discipline all mirror it exactly — but the engine is
  // runZipJob (byte-accurate progress, one OPFS staging file) instead of runDownloadJob,
  // and a clean run ends in a single exported download rather than N handed-off ones.
  async function handleZipStart(job) {
    const fresh = await loadJob(job.id);
    if (!fresh) return;

    // See handleDownloadStart: a manifest outlives the session that built it.
    if (fresh.bucket !== credentials.bucket) {
      showToast('That download was created for a different bucket. Reconnect to it to continue.');
      return;
    }

    await resetFailedToPending(fresh.id);

    // `current` is cumulative for a zip job — it starts at the prior run's DONE count and
    // climbs through this run's completions (zip-job.js's `completed`, and the doneCount
    // read below), because a zip is one file whose displayed progress must never regress
    // across a resume. `total` has to be on the same cumulative scale: the per-run PENDING
    // count alone reads as "N of M" with N > M on any resume that already has DONE items
    // (5 DONE + 3 PENDING would show "Zipping 5 of 3…"). Summing DONE + PENDING here
    // leaves a fresh run unchanged (DONE is 0) and makes a resume's total cover everything
    // sendable, prior and current, so current can never exceed it.
    const doneAtStart = await countItemsByStatus(fresh.id, ITEM_STATUS.DONE);
    const pending = await countItemsByStatus(fresh.id, ITEM_STATUS.PENDING);
    const total = doneAtStart + pending;
    // Static for the run, like total above: the sendable-bytes figure the job already
    // tracks (download-records.js's appendManifestPage), read the same way
    // DownloadJobPanel's allowStorageForJob reads it — bytesSendable falling back to
    // bytesTotal for a job enumerated before the sendable counters existed.
    const bytesTotal = fresh.counters?.bytesSendable ?? fresh.counters?.bytesTotal ?? 0;
    const task = createDownloadTask({
      fileCount: total, bucket: fresh.bucket, capturedPrefix: fresh.prefix, delivery: 'zip',
      jobId: fresh.id, bytesTotal,
    });
    const id = taskStore.add(task);
    taskStore.update(id, { subPhase: null, total }, true);
    activeDownloadJobs.current.add(fresh.id);
    // pausedForStorage cleared at run start (not just set on the pause branch below) so a
    // stale STORAGE marker from an earlier pause cannot survive into a run that ends up
    // pausing for a different reason, or finishing cleanly.
    await updateJob(fresh.id, { status: JOB_STATUS.RUNNING, pausedForStorage: false });

    const presign = (key, filename) => getSignedUrl(
      client,
      new GetObjectCommand(presignDownloadParams({ Bucket: fresh.bucket, Key: key, filename })),
      { expiresIn: DOWNLOAD_PRESIGN_EXPIRES },
    );

    try {
      const root = await navigator.storage.getDirectory();
      const result = await runZipJob(fresh, {
        presign,
        probe: probeUrl,
        root,
        shouldCancel: () => taskStore.isCancelRequested(id),
        onProgress: ({ done, bytesDone, active }) => taskStore.update(id, { current: done, bytesDone, active }, false),
      });

      // result.issued restarts at 0 every run, so on a resumed job it would regress the
      // displayed count below what onProgress already showed while running (that counts
      // cumulatively: DONE items from earlier runs plus this run's completions — see
      // zip-job.js's `completed`, which starts at `done.length`). Query the DONE count
      // directly so the terminal figure matches what was on screen a moment before,
      // however many runs it took to get here.
      const doneCount = await countItemsByStatus(fresh.id, ITEM_STATUS.DONE);

      const errors = result.blocked
        ? [{ key: '(job stopped)', message: blockedMessage(result.blocked) }, ...result.errors]
        : result.errors;

      taskStore.update(id, {
        status:   result.cancelled ? 'cancelled' : 'done',
        subPhase: null,
        current:  doneCount,
        finished: result.finished,
        failed:   result.failed,
        errors,
      }, true);

      if (result.finished) {
        // Mark the job DONE — staging holds a complete, valid zip — before attempting
        // export. exportZip can itself fail (the save dialog can be cancelled by the
        // user); if it does, the job must land in the same recoverable "DONE, no
        // exportedAt" state the design spec and Task 5's save-zip-again detection
        // expect, never stuck at RUNNING forever. exportedAt is written only once the
        // export actually succeeds. updateJob, not saveJob({...fresh}): same
        // stale-snapshot hazard as handleDownloadStart — fresh is a run-start snapshot,
        // and a whole-record write would clobber anything written to the row meanwhile.
        await updateJob(fresh.id, { status: JOB_STATUS.DONE });
        const zipName = fresh.zipName || zipFileName(fresh.bucket, fresh.prefix);
        await exportZip(async () => {
          const staging = await openZipStaging(fresh.id, { root });
          return staging.getFile();
        }, zipName);
        await updateJob(fresh.id, { exportedAt: Date.now() });
        taskStore.update(id, { exported: true }, true);
      } else {
        // Not finished — cancelled, job-wide blocked, or per-file failures left to retry.
        // Every one of those leaves something worth resuming, exactly like handoff's
        // resumable branch, so the manifest and staged bytes are kept rather than discarded.
        // A STORAGE-kind block (zip-job.js's QuotaExceededError handling) additionally
        // marks the job so the panel can offer the persist affordance right on its resume
        // row (spec §2, docs/superpowers/specs/2026-08-03-zip-download-design.md) — false
        // on every other pause reason, since the marker was already cleared at run start
        // and must not be left set by an earlier run's storage pause.
        await updateJob(fresh.id, { status: JOB_STATUS.PAUSED, pausedForStorage: result.blocked?.kind === 'STORAGE' });
      }
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    } finally {
      activeDownloadJobs.current.delete(fresh.id);
    }
  }

  // The MovePickerModal is the confirmation step, so a move/copy request starts
  // its task directly.
  async function handleMoveRequest({ files, prefixes, dest, capturedPrefix, mode = 'move', renameTo }) {
    const task = createTransferTask({ files, prefixes, dest, capturedPrefix, bucket: credentials.bucket, mode, renameTo });
    const id = taskStore.add(task);
    const runOperation = mode === 'rename' ? runRenameOperation : mode === 'copy' ? runCopyOperation : runMoveOperation;
    try {
      await runOperation(client, task.bucket, task, (update) => {
        // Remove moved source rows incrementally (copy+delete confirmed for those keys).
        if (update.movedKeys?.length) {
          browserActionsRef.current?.removeItems(update.movedKeys, []);
        }
        if (update.phase === 'done') {
          if (update.movedPrefixes?.length) {
            browserActionsRef.current?.removeItems([], update.movedPrefixes);
          }
          // Invalidate both the source view and the destination so each refetches.
          browserActionsRef.current?.invalidateCache(task.capturedPrefix);
          browserActionsRef.current?.invalidateCache(task.dest);
          if (update.moved > 0) {
            handleCapabilityChange('upload', 'permitted');
            if (mode !== 'copy') handleCapabilityChange('delete', 'permitted');
          }
          if (update.errors.length === 0 && !update.cancelled) {
            const verb = mode === 'copy' ? 'Copied' : mode === 'rename' ? 'Renamed' : 'Moved';
            showToast(`${verb} ${update.moved} item${update.moved === 1 ? '' : 's'}`);
          }
        }
        taskStore.update(id, engineUpdateToPatch(update, 'moved'), !!update.phase);
      }, () => taskStore.isCancelRequested(id));
    } catch (err) {
      taskStore.update(id, {
        status: 'done', subPhase: null,
        errors: [{ key: '(unexpected)', message: err.message || String(err) }],
      }, true);
    }
  }

  function handleSelectProfile(id) {
    const conn = resolveConnection(id);
    if (!conn) return;
    setSelectedConnectionId(id);
    saveLastProfileId(id);
    setCapabilities(loadConnectionCapabilities(id));
    const creds = { ...conn, secretKey: '' };
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

    const existing = selectedConnectionId ? connections.find(c => c.id === selectedConnectionId) : null;
    const id = existing ? existing.id : Date.now();
    const trimmedBucket = (liveFormData.bucket || '').trim();

    const cred = findOrCreateCredential({
      endpoint:       ep,
      keyId:          (liveFormData.keyId || '').trim(),
      provider,
      regionOverride: (liveFormData.regionOverride || '').trim(),
    });

    const conn = {
      id,
      name:         name || defaultConnectionName({ provider, bucket: trimmedBucket }),
      credentialId: cred.id,
      bucket:       trimmedBucket,
    };
    // Only set capabilities when creating. On update, omit the key so
    // saveConnectionRecord's merge keeps what is in storage: capability changes are
    // written directly to localStorage and are not reflected in the `connections`
    // React snapshot, so reading them from state here would revert them.
    if (!existing) conn.capabilities = null;
    saveConnectionRecord(conn);
    // Re-wrap under the (possibly new) credential id while the vault is unlocked and
    // the form holds a secret. Task 1's cascade in saveConnectionRecord/
    // deleteCredentialRecord already collected the superseded credential above when
    // this re-points an existing connection — without this, the user's just-typed
    // secret would be wrapped under an id nothing references any more and silently
    // forgotten the moment it was superseded. Fire-and-forget with a catch:
    // rememberSecret can reject on a malformed vault session key from external
    // tampering only, and this is not on an async path the caller awaits.
    if (isUnlocked() && liveFormData.secretKey) {
      rememberSecret(cred.id, liveFormData.secretKey, window.crypto.subtle).catch(() => {});
    }

    const updated = listResolvedConnections();
    setConnections(updated);
    setSelectedConnectionId(id);
    saveLastProfileId(id);
    // Sync credentials so the form doesn't reset when it remounts on key change.
    //
    // Built from what we just wrote (`cred`, `conn`), NOT from a read-back
    // (`updated.find(...)`). Every storage write above goes through a wrapper
    // (safeSetRaw) that swallows failure by design — private browsing, blocked
    // site data, quota exhaustion. If the write silently doesn't land, a
    // read-back finds no matching row, `saved` is `undefined`, and
    // `{ ...undefined }` collapses to `{}` — blanking endpoint/bucket/keyId/
    // provider in the very form the user just filled in, made immediately
    // visible by the remount the selectedConnectionId change triggers on
    // CredentialForm's key. `cred` and `conn` are already in memory and always
    // defined, so this shape is built to match resolveConnection()'s field set
    // exactly (id/name/bucket/capabilities/credentialId/endpoint/keyId/provider/
    // regionOverride), so CredentialForm receives the identical shape whether or
    // not the write actually landed.
    const creds = {
      id,
      name:           conn.name,
      bucket:         conn.bucket,
      // Mirrors the `if (!existing) conn.capabilities = null;` branch above: a
      // new connection's capabilities are null; an updated one keeps whatever
      // was already known (existing is the pre-write snapshot from React state —
      // the same source conn.capabilities deliberately avoided overwriting).
      capabilities:   existing ? (existing.capabilities ?? null) : null,
      credentialId:   cred.id,
      endpoint:       cred.endpoint,
      keyId:          cred.keyId,
      provider:       cred.provider,
      regionOverride: cred.regionOverride,
      secretKey:      liveFormData.secretKey || '',
    };
    setCredentials(creds);
    setLiveFormData(creds);
  }

  function handleDeleteProfile(id) {
    deleteConnectionRecord(id);
    setConnections(listResolvedConnections());
    if (selectedConnectionId === id) {
      setSelectedConnectionId(null);
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
      {downloadOpen && session === 'connected' && (
        <DownloadJobPanel
          bucket={credentials.bucket}
          scope={downloadScope ?? { kind: 'folder', prefix: currentPrefix }}
          api={downloadApi}
          capabilities={browserCapabilities}
          onStart={(job) => job.delivery === 'zip' ? handleZipStart(job) : handleDownloadStart(job)}
          onClose={() => { setDownloadOpen(false); setDownloadScope(null); }}
          onUseTransferTool={() => {
            // Only reachable from folder scope (the panel hides the link otherwise), so the
            // handoff targets the panel's folder — which may be a subfolder the user never
            // navigated into.
            setHandoffPrefix(downloadScope?.kind === 'folder' ? downloadScope.prefix : currentPrefix);
            setDownloadOpen(false); setDownloadScope(null); setHandoffOpen(true);
          }}
        />
      )}
      {handoffOpen && (
        <TransferHandoff
          credentials={credentials}
          currentPrefix={handoffPrefix ?? currentPrefix}
          onClose={() => { setHandoffOpen(false); setHandoffPrefix(null); }}
        />
      )}
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
      {pendingDelete && (
        <DeleteConfirmModal
          request={pendingDelete}
          provider={credentials.provider}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setPendingDelete(null)}
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
          <ShareLinkMenu credentials={credentials} />
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
      {showVaultOffer && (
        <VaultOfferBanner
          busy={vaultOfferBusy}
          error={vaultOfferError}
          onCreate={handleAcceptVaultOffer}
          onDismiss={handleDismissVaultOffer}
        />
      )}

      {session === 'locked' || session === 'disconnected' || session === 'connecting' || session === 'failed' ? (
        <div class="main-content">
          <div class="splash">
            <h2>{session === 'locked' ? 'Unlock your vault' : 'Connect to a bucket'}</h2>
            {session === 'locked' ? (
              <VaultUnlock connections={connections} onUnlock={handleVaultUnlock} onReset={handleVaultReset} />
            ) : (
              <>
                <ProfilePicker
                  profiles={connections}
                  selectedId={selectedConnectionId}
                  onSelect={handleSelectProfile}
                  onDelete={handleDeleteProfile}
                  onSave={handleSaveProfile}
                  currentFormData={liveFormData}
                />
                {urlParamsPresent && (
                  <div class="banner banner-info" style={{ marginBottom: '1rem' }}>
                    <div class="banner-body">
                      {urlHadKeyId
                        ? 'Connection details pre-filled from URL — enter your Secret Key to connect.'
                        : 'Endpoint and bucket pre-filled from URL — enter your Key ID and Secret Key to connect.'}
                    </div>
                  </div>
                )}
                <CredentialForm
                  key={`${selectedConnectionId ?? 'manual'}-${formResetKey}`}
                  initial={credentials}
                  onSave={handleConnect}
                  onFormChange={setLiveFormData}
                  loading={session === 'connecting'}
                  autoFocusSecret={urlHadKeyId && !credentials.secretKey}
                />
                {session === 'failed' && connectionError && (
                  <div style={{ marginTop: '1rem' }}>
                    <ErrorBlock
                      error={connectionError}
                      title="Connection failed"
                      guidance="Check your endpoint URL, bucket name, and credentials. If this looks like a CORS error, ensure CORS is configured on your bucket."
                      diagnostics={diagnosticsProps(credentials)}
                    />
                  </div>
                )}
              </>
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
            {selectedConnectionId && connections.find(p => p.id === selectedConnectionId) && (
              <div class="profile-active-name">
                {connections.find(p => p.id === selectedConnectionId).name}
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

            <MasterQueue
              readZipDetail={(jobId) => loadZipDetail(jobId).catch(() => ({ done: [], failed: [], doneCount: 0, failedCount: 0 }))}
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
              onDownloadRequest={handleDownloadRequest}
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
    locked:       'status-disconnected', // no dedicated CSS state — reads the same as disconnected
    disconnected: 'status-disconnected',
    connecting:   'status-connecting',
    connected:    'status-connected',
    failed:       'status-failed',
  }[session] || 'status-disconnected';

  const label = {
    locked:       'Locked',
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

// The post-connect vault offer: "Save this key so you don't have to retype it next
// time?" Follows the existing banner idiom (FileBanner.jsx, UpdateBanner.jsx) rather
// than a modal takeover — dismissible via the same .banner-close control, not a gate.
// The passphrase field it collects is the vault CREATION form (there is no separate
// component for that in this plan — VaultUnlock.jsx only unlocks an existing vault),
// so it repeats VaultUnlock's password-manager fields: the same readonly account
// value (VAULT_USERNAME, imported — must match VaultUnlock's exactly so a manager
// matches the two screens as one saved login) and autocomplete="new-password" so a
// manager offers to generate the passphrase, per the design doc.
function VaultOfferBanner({ busy, error, onCreate, onDismiss }) {
  const [passphrase, setPassphrase] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (busy || !passphrase) return;
    onCreate(passphrase);
  }

  return (
    <div class="banner banner-info" role="status">
      <div class="banner-body">
        <div>Save this key so you don't have to retype it next time?</div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '.4rem' }}>
          <label htmlFor="vault-offer-username" class="hint">Account</label>
          <input
            id="vault-offer-username"
            name="vault-username"
            type="text"
            value={VAULT_USERNAME}
            readOnly
            autocomplete="username"
            style={{ width: '14rem' }}
          />
          <label htmlFor="vault-offer-passphrase" class="hint">Passphrase</label>
          <input
            id="vault-offer-passphrase"
            name="vault-new-passphrase"
            type="password"
            value={passphrase}
            onInput={e => setPassphrase(e.target.value)}
            autocomplete="new-password"
            required
          />
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <><span class="spinner" /> Saving…</> : 'Save key'}
          </button>
          {error && <span class="field-error">{error}</span>}
        </form>
      </div>
      <button class="banner-close" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
