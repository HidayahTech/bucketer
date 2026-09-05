// Copyright (C) 2026 HidayahTech, LLC
// AccountsManager — the account → buckets tree that replaces the flat ProfilePicker.
//
// Connections sharing a credentialId are one ACCOUNT (the credential = endpoint +
// key + provider + region). Each connection under it is a BUCKET. The grouping is a
// pure projection over listResolvedConnections() — no new storage (connections.js
// has carried credentialId since v1.39.0).
//
// Props are deliberately the same shape ProfilePicker exposed (connections/selectedId/
// onSelect/onDelete/onSave/currentFormData), so App's splash wiring is unchanged.
import { useState } from 'preact/hooks';
import { PROVIDER_LABELS, detectProvider } from '../lib/provider.js';
import { canSaveProfile } from '../lib/credential-validation.js';

const KEY_TAIL = 4;

// A stable, human label for an account (credential). Provider name plus the tail of
// the key id — the tail disambiguates two accounts on the same provider without
// echoing the whole key-adjacent string. Never shows the secret (there is none here).
function accountLabel({ provider, keyId }) {
  const label = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : 'S3';
  const id = keyId || '';
  const tail = id.length > KEY_TAIL ? `…${id.slice(-KEY_TAIL)}` : id;
  return tail ? `${label} · key ${tail}` : label;
}

// Groups resolved connections by credentialId, preserving first-seen order for both
// accounts and the buckets within each.
function groupByAccount(connections) {
  const groups = [];
  const byCred = new Map();
  for (const c of connections) {
    let g = byCred.get(c.credentialId);
    if (!g) {
      g = { credentialId: c.credentialId, conns: [] };
      byCred.set(c.credentialId, g);
      groups.push(g);
    }
    g.conns.push(c);
  }
  return groups;
}

function defaultName(formData) {
  if (!formData) return '';
  const { providerOverride, provider, endpoint, bucket } = formData;
  const prov = providerOverride || provider || (endpoint ? detectProvider(endpoint) : null);
  if (prov && bucket) return `${prov.toUpperCase()} — ${bucket}`;
  return bucket || '';
}

export function AccountsManager({ connections, selectedId, onSelect, onDelete, onSave, onAddBucket, currentFormData }) {
  const groups = groupByAccount(connections);
  // Explicit per-account expand/collapse overrides. Default (no override) expands an
  // account when nothing is selected or when it holds the active bucket, and collapses
  // the rest — so a returning user lands with only their active account open.
  const [overrides, setOverrides] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');

  const isExpanded = (g) => {
    if (g.credentialId in overrides) return overrides[g.credentialId];
    if (selectedId == null) return true;
    return g.conns.some(c => c.id === selectedId);
  };
  const toggle = (g) =>
    setOverrides(prev => ({ ...prev, [g.credentialId]: !isExpanded(g) }));

  const saveable = canSaveProfile(currentFormData);
  const saveTitle = saveable ? undefined : 'Fill in endpoint, bucket, and key ID with valid values to save a bucket';
  const selectedConn = selectedId != null ? connections.find(c => c.id === selectedId) : null;
  const initialSaveName = () => selectedConn ? selectedConn.name : defaultName(currentFormData);

  function openSave() { setSaveName(initialSaveName()); setSaving(true); }
  function handleConfirmSave(e) {
    e.preventDefault();
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaving(false);
    setSaveName('');
  }
  function cancelSave() { setSaving(false); setSaveName(''); }

  return (
    <div class="accounts-manager">
      {groups.map(g => {
        const expanded = isExpanded(g);
        return (
          <div class="account-group" key={g.credentialId}>
            <div class="account-header" onClick={() => toggle(g)}>
              <span class="account-disclosure" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              <span class="account-name">{accountLabel(g.conns[0])}</span>
              <button class="account-add-bucket btn-ghost" type="button"
                title="Add a bucket to this account — you only enter the bucket name"
                onClick={e => { e.stopPropagation(); onAddBucket(g.credentialId); }}>+ bucket</button>
            </div>
            {expanded && (
              <ul class="bucket-list">
                {g.conns.map(c => (
                  <li key={c.id}
                    class={'bucket-row' + (c.id === selectedId ? ' bucket-row-selected' : '')}
                    onClick={() => { setConfirmDeleteId(null); onSelect(c.id); }}>
                    <span class="bucket-name">{c.bucket}</span>
                    {confirmDeleteId === c.id ? (
                      <span class="bucket-delete-confirm" onClick={e => e.stopPropagation()}>
                        Delete?
                        <button class="btn btn-sm bucket-delete-confirm-yes" type="button"
                          onClick={e => { e.stopPropagation(); onDelete(c.id); setConfirmDeleteId(null); }}>
                          Confirm
                        </button>
                        <button class="btn btn-ghost btn-sm" type="button"
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); }}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button class="bucket-row-delete btn-ghost" title="Forget this bucket"
                        onClick={e => { e.stopPropagation(); setConfirmDeleteId(c.id); }}>✕</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {saving ? (
        <form class="bucket-save-form" onSubmit={handleConfirmSave}>
          <input class="input" type="text" placeholder="Name" value={saveName}
            onInput={e => setSaveName(e.target.value)} autoFocus />
          <button class="btn btn-primary btn-sm" type="submit" disabled={!saveName.trim()}>Save</button>
          <button class="btn btn-ghost btn-sm" type="button" onClick={cancelSave}>Cancel</button>
        </form>
      ) : (
        <button class="btn btn-ghost btn-sm bucket-save-trigger"
          disabled={!saveable} title={saveTitle} onClick={openSave}>
          {selectedConn ? 'Update this bucket…' : 'Save current as a bucket…'}
        </button>
      )}
    </div>
  );
}
