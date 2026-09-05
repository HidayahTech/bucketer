// Copyright (C) 2026 HidayahTech, LLC
// Header quick-switch strip: recently-used buckets, most-recent first, active pinned.
// A convenience projection over the accounts tree (the manager stays the source of
// truth) — clicking a tab drives the same switchToConnection motion as the sidebar.
import { PROVIDER_LABELS } from '../lib/provider.js';

function tabLabel({ provider, bucket }) {
  const p = provider ? (PROVIDER_LABELS[provider] || provider.toUpperCase()) : null;
  return p ? `${p} · ${bucket}` : bucket;
}

export function ConnectionTabs({ tabs, selectedId, onSelect }) {
  if (!tabs.length) return null;
  return (
    <div class="connection-tabs" role="tablist" aria-label="Recent buckets">
      {tabs.map(t => (
        <button key={t.id} type="button"
          role="tab"
          aria-selected={t.id === selectedId}
          class={'connection-tab' + (t.id === selectedId ? ' connection-tab-active' : '')}
          title={tabLabel(t)}
          onClick={() => onSelect(t.id)}>
          {tabLabel(t)}
        </button>
      ))}
    </div>
  );
}
