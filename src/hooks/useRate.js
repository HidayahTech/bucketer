// Copyright (C) 2026 HidayahTech, LLC
// Sample a cumulative-byte value on an interval into a rate tracker and expose bytes/second.
// Only the SPEED needs periodic sampling — the displayed byte count comes straight from the
// reactive value. An interval (not rAF) because we sample a rate, not a smooth counter;
// background-tab timer throttling only sparsens samples, which the window rate tolerates.
import { useState, useEffect, useRef } from 'preact/hooks';
import { createRateTracker } from '../lib/rate-tracker.js';

export function useRate(bytes, active, { now = () => Date.now(), intervalMs = 250 } = {}) {
  const [speed, setSpeed] = useState(null);
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;
  useEffect(() => {
    if (!active) { setSpeed(null); return undefined; }
    const tracker = createRateTracker();
    const tick = () => { const t = now(); tracker.sample(t, bytesRef.current); setSpeed(tracker.rate(t)); };
    tick();
    const h = setInterval(tick, intervalMs);
    return () => clearInterval(h);
  }, [active]);
  return speed;
}
