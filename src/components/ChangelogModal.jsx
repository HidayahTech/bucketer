import { useEffect } from 'preact/hooks';
import { CHANGELOG, CURRENT_VERSION } from '../lib/changelog.js';

export function ChangelogModal({ onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal-dialog changelog-dialog" onClick={e => e.stopPropagation()}>
        <div class="modal-title">What's new in Bucketer</div>
        <div class="changelog-body">
          {CHANGELOG.map(entry => (
            <div key={entry.version} class="changelog-entry">
              <div class="changelog-version-row">
                <span class="changelog-version-num">v{entry.version}</span>
                <span class="changelog-version-date">{entry.date}</span>
                {entry.version === CURRENT_VERSION && (
                  <span class="changelog-current-badge">current</span>
                )}
              </div>
              {entry.title && <div class="changelog-entry-title">{entry.title}</div>}
              <ul class="changelog-changes">
                {entry.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
