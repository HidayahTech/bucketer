// Copyright (C) 2026 HidayahTech, LLC
// Pure per-engine context-option adjustments (no playwright import so it unit-tests fast).
// Playwright supports `isMobile` only in Chromium/WebKit — a Firefox context with isMobile
// throws — so it is dropped for firefox (the mobile viewport/touch/UA still apply).
export function applyEngineQuirks(engineName, profile, extra = {}) {
  const p = profile ? { ...profile } : {};
  if (engineName === 'firefox' && 'isMobile' in p) delete p.isMobile;
  return { ...p, ...extra };
}

// Per-engine skip decision for e2eTest's { skipOn } option: returns the documented
// reason string when the running engine is listed, else null (run the test).
// Skips must carry a reason — an entry that maps to a falsy/non-string value is a
// spec-file mistake and throws rather than silently running or silently skipping.
export function skipReasonFor(engineName, skipOn) {
  if (!skipOn || !(engineName in skipOn)) return null;
  const reason = skipOn[engineName];
  if (typeof reason !== 'string' || !reason) throw new Error(`skipOn.${engineName} must be a non-empty reason string`);
  return reason;
}
