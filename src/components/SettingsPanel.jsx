// Application settings (page size, upload concurrency, part size) (§4.7)
import { useState } from 'preact/hooks';
import { loadMaxKeys, saveMaxKeys, loadPartConcurrency, savePartConcurrency, loadPartSizeMB, savePartSizeMB, loadFileConcurrency, saveFileConcurrency } from '../lib/storage.js';
import { defaultMaxKeys } from '../lib/provider.js';

const DEFAULT_PART_CONCURRENCY = 4;
const DEFAULT_PART_SIZE_MB     = 5;
const DEFAULT_FILE_CONCURRENCY = 3;

export function SettingsPanel({ provider }) {
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

  // Tracks what's actually persisted — updated on every successful save
  const [activeConcurrency, setActiveConcurrency] = useState(() => loadPartConcurrency() ?? DEFAULT_PART_CONCURRENCY);
  const [activePartSize, setActivePartSize] = useState(() => loadPartSizeMB() ?? DEFAULT_PART_SIZE_MB);
  const [activeFileConcurrency, setActiveFileConcurrency] = useState(() => loadFileConcurrency() ?? DEFAULT_FILE_CONCURRENCY);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  function handleSave(e) {
    e.preventDefault();
    setError(null);

    // Empty maxKeysValue → use provider default (not an error)
    const n = maxKeysValue ? parseInt(maxKeysValue, 10) : providerDefault;
    const c = parseInt(concurrencyValue, 10);
    const p = parseInt(partSizeValue, 10);
    const f = parseInt(fileConcurrencyValue, 10);

    if (isNaN(n) || n <= 0 || n > 100000) { setError('Page size must be 1–100,000.'); return; }
    if (isNaN(c) || c < 1 || c > 16)      { setError('Upload part concurrency must be 1–16.'); return; }
    if (isNaN(p) || p < 5 || p > 512)     { setError('Part size must be 5–512 MB.'); return; }
    if (isNaN(f) || f < 1 || f > 8)       { setError('File concurrency must be 1–8.'); return; }

    saveMaxKeys(n);
    savePartConcurrency(c);
    savePartSizeMB(p);
    saveFileConcurrency(f);

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
    saveMaxKeys(providerDefault);
    savePartConcurrency(DEFAULT_PART_CONCURRENCY);
    savePartSizeMB(DEFAULT_PART_SIZE_MB);
    saveFileConcurrency(DEFAULT_FILE_CONCURRENCY);
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
          <label>Page size (MaxKeys)</label>
          <input
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
          <label>Upload part size (MiB)</label>
          <input
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
          <label>Upload part concurrency</label>
          <input
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
          <label>File concurrency</label>
          <input
            type="number"
            value={fileConcurrencyValue}
            onInput={e => setFileConcurrencyValue(e.target.value)}
            min="1"
            max="8"
          />
          <span class="hint">Simultaneous file uploads (1–8). Default: {DEFAULT_FILE_CONCURRENCY}. Higher values improve throughput for many small files; lower values reduce load on constrained backends.</span>
          <span class="hint" style={{ color: 'var(--accent)' }}>
            Active: <strong>{activeFileConcurrency}</strong>
          </span>
        </div>
        {error && <span style={{ fontSize: '.8rem', color: 'var(--text-danger)' }}>{error}</span>}
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          <button type="submit" class="btn btn-ghost btn-sm">Save</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={handleReset}>Reset to defaults</button>
          {saved && <span style={{ fontSize: '.8rem', color: 'var(--text-success)' }}>Saved</span>}
        </div>
      </form>
    </div>
  );
}
