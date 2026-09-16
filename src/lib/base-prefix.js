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

// A floor "discovered" on the failed-connect screen (#67): the saved record has no floor
// and the live connection just listed successfully at one. Returns the floor to persist,
// or null. Never overrides a stored floor — editing an existing floor is the explicit
// Save flow's job, where the floor is part of a connection's identity.
export function discoveredFloor(recordFloor, liveFloor) {
  const live = normalizeBasePrefix(liveFloor);
  return !normalizeBasePrefix(recordFloor) && live ? live : null;
}
