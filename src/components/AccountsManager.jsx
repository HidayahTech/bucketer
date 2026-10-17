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
import { Icon } from './Icon.jsx';
import { byMostRecent } from '../lib/connections.js';
import { endpointHost, lastUsedLabel } from '../lib/saved-bucket-labels.js';

const KEY_TAIL = 4;

// A stable, human label for an account (credential). Provider name plus the tail of
// the key id — the tail disambiguates two accounts on the same provider without
// echoing the whole key-adjacent string. Never shows the secret (there is none here).
function accountLabel({ provider, keyId }) {
  const label = provider ? PROVIDER_LABELS[provider] || provider.toUpperCase() : 'S3';
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

// variant="splash" (accounts A, v1.66.0) is "Your buckets": every remembered bucket, most recent
// first (accounts ordered by their most recent bucket), each naming its storage address and last
// use, with a note on what is kept and Forget all. The sidebar keeps the compact tree.
export function AccountsManager({
  connections,
  selectedId,
  onSelect,
  onDelete,
  onSave,
  onAddBucket,
  onForgetAll,
  currentFormData,
  variant,
}) {
  const splash = variant === 'splash';
  const groups = groupByAccount(splash ? byMostRecent(connections) : connections);
  const [confirmForgetAll, setConfirmForgetAll] = useState(false);
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
    return g.conns.some((c) => c.id === selectedId);
  };
  const toggle = (g) => setOverrides((prev) => ({ ...prev, [g.credentialId]: !isExpanded(g) }));

  const saveable = canSaveProfile(currentFormData);
  const saveTitle = saveable ? undefined : 'Fill in endpoint, bucket, and key ID with valid values to save a bucket';
  const selectedConn = selectedId != null ? connections.find((c) => c.id === selectedId) : null;
  const initialSaveName = () => (selectedConn ? selectedConn.name : defaultName(currentFormData));

  function openSave() {
    setSaveName(initialSaveName());
    setSaving(true);
  }
  function handleConfirmSave(e) {
    e.preventDefault();
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaving(false);
    setSaveName('');
  }
  function cancelSave() {
    setSaving(false);
    setSaveName('');
  }

  return (
    <div class={splash ? 'accounts-manager accounts-manager-splash' : 'accounts-manager'}>
      {splash && connections.length > 0 && (
        <div class="your-buckets-head">
          <h3 class="your-buckets-title">Your buckets</h3>
          <span class="your-buckets-sub">{connections.length} on this device · most recent first</span>
        </div>
      )}
      {groups.map((g) => {
        const expanded = isExpanded(g);
        return (
          <div class="account-group" key={g.credentialId}>
            <div class="account-header" onClick={() => toggle(g)}>
              {/* Button for keyboard access and expanded state; its click bubbles to the header's onClick. */}
              <button type="button" class="link-btn account-toggle" aria-expanded={expanded ? 'true' : 'false'}>
                <span class="account-disclosure" aria-hidden="true">
                  {expanded ? '▾' : '▸'}
                </span>
                <span class="account-name">{accountLabel(g.conns[0])}</span>
                {splash && <span class="account-host">{endpointHost(g.conns[0].endpoint)}</span>}
              </button>
              <button
                class="account-add-bucket btn-ghost"
                type="button"
                title="Add a bucket to this account — you only enter the bucket name"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddBucket(g.credentialId);
                }}
              >
                + bucket
              </button>
            </div>
            {expanded && (
              <ul class="bucket-list">
                {g.conns.map((c) => (
                  <li
                    key={c.id}
                    class={'bucket-row' + (c.id === selectedId ? ' bucket-row-selected' : '')}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      onSelect(c.id);
                    }}
                  >
                    {/* Button for keyboard access (K1); its click bubbles to the row's onClick. */}
                    <button
                      type="button"
                      class="link-btn bucket-name"
                      aria-current={c.id === selectedId ? 'true' : undefined}
                    >
                      {c.bucket}
                    </button>
                    {splash && (
                      <span class="bucket-meta">
                        {endpointHost(c.endpoint)}
                        {c.basePrefix ? ` · ${c.basePrefix}` : ''} · {lastUsedLabel(c.lastUsedAt)}
                      </span>
                    )}
                    {confirmDeleteId === c.id ? (
                      <span class="bucket-delete-confirm" onClick={(e) => e.stopPropagation()}>
                        {splash ? 'Forget? Your files are not touched.' : 'Delete?'}
                        <button
                          class="btn btn-sm bucket-delete-confirm-yes"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(c.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Confirm
                        </button>
                        <button
                          class="btn btn-ghost btn-sm"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        class="bucket-row-delete btn-ghost"
                        type="button"
                        title="Forget this bucket"
                        aria-label={`Forget ${c.bucket}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(c.id);
                        }}
                      >
                        {splash ? 'Forget' : <Icon name="x" />}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {splash && connections.length > 0 && (
        <div class="your-buckets-foot">
          <p class="hint">
            Saved on this device only: storage address, bucket, key ID and folder. Never the secret. Bucketer remembers
            each bucket you connect to; Sign out keeps this list.
          </p>
          {confirmForgetAll ? (
            <span class="forget-all-confirm-row">
              Forget all {connections.length} on this device?
              <button
                type="button"
                class="btn btn-sm btn-danger forget-all-confirm"
                onClick={() => {
                  setConfirmForgetAll(false);
                  onForgetAll?.();
                }}
              >
                Forget all
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmForgetAll(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              class="btn btn-ghost btn-sm forget-all-trigger"
              onClick={() => setConfirmForgetAll(true)}
            >
              Forget all on this device
            </button>
          )}
        </div>
      )}
      {saving ? (
        <form class="bucket-save-form" onSubmit={handleConfirmSave}>
          <input
            class="input"
            type="text"
            placeholder="Name"
            value={saveName}
            onInput={(e) => setSaveName(e.target.value)}
            autoFocus
          />
          <button class="btn btn-primary btn-sm" type="submit" disabled={!saveName.trim()}>
            Save
          </button>
          <button class="btn btn-ghost btn-sm" type="button" onClick={cancelSave}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          class="btn btn-ghost btn-sm bucket-save-trigger"
          disabled={!saveable}
          title={saveTitle}
          onClick={openSave}
        >
          {selectedConn ? 'Update this bucket…' : 'Save current as a bucket…'}
        </button>
      )}
    </div>
  );
}
