// Copyright (C) 2026 HidayahTech, LLC
import { useState, useRef, useEffect } from 'preact/hooks';
import { buildShareUrl } from '../lib/url-params.js';
import {
  copyConnectionLink,
  getIncludeKeyId,
  setIncludeKeyId,
  isLinkableFolder,
  relativeFolderLabel,
} from '../lib/connection-link.js';
import { normalizeBasePrefix } from '../lib/base-prefix.js';

// Header "Copy link" menu — links that open Bucketer on this connection (#69). The
// recipient brings their own key; the secret is never included, the key ID only on request.
//   • Open in Bucketer — this folder (…/acme/sub/)   — first, only when not at the floor
//   • Open in Bucketer — top of this bucket          — (top of this connection when floored)
//   ☐ Include my access key ID                        — a modifier of either item, one
//     choice per session shared with the breadcrumb's copy-link button
// Labelled choice, defaulted by position: a link copied deep inside a private subfolder
// must not carry the path silently, and naming the folder in the label makes the payload
// visible before the click. Both items build from live state, never the address bar.
export function ShareLinkMenu({ credentials, prefix = '' }) {
  const [open, setOpen] = useState(false);
  const [includeKeyId, setInclude] = useState(getIncludeKeyId);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const floor = normalizeBasePrefix(credentials.basePrefix);
  const hasFolder = isLinkableFolder(prefix, floor);
  const withKeyId = includeKeyId && !!credentials.keyId;

  async function copy(folder) {
    await copyConnectionLink({ credentials, prefix: folder, includeKeyId: withKeyId });
    setOpen(false);
  }

  function toggleKeyId(e) {
    setInclude(e.target.checked);
    setIncludeKeyId(e.target.checked);
  }

  return (
    <div class="copy-link-wrap" ref={open ? wrapRef : undefined}>
      <button
        class="btn btn-ghost btn-sm"
        style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
        onClick={() => setOpen((v) => !v)}
        title="Copy a link that opens Bucketer on this connection"
      >
        Copy link
      </button>
      {open && (
        <div class="copy-link-popover share-link-menu">
          {hasFolder && (
            <button
              class="btn btn-ghost btn-sm"
              onClick={() => copy(prefix)}
              title={`Opens at ${normalizeBasePrefix(prefix)}`}
              data-testid="share-link-folder"
            >
              Open in Bucketer — this folder ({relativeFolderLabel(prefix, floor)})
            </button>
          )}
          <button class="btn btn-ghost btn-sm" onClick={() => copy('')} data-testid="share-link-top">
            Open in Bucketer — top of this {floor ? 'connection' : 'bucket'}
          </button>
          <label
            class="share-link-modifier"
            title={credentials.keyId ? undefined : 'No access key ID on this connection'}
          >
            <input type="checkbox" checked={withKeyId} disabled={!credentials.keyId} onChange={toggleKeyId} />
            Include my access key ID
          </label>
          <div class="copy-link-note">The recipient needs their own secret key. It is never included.</div>
          {!buildShareUrl(credentials) && <div class="copy-link-note">Links cannot be built from a file:// page.</div>}
        </div>
      )}
    </div>
  );
}
