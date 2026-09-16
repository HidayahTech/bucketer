// Copyright (C) 2026 HidayahTech, LLC
// Base-prefix (connection floor) primitives for prefix-scoped access keys (#60).
//
// A connection's optional basePrefix ("Base folder" in the UI) is the floor of
// everything this session may touch: the initial listing starts there and no
// navigation or request target may fall outside it. Enforcement here is
// client-side discipline mirroring the server-side key restriction (B2
// namePrefix, IAM s3:prefix condition) — the server remains the authority.
//
// Contract shared with every prefix in this codebase (see move-guards.js):
// '' means unscoped/root; every non-empty prefix ends in '/'.

// Canonicalize user input into the prefix contract. Pure normalization —
// validation (rejecting '..' etc.) lives in credential-validation.js.
export function normalizeBasePrefix(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const collapsed = trimmed.replace(/\/+/g, '/').replace(/^\//, '');
  if (!collapsed) return '';
  return collapsed.endsWith('/') ? collapsed : collapsed + '/';
}

// True when `prefix` is the floor itself or a descendant of it. An empty floor
// admits everything — this identity keeps unscoped connections byte-for-byte
// on today's behavior.
export function withinFloor(prefix, floor) {
  return !floor || (prefix || '').startsWith(floor);
}

// The single enforcement primitive: any prefix arriving from outside a
// guaranteed-descendant source (URL hash, history state, breadcrumb) routes
// through here before becoming navigation state.
export function clampToFloor(prefix, floor) {
  return withinFloor(prefix, floor) ? prefix || '' : floor;
}

// Navigation prefix intake (#68): the one validated read for a prefix that arrives from
// outside the app's own writes — the URL hash of a share link, or history state. Applies
// the same rule as the Base folder field (cap 1024, no backslash, no '..' segment) and
// normalizes to the prefix contract (non-empty ⇒ ends in '/'), so a slash-less
// `#prefix=clients/acme` lists the folder `clients/acme/` rather than every key that
// merely starts with `clients/acme` — and so "New folder" under it never composes a
// sibling key. Anything invalid becomes '' (the floor, once clamped).
export function sanitizeNavPrefix(raw) {
  const v = typeof raw === 'string' ? raw : '';
  if (!v || v.length > 1024 || v.includes('\\') || v.split('/').some((s) => s === '..')) return '';
  return normalizeBasePrefix(v);
}

// A floor "discovered" on the failed-connect screen (#67): the saved record has no floor
// and the live connection just listed successfully at one. Returns the floor to persist,
// or null. Never overrides a stored floor — editing an existing floor is the explicit
// Save flow's job, where the floor is part of a connection's identity.
// linkFloor: the base folder the current share link supplied, if any — a floor that came
// from a link was not typed by the user and is never persisted this way.
export function discoveredFloor(recordFloor, liveFloor, linkFloor = '') {
  const live = normalizeBasePrefix(liveFloor);
  if (!live || normalizeBasePrefix(recordFloor)) return null;
  return live === normalizeBasePrefix(linkFloor) ? null : live;
}
