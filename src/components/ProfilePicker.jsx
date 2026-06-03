// Copyright (C) 2026 HidayahTech, LLC
import { useState } from 'preact/hooks';

export function ProfilePicker({ profiles, selectedId, onSelect, onDelete, onSave, currentFormData }) {
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');

  if (profiles.length === 0 && !saving) {
    return (
      <div class="profile-picker profile-picker-empty">
        <button class="btn btn-ghost btn-sm profile-save-trigger"
          onClick={() => { setSaveName(defaultName(currentFormData)); setSaving(true); }}>
          Save as profile…
        </button>
      </div>
    );
  }

  function handleConfirmSave(e) {
    e.preventDefault();
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaving(false);
    setSaveName('');
  }

  function handleCancelSave() {
    setSaving(false);
    setSaveName('');
  }

  return (
    <div class="profile-picker">
      {profiles.length > 0 && (
        <>
          <div class="profile-picker-heading">Saved profiles</div>
          <ul class="profile-list">
            {profiles.map(p => (
              <li key={p.id}
                class={'profile-row' + (p.id === selectedId ? ' profile-row-selected' : '')}
                onClick={() => onSelect(p.id)}>
                <span class="profile-row-name">{p.name}</span>
                <span class="profile-row-hint">{profileHint(p)}</span>
                <button class="profile-row-delete btn-ghost"
                  title="Delete profile"
                  onClick={e => { e.stopPropagation(); onDelete(p.id); }}>✕</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {saving ? (
        <form class="profile-save-form" onSubmit={handleConfirmSave}>
          <input
            class="input"
            type="text"
            placeholder="Profile name"
            value={saveName}
            onInput={e => setSaveName(e.target.value)}
            autoFocus
          />
          <button class="btn btn-primary btn-sm" type="submit" disabled={!saveName.trim()}>Save</button>
          <button class="btn btn-ghost btn-sm" type="button" onClick={handleCancelSave}>Cancel</button>
        </form>
      ) : (
        <button class="btn btn-ghost btn-sm profile-save-trigger"
          onClick={() => { setSaveName(defaultName(currentFormData)); setSaving(true); }}>
          Save current as profile…
        </button>
      )}
    </div>
  );
}

function profileHint(profile) {
  const parts = [];
  if (profile.provider) parts.push(profile.provider.toUpperCase());
  if (profile.bucket) parts.push(profile.bucket);
  return parts.join(' · ');
}

function defaultName(formData) {
  if (!formData) return '';
  const { provider, bucket } = formData;
  if (provider && bucket) return `${provider.toUpperCase()} — ${bucket}`;
  if (bucket) return bucket;
  return '';
}
