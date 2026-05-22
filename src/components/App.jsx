// Root app component — session state machine (§4.14)
import { useState, useEffect, useCallback } from 'preact/hooks';
import logoUrl from '../assets/bucketer-logo.png';
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
      <header class="app-header">
        <img src={logoUrl} alt="Bucketer" class="app-logo" />
        <span class="spacer" />
        {providerLabel && session === 'connected' && (
          <span class="header-status">{providerLabel}</span>
        )}
        <StatusBadge session={session} />
        {session === 'connected' && buildShareUrl(credentials) && (
          <button
            class="btn btn-ghost btn-sm"
            style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
            onClick={handleCopyLink}
            title="Copy a shareable link with endpoint and bucket pre-filled (no credentials)"
          >
            {linkCopied ? '✓ Copied' : 'Copy link'}
          </button>
        )}
        {session === 'connected' && (
          <button class="btn btn-ghost btn-sm" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }} onClick={handleDisconnect}>
            Disconnect
          </button>
        )}
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
          </div>
        </div>
      ) : (
        <div class="app-body">
          <aside class="sidebar">
            <CredentialForm
              initial={credentials}
              onSave={(creds) => handleConnect(creds, { reconnect: true })}
              loading={false}
            />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <CapabilityPanel capabilities={capabilities} onRefresh={handleRefreshPermissions} />
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
            <SettingsPanel provider={credentials.provider} />
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
