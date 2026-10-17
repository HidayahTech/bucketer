// Copyright (C) 2026 HidayahTech, LLC
// Labels for remembered buckets (accounts A, v1.66.0).

// The endpoint's host (and port) — what the user recognises and what a crafted link would change
// (REPORT C6, S4). Falls back to the raw value so a malformed endpoint is still shown, not hidden.
export function endpointHost(endpoint) {
  const raw = (endpoint || '').trim();
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw;
  }
}

const DAY = 86400000;
const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const pad = (n) => String(n).padStart(2, '0');

// "Last used …" by calendar day in local time. Records saved before v1.66.0 carry no time.
export function lastUsedLabel(ts, now = Date.now()) {
  if (!ts) return 'Saved before last-use tracking';
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) {
    const d = new Date(ts);
    return `Last used today ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (days === 1) return 'Last used yesterday';
  if (days < 14) return `Last used ${days} days ago`;
  if (days < 60) return `Last used ${Math.floor(days / 7)} weeks ago`;
  return `Last used ${Math.floor(days / 30)} months ago`;
}
