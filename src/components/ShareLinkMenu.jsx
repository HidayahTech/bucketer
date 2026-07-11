// Copyright (C) 2026 HidayahTech, LLC
import { useState, useRef, useEffect } from 'preact/hooks';
import { buildShareUrl } from '../lib/url-params.js';
import { showToast } from '../lib/toast.js';

// Header "Copy link" menu. Two variants of the connection-share link:
//   • Connection only — endpoint/bucket/provider/region, no credentials (safe to
//     post publicly).
//   • Include access key ID — also embeds the key ID so a recipient only needs to
//     enter the secret key. The secret key is never included in either link.
export function ShareLinkMenu({ credentials }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function copy(url, message) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast(message);
    } catch { /* clipboard API unavailable */ }
    setOpen(false);
  }

  const copyConfigOnly = () =>
    copy(buildShareUrl(credentials), 'Share link copied to clipboard');
  const copyWithKeyId = () =>
    copy(buildShareUrl(credentials, { includeKeyId: true }),
         'Link with access key ID copied — recipient still needs the secret key');

  return (
    <div class="copy-link-wrap" ref={open ? wrapRef : undefined}>
      <button
        class="btn btn-ghost btn-sm"
        style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
        onClick={() => setOpen(v => !v)}
        title="Copy a shareable link with the connection pre-filled"
      >
        Copy link
      </button>
      {open && (
        <div class="copy-link-popover share-link-menu">
          <button class="btn btn-ghost btn-sm" onClick={copyConfigOnly}>
            Connection only (no credentials)
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick={copyWithKeyId}
            disabled={!credentials.keyId}
            title={credentials.keyId ? undefined : 'No access key ID on this connection'}
          >
            Include access key ID
          </button>
          <div class="copy-link-note">The secret key is never included in either link.</div>
        </div>
      )}
    </div>
  );
}
