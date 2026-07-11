// Copyright (C) 2026 HidayahTech, LLC
// Pure per-engine context-option adjustments (no playwright import so it unit-tests fast).
// Playwright supports `isMobile` only in Chromium/WebKit — a Firefox context with isMobile
// throws — so it is dropped for firefox (the mobile viewport/touch/UA still apply).
export function applyEngineQuirks(engineName, profile, extra = {}) {
  const p = profile ? { ...profile } : {};
  if (engineName === 'firefox' && 'isMobile' in p) delete p.isMobile;
  return { ...p, ...extra };
}
