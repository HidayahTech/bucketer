// Application settings (page size, etc.) (§4.7)
import { useState } from 'preact/hooks';
import { loadMaxKeys, saveMaxKeys } from '../lib/storage.js';
import { defaultMaxKeys } from '../lib/provider.js';

export function SettingsPanel({ provider }) {
  const providerDefault = defaultMaxKeys(provider);
  const stored = loadMaxKeys();
  const [value, setValue] = useState(stored ? String(stored) : '');
  const [saved, setSaved] = useState(false);

  function handleSave(e) {
    e.preventDefault();
    const n = parseInt(value, 10);
    if (n > 0 && n <= 100000) {
      saveMaxKeys(n);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  function handleReset() {
    setValue('');
    saveMaxKeys(providerDefault);
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
            value={value}
            onInput={e => setValue(e.target.value)}
            placeholder={`Default: ${providerDefault}`}
            min="1"
            max="100000"
          />
          <span class="hint">Objects per listing page. Provider default: {providerDefault}.</span>
        </div>
        <div style={{ display: 'flex', gap: '.4rem' }}>
          <button type="submit" class="btn btn-ghost btn-sm">Save</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={handleReset}>Reset to default</button>
          {saved && <span style={{ fontSize: '.8rem', color: 'var(--text-success)', alignSelf: 'center' }}>Saved</span>}
        </div>
      </form>
    </div>
  );
}
