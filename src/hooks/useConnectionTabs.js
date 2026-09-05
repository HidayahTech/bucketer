// Copyright (C) 2026 HidayahTech, LLC
// Tracks a most-recently-used order of connections for the header quick-switch strip.
// The MRU is seeded and reordered whenever the selected connection changes, and
// projected onto the live connections (dropping any that were deleted), capped.
import { useState, useEffect } from 'preact/hooks';
import { touchMru, deriveTabs } from '../lib/connection-tabs.js';

const TAB_CAP = 6;

export function useConnectionTabs(connections, selectedId) {
  const [mru, setMru] = useState([]);
  useEffect(() => {
    if (selectedId == null) return;
    setMru(prev => touchMru(prev, selectedId));
  }, [selectedId]);
  return deriveTabs(mru, connections, TAB_CAP);
}
