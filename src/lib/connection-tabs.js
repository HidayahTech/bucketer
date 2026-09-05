// Copyright (C) 2026 HidayahTech, LLC
// Pure logic for the header quick-switch tab-strip: a most-recently-used order of
// connection ids, projected onto the current connections.

// Move `id` to the front of the MRU list, removing any earlier occurrence so it never
// duplicates. Returns a new array; the input is not mutated.
export function touchMru(mru, id) {
  return [id, ...mru.filter(x => x !== id)];
}

// Project the MRU id order onto the current connections: resolve each id to its
// connection (dropping ids that no longer exist), preserving MRU order, capped at `cap`.
export function deriveTabs(mru, connections, cap) {
  const byId = new Map(connections.map(c => [c.id, c]));
  const tabs = [];
  for (const id of mru) {
    const c = byId.get(id);
    if (c) tabs.push(c);
    if (tabs.length >= cap) break;
  }
  return tabs;
}
