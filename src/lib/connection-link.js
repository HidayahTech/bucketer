// Copyright (C) 2026 HidayahTech, LLC
// Connection links that open Bucketer in a folder (#69).
//
// One link family, two surfaces: the header "Copy link" menu (ShareLinkMenu) and the
// breadcrumb's copy-link button (Browser). Both build the SAME link — the connection share
// link of url-params.js plus the current folder — from live state via buildShareUrl, never
// from the address bar (which carries the opt-in keyId across navigation and would leak it
// silently). The recipient authenticates with their own key; this is not the presigned
// per-file link of share-url.js, which IS access and never carries a folder.
//
// The key-ID modifier ("Include my access key ID") is one choice for the session, shared by
// both surfaces, held in sessionStorage so it survives a reload but never a tab close.
import { buildShareUrl } from './url-params.js';
import { normalizeBasePrefix } from './base-prefix.js';
import { showToast } from './toast.js';

const INCLUDE_KEY_ID_KEY = 's3b_share_include_keyid';

export function getIncludeKeyId() {
  try {
    return sessionStorage.getItem(INCLUDE_KEY_ID_KEY) === '1';
  } catch {
    return false;
  }
}

export function setIncludeKeyId(on) {
  try {
    if (on) sessionStorage.setItem(INCLUDE_KEY_ID_KEY, '1');
    else sessionStorage.removeItem(INCLUDE_KEY_ID_KEY);
  } catch {
    /* storage unavailable — the choice just doesn't persist */
  }
}

// The folder as the sender sees it: relative to the floor, left-truncated beyond `max`
// characters so the menu label stays one line ("…/acme/sub/"). Full value belongs in title.
export function relativeFolderLabel(prefix, floor = '', max = 28) {
  const p = normalizeBasePrefix(prefix);
  const f = normalizeBasePrefix(floor);
  const rel = f && p.startsWith(f) ? p.slice(f.length) : p;
  if (rel.length <= max) return rel;
  const cut = rel.slice(rel.length - max);
  const slash = cut.indexOf('/');
  return '…' + (slash >= 0 ? cut.slice(slash) : '/' + cut);
}

// True when the current folder is somewhere a folder link would actually change: not the
// root, not the floor.
export function isLinkableFolder(prefix, floor = '') {
  const p = normalizeBasePrefix(prefix);
  return !!p && p !== normalizeBasePrefix(floor);
}

// Toast copy names what travelled — it is how the sender verifies without opening the link.
export function linkCopiedMessage({ prefix = '', floor = '', bucket = '', includeKeyId = false }) {
  const folder = isLinkableFolder(prefix, floor) ? normalizeBasePrefix(prefix) : '';
  const head = folder
    ? `Link copied — opens at ${folder}`
    : `Link copied — opens at the top of ${normalizeBasePrefix(floor) || bucket || 'the bucket'}`;
  return includeKeyId ? `${head}\nIncludes your access key ID. The recipient still needs the secret key.` : head;
}

// Build, copy, toast. Returns the URL, or null when no link can be built (file://).
// Clipboard failures are swallowed like every other copy action in the app.
export async function copyConnectionLink({ credentials, prefix = '', includeKeyId = false }) {
  const url = buildShareUrl(credentials, { includeKeyId, prefix });
  if (!url) return null;
  try {
    await navigator.clipboard.writeText(url);
    showToast(linkCopiedMessage({ prefix, floor: credentials.basePrefix, bucket: credentials.bucket, includeKeyId }));
  } catch {
    /* clipboard API unavailable */
  }
  return url;
}
