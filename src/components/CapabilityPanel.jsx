// Capability state display (§4.12)

const OPS = [
  { key: 'list',     label: 'Browse / List' },
  { key: 'download', label: 'Download' },
  { key: 'upload',   label: 'Upload' },
  { key: 'delete',   label: 'Delete' },
];

function CapIcon({ state }) {
  if (state === 'permitted') return <span class="cap-permitted" title="Permitted">✓</span>;
  if (state === 'denied')    return <span class="cap-denied"    title="Denied">✕</span>;
  return <span class="cap-unknown" title="Not yet tested">?</span>;
}

export function CapabilityPanel({ capabilities, onRefresh }) {
  return (
    <div>
      <div class="section-heading">Permissions</div>
      <div class="cap-list">
        {OPS.map(op => (
          <div key={op.key} class="cap-item">
            <span class="cap-icon"><CapIcon state={capabilities[op.key]} /></span>
            <span class="cap-label">{op.label}</span>
            {capabilities[op.key] === 'denied' && (
              <span class="cap-denied" style={{ fontSize: '.75rem' }}>denied</span>
            )}
          </div>
        ))}
      </div>
      <button class="btn btn-ghost btn-sm" style={{ marginTop: '.5rem' }} onClick={onRefresh}>
        Refresh Permissions
      </button>
    </div>
  );
}
