// Root app component — session state machine (§4.14)
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import logoUrl from '../assets/bucketer-logo.svg';
import { createS3Client } from '../lib/s3-client.js';
import { detectProvider, PROVIDER_LABELS } from '../lib/provider.js';
import {
  loadCredentials, saveCredentials, clearCredentials,
  loadCapabilities, saveCapabilities, clearCapabilities, defaultCapabilities,
} from '../lib/storage.js';
import { readUrlParams, hasUrlParams, buildShareUrl } from '../lib/url-params.js';
import { FileBanner } from './FileBanner.jsx';
import { CredentialForm } from './CredentialForm.jsx';
import { Browser } from './Browser.jsx';
import { UploadQueue } from './UploadQueue.jsx';
import { CapabilityPanel } from './CapabilityPanel.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { UploadLog } from './UploadLog.jsx';
import { ErrorBlock } from './ErrorBlock.jsx';
import { UpdateBanner } from './UpdateBanner.jsx';
import { ChangelogModal } from './ChangelogModal.jsx';
import { CURRENT_VERSION } from '../lib/changelog.js';

const _iconLink = document.querySelector('link[rel="icon"]');
if (_iconLink) _iconLink.href = logoUrl;

// Session states: disconnected | connecting | connected | failed
export function App() {
  const [session, setSession] = useState('disconnected');
  // Merge URL params over stored credentials so the form is pre-filled on load
  const [credentials, setCredentials] = useState(() => ({ ...loadCredentials(), ...readUrlParams() }));
  const [client, setClient] = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  const [capabilities, setCapabilities] = useState(() => loadCapabilities());
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [browserKey, setBrowserKey] = useState(0); // force re-mount on reconnect
  const [logKey, setLogKey] = useState(0);         // incremented to refresh upload log
  const [linkCopied, setLinkCopied] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const addFilesRef = useRef(null);
  const urlParamsPresent = hasUrlParams();

  // Capabilities are stored in localStorage and updated reactively (§4.12)
  const handleCapabilityChange = useCallback((op, state) => {
    setCapabilities(prev => {
      if (prev[op] === state) return prev;
      const next = { ...prev, [op]: state };
      saveCapabilities(next);
      return next;
    });
  }, []);

  function handleRefreshPermissions() {
    const fresh = defaultCapabilities();
    setCapabilities(fresh);
    saveCapabilities(fresh);
    setBrowserKey(k => k + 1); // re-mount browser → triggers new listing probe
  }

  async function handleConnect(creds, { reconnect = false } = {}) {
    // When reconnecting from the sidebar while already connected, stay in 'connected'
    // state to avoid a flash to the splash view (D2 in QUESTIONS.md)
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

  function handleDisconnect() {
    setSession('disconnected');
    setClient(null);
    setConnectionError(null);
    clearCredentials();
    clearCapabilities();
    setCapabilities(defaultCapabilities());
    setCredentials({ endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' });
    setBrowserKey(k => k + 1);
  }

  // Auto-connect if credentials are stored. Merge URL params so endpoint/bucket
  // from the URL override stored values (secret key never comes from URL).
  useEffect(() => {
    const stored = loadCredentials();
    const merged = { ...stored, ...readUrlParams() };
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

  async function handleCopyLink() {
    const url = buildShareUrl(credentials);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* clipboard API unavailable */ }
  }

  const providerLabel = credentials.provider ? PROVIDER_LABELS[credentials.provider] : null;

  const statusLabel = {
    disconnected: 'Disconnected',
    connecting:   'Connecting…',
    connected:    `Connected${credentials.bucket ? ` · ${credentials.bucket}` : ''}`,
    failed:       'Connection failed',
  }[session];

  return (
    <div id="app">
      {changelogOpen && <ChangelogModal onClose={() => setChangelogOpen(false)} />}
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
        <img src={logoUrl} alt="Bucketer" class="app-logo" />
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
            {linkCopied && <span style={{ fontSize: '.8rem', color: '#86efac' }}>✓ Copied</span>}
          </>
        )}
        {session === 'connected' && (
          <button class="btn btn-ghost btn-sm" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }} onClick={handleDisconnect}>
            Disconnect
          </button>
        )}
        <button class="btn-version" onClick={() => setChangelogOpen(true)} title="View changelog">
          v{CURRENT_VERSION}
        </button>
      </header>

      <UpdateBanner />
      <FileBanner />

      {session === 'disconnected' || session === 'connecting' || session === 'failed' ? (
        <div class="main-content">
          <div class="splash">
            <h2>Connect to a bucket</h2>
            {urlParamsPresent && (
              <div class="banner banner-info" style={{ marginBottom: '1rem' }}>
                <div class="banner-body">
                  Endpoint and bucket pre-filled from URL — enter your Key ID and Secret Key to connect.
                </div>
              </div>
            )}
            <CredentialForm
              initial={credentials}
              onSave={handleConnect}
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
                <div class="splash-info-heading">Your data stays private</div>
                <p>
                  Bucketer runs entirely in your browser. Your files, credentials, and requests
                  travel directly between your browser and your storage bucket — this server
                  is never involved and never sees any of it.
                </p>
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
            <CredentialForm
              initial={credentials}
              onSave={(creds) => handleConnect(creds, { reconnect: true })}
              loading={false}
            />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <CapabilityPanel capabilities={capabilities} onRefresh={handleRefreshPermissions} />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <SettingsPanel provider={credentials.provider} />
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

          <main class="main-content">
            {/* Upload zone above the browser */}
            <UploadQueue
              client={client}
              bucket={credentials.bucket}
              provider={credentials.provider}
              currentPrefix={currentPrefix}
              credentials={credentials}
              onCapabilityChange={handleCapabilityChange}
              capabilities={capabilities}
              onUploadsComplete={() => setBrowserKey(k => k + 1)}
              onLogEntry={() => setLogKey(k => k + 1)}
              onMount={({ addFiles }) => { addFilesRef.current = addFiles; }}
            />

            <UploadLog refreshKey={logKey} />

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1rem 0' }} />

            <Browser
              key={browserKey}
              client={client}
              bucket={credentials.bucket}
              provider={credentials.provider}
              credentials={credentials}
              onCapabilityChange={handleCapabilityChange}
              capabilities={capabilities}
              onInitialListFailed={(err) => { setSession('failed'); setConnectionError(err); }}
              onUploadTargetChange={setCurrentPrefix}
              onExternalDrop={(entries) => addFilesRef.current?.(entries)}
            />
          </main>
        </div>
      )}
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
