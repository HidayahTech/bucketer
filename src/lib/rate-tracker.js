// Copyright (C) 2026 HidayahTech, LLC
// Sliding-window byte-rate tracker: from timestamped cumulative-byte samples, report the
// throughput over a recent window. Pure and clock-free (timestamps are inputs), so it is
// deterministically unit-testable. Modeled on the 6-second window inside BatchSummary.jsx.

export function createRateTracker({ windowMs = 6000, minSpanMs = 500 } = {}) {
  const samples = []; // { t, bytes } — cumulative bytes at time t (ms), oldest first
  return {
    sample(t, bytes) {
      samples.push({ t, bytes });
      const cutoff = t - windowMs;
      while (samples.length && samples[0].t < cutoff) samples.shift();
    },
    rate(t) {
      if (samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const span = last.t - first.t;
      if (span < minSpanMs) return null;
      const gained = last.bytes - first.bytes;
      return gained >= 0 ? gained / (span / 1000) : null;
    },
  };
}
