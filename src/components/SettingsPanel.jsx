// Copyright (C) 2026 HidayahTech, LLC
// Application settings (page size, upload concurrency, part size) (§4.7)
import { useState } from 'preact/hooks';
import { loadMaxKeys, saveMaxKeys, loadPartConcurrency, savePartConcurrency, loadPartSizeMB, savePartSizeMB, loadFileConcurrency, saveFileConcurrency, loadListingCacheTTL, saveListingCacheTTL, loadUpdateCheckEnabled, saveUpdateCheckEnabled, loadPrefetchSizeLimit, savePrefetchSizeLimit, loadUploadExpandThreshold, saveUploadExpandThreshold, loadAdaptiveMode, saveAdaptiveMode } from '../lib/storage.js';
import { defaultMaxKeys } from '../lib/provider.js';

const DEFAULT_PART_CONCURRENCY     = 4;
const DEFAULT_PART_SIZE_MB         = 5;
const DEFAULT_FILE_CONCURRENCY     = 3;
const DEFAULT_LISTING_CACHE_TTL    = 120;
const DEFAULT_UPLOAD_EXPAND_THRESHOLD = 5;

export function SettingsPanel({ provider, updateCheckEnabled, onUpdateCheckChange, prefetchSizeLimit, onPrefetchSizeLimitChange }) {
  const providerDefault = defaultMaxKeys(provider);

  const [maxKeysValue, setMaxKeysValue] = useState(() => {
    const v = loadMaxKeys(); return v ? String(v) : '';
  });
  const [concurrencyValue, setConcurrencyValue] = useState(() => {
    const v = loadPartConcurrency(); return String(v ?? DEFAULT_PART_CONCURRENCY);
  });
  const [partSizeValue, setPartSizeValue] = useState(() => {
    const v = loadPartSizeMB(); return String(v ?? DEFAULT_PART_SIZE_MB);
  });
  const [fileConcurrencyValue, setFileConcurrencyValue] = useState(() => {
    const v = loadFileConcurrency(); return String(v ?? DEFAULT_FILE_CONCURRENCY);
  });
  const [cacheTTLValue, setCacheTTLValue] = useState(() => {
    const v = loadListingCacheTTL(); return String(v ?? DEFAULT_LISTING_CACHE_TTL);
  });
  const [uploadExpandThresholdValue, setUploadExpandThresholdValue] = useState(() => {
    return String(loadUploadExpandThreshold() ?? DEFAULT_UPLOAD_EXPAND_THRESHOLD);
  });

  // Tracks what's actually persisted — updated on every successful save
  const [activeConcurrency, setActiveConcurrency] = useState(() => loadPartConcurrency() ?? DEFAULT_PART_CONCURRENCY);
  const [activePartSize, setActivePartSize] = useState(() => loadPartSizeMB() ?? DEFAULT_PART_SIZE_MB);
  const [activeFileConcurrency, setActiveFileConcurrency] = useState(() => loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY);

  const [adaptiveMode, setAdaptiveMode] = useState(() => loadAdaptiveMode());

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  function handleSave(e) {
    e.preventDefault();
    setError(null);

    // Empty maxKeysValue → use provider default (not an error)
    const n  = maxKeysValue ? parseInt(maxKeysValue, 10) : providerDefault;
    const c  = parseInt(concurrencyValue, 10);
    const p  = parseInt(partSizeValue, 10);
    const f  = parseInt(fileConcurrencyValue, 10);
    const et = parseInt(uploadExpandThresholdValue, 10);

    if (isNaN(n)  || n < 1   || n > 100000) { setError('Page size must be 1–100,000.'); return; }
    if (isNaN(c)  || c < 1   || c > 16)     { setError('Upload part concurrency must be 1–16.'); return; }
    if (isNaN(p)  || p < 5   || p > 512)    { setError('Part size must be 5–512 MB.'); return; }
    if (isNaN(f)  || f < 1   || f > 16)     { setError('File concurrency must be 1–16.'); return; }
    if (isNaN(et) || et < 0  || et > 1000)  { setError('Upload expand threshold must be 0–1000.'); return; }

    saveMaxKeys(n);
    savePartConcurrency(c);
    savePartSizeMB(p);
    saveFileConcurrency(f);
    saveListingCacheTTL(parseInt(cacheTTLValue, 10));
    saveUploadExpandThreshold(et);

    setActiveConcurrency(c);
    setActivePartSize(p);
    setActiveFileConcurrency(f);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setError(null);
    setMaxKeysValue('');
    setConcurrencyValue(String(DEFAULT_PART_CONCURRENCY));
    setPartSizeValue(String(DEFAULT_PART_SIZE_MB));
    setFileConcurrencyValue(String(DEFAULT_FILE_CONCURRENCY));
    setCacheTTLValue(String(DEFAULT_LISTING_CACHE_TTL));
    setUploadExpandThresholdValue(String(DEFAULT_UPLOAD_EXPAND_THRESHOLD));
    saveMaxKeys(providerDefault);
    savePartConcurrency(DEFAULT_PART_CONCURRENCY);
    savePartSizeMB(DEFAULT_PART_SIZE_MB);
    saveFileConcurrency(DEFAULT_FILE_CONCURRENCY);
    saveListingCacheTTL(DEFAULT_LISTING_CACHE_TTL);
    saveUploadExpandThreshold(DEFAULT_UPLOAD_EXPAND_THRESHOLD);
    savePrefetchSizeLimit(5 * 1024 * 1024);
    onPrefetchSizeLimitChange(5 * 1024 * 1024);
    saveAdaptiveMode(true);
    setAdaptiveMode(true);
    setActiveConcurrency(DEFAULT_PART_CONCURRENCY);
    setActivePartSize(DEFAULT_PART_SIZE_MB);
    setActiveFileConcurrency(DEFAULT_FILE_CONCURRENCY);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      <div class="section-heading">Settings</div>
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        <div class="form-group">
          <label htmlFor="setting-cache-ttl">Listing cache</label>
          <select id="setting-cache-ttl" value={cacheTTLValue} onChange={e => setCacheTTLValue(e.target.value)}>
            <option value="0">Off — always fetch fresh</option>
            <option value="30">30 seconds</option>
            <option value="120">2 minutes (default)</option>
            <option value="600">10 minutes</option>
          </select>
          <span class="hint">
            How long to keep folder listing results in memory. Revisiting a folder
            within this window skips the network call. Mutations (delete, rename,
            upload) always invalidate the cache for the affected folder.
            Recommended: Off for buckets with frequent concurrent writes (e.g. Backblaze B2).
          </span>
        </div>
        <div class="form-group">
          <label htmlFor="setting-maxkeys">Page size (MaxKeys)</label>
          <input
            id="setting-maxkeys"
            type="number"
            value={maxKeysValue}
            onInput={e => setMaxKeysValue(e.target.value)}
            placeholder={`Default: ${providerDefault}`}
            min="1"
            max="100000"
          />
          <span class="hint">Objects per listing page. Provider default: {providerDefault}.</span>
        </div>
        <div class="form-group">
          <label htmlFor="setting-partsize">Upload part size (MiB)</label>
          <input
            id="setting-partsize"
            type="number"
            value={partSizeValue}
            onInput={e => setPartSizeValue(e.target.value)}
            min="5"
            max="512"
          />
          <span class="hint">
            Per-part chunk size in MiB (1 MiB = 1,048,576 bytes), range 5–512 MiB.
            Larger parts improve throughput on fast connections.
            Peak RAM: concurrency × part size.
            The S3 spec minimum is 5 MB (5,000,000 bytes); the smallest selectable value
            here is 5 MiB (5,242,880 bytes), which safely exceeds that.
            Raised automatically if needed to stay within the 10,000-part limit.
          </span>
          <span class="hint" style={{ color: 'var(--accent)' }}>
            Active: <strong>{activePartSize} MiB</strong>
          </span>
        </div>
        <div class="form-group">
          <label>Upload concurrency mode</label>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="concurrency-mode"
                value="adaptive"
                checked={adaptiveMode}
                onChange={() => { saveAdaptiveMode(true); setAdaptiveMode(true); }}
              />
              Adaptive
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="concurrency-mode"
                value="manual"
                checked={!adaptiveMode}
                onChange={() => { saveAdaptiveMode(false); setAdaptiveMode(false); }}
              />
              Manual
            </label>
          </div>
          <span class="hint">
            Adaptive automatically scales file and part concurrency based on how many uploads are active.
            Manual exposes the sliders below for direct control.
          </span>
        </div>
        {!adaptiveMode && (
          <>
            <div class="form-group">
              <label htmlFor="setting-concurrency">Upload part concurrency</label>
              <input
                id="setting-concurrency"
                type="number"
                value={concurrencyValue}
                onInput={e => setConcurrencyValue(e.target.value)}
                min="1"
                max="16"
              />
              <span class="hint">Simultaneous part uploads per file (1–16). Default: {DEFAULT_PART_CONCURRENCY}.</span>
              <span class="hint" style={{ color: 'var(--accent)' }}>
                Active: <strong>{activeConcurrency}</strong>
              </span>
            </div>
            <div class="form-group">
              <label htmlFor="setting-fileconcurrency">File concurrency</label>
              <input
                id="setting-fileconcurrency"
                type="number"
                value={fileConcurrencyValue}
                onInput={e => setFileConcurrencyValue(e.target.value)}
                min="1"
                max="16"
              />
              <span class="hint">Simultaneous file uploads (1–16). Default: {DEFAULT_FILE_CONCURRENCY}. Higher values improve throughput for many small files; lower values reduce load on constrained backends.</span>
              <span class="hint" style={{ color: 'var(--accent)' }}>
                Active: <strong>{activeFileConcurrency}</strong>
              </span>
            </div>
          </>
        )}
        <div class="form-group">
          <label htmlFor="setting-expand-threshold">Upload queue expand threshold</label>
          <input
            id="setting-expand-threshold"
            type="number"
            value={uploadExpandThresholdValue}
            onInput={e => setUploadExpandThresholdValue(e.target.value)}
            min="0"
            max="1000"
          />
          <span class="hint">
            Batches with this many files or fewer start expanded; larger batches start collapsed.
            0 = always start collapsed. Default: {DEFAULT_UPLOAD_EXPAND_THRESHOLD}.
          </span>
        </div>
        {error && <span style={{ fontSize: '.8rem', color: 'var(--text-danger)' }}>{error}</span>}
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          <button type="submit" class="btn btn-ghost btn-sm">Save</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={handleReset}>Reset to defaults</button>
          {saved && <span style={{ fontSize: '.8rem', color: 'var(--text-success)' }}>Saved</span>}
        </div>
      </form>

      <div class="form-group" style={{ marginTop: '.75rem' }}>
        <label htmlFor="setting-prefetch">Preview prefetch</label>
        <select id="setting-prefetch" value={String(prefetchSizeLimit)} onChange={e => onPrefetchSizeLimitChange(Number(e.target.value))}>
          <option value="0">Off</option>
          <option value={String(1 * 1024 * 1024)}>Up to 1 MB</option>
          <option value={String(5 * 1024 * 1024)}>Up to 5 MB (default)</option>
          <option value={String(10 * 1024 * 1024)}>Up to 10 MB</option>
          <option value={String(25 * 1024 * 1024)}>Up to 25 MB</option>
        </select>
        <span class="hint">
          Pre-loads the next and previous items while viewing a preview so navigation
          feels instant. Images within the size limit and text files are fetched in
          the background; audio and video are never prefetched. Increases egress —
          reduce or disable on metered connections.
        </span>
      </div>

      <div class="form-group" style={{ marginTop: '.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={updateCheckEnabled}
            onChange={e => onUpdateCheckChange(e.target.checked)}
          />
          Background update checks
        </label>
        <span class="hint">
          Periodically polls this app's own URL to detect when a new version is available.
          While minimal, repeated requests from an open tab are a minor information leak —
          disable if you prefer no background requests.
        </span>
      </div>
    </div>
  );
}
