// Copyright (C) 2026 HidayahTech, LLC
// One line naming where uploads and drops land (layout A, v1.67.0), in place of the always-open
// "Destination folder" form (REPORT W1). It follows the folder in view; "Change folder" opens the old
// free-typed field (any path, need not exist yet), and while a prefix-scoped key's floor is
// crossed the floor error shows here as before (#60).
import { useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';

export function UploadTarget({ bucket, destinationPrefix, onChange, outsideFloor = false, basePrefix = '' }) {
  const [editing, setEditing] = useState(false);
  const path = (destinationPrefix || '').split('/').filter(Boolean);
  return (
    <div class="upload-target" data-upload-target={destinationPrefix || ''}>
      <p class="upload-target-line">
        <Icon name="upload" />
        <span>
          Uploads and drops go to{' '}
          <strong>
            {[bucket, ...path].join(' / ')}
            {' /'}
          </strong>
        </span>
        <button
          type="button"
          class="link-btn upload-target-change"
          aria-expanded={editing ? 'true' : 'false'}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Done' : 'Change folder'}
        </button>
      </p>
      {editing && (
        <div class="form-group upload-target-edit">
          <label htmlFor="upload-destination">Upload to folder</label>
          <input
            id="upload-destination"
            type="text"
            value={destinationPrefix}
            onInput={(e) => onChange(e.target.value)}
            placeholder="(top of the bucket)"
          />
          <span class="hint">Any path; it doesn't need to exist yet. Opening a folder sets this again.</span>
        </div>
      )}
      {outsideFloor && (
        <span class="field-error">
          Destination must stay under {basePrefix} — this connection's key only reaches that folder.
        </span>
      )}
    </div>
  );
}
