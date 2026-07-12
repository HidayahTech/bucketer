// Copyright (C) 2026 HidayahTech, LLC
// Pure helpers for the e2e matrix runner and the container wrapper (no side effects,
// no imports — unit-tested in test/e2e-matrix-helpers.test.js).

// Split a comma-separated env value into trimmed non-empty entries; null/'' → defaults.
export function parseListEnv(value, defaults) {
  if (!value) return defaults;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : defaults;
}

export const DEFAULT_ENGINES = ['chromium', 'firefox', 'webkit'];
// '' = desktop (no E2E_DEVICE); the names must be playwright.devices keys.
export const DEFAULT_DEVICES = ['', 'Pixel 5', 'iPhone 13'];

// Device lists accept the literal "desktop" for the empty (no-profile) entry, since a
// comma-separated env var cannot carry an empty string ("," entries are dropped).
export function parseDeviceListEnv(value, defaults = DEFAULT_DEVICES) {
  return parseListEnv(value, defaults).map((d) => (d.toLowerCase() === 'desktop' ? '' : d));
}

// Expand engines × devices into [{engine, device}] in engine-major order,
// mirroring the CI parallel:matrix layout.
export function buildCombos(engines, devices) {
  return engines.flatMap((engine) => devices.map((device) => ({ engine, device })));
}

export function comboLabel({ engine, device }) {
  return `${engine} × ${device || 'desktop'}`;
}

// Derive the Playwright container image from the LOCKED playwright version, so the
// container's browsers always match the suite. Fail loud on anything unparseable —
// a wrong image silently skews every result.
export function imageTagFromLock(lockJson) {
  const version = lockJson?.packages?.['node_modules/playwright']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`Cannot derive Playwright image: package-lock.json has no exact version for node_modules/playwright (got ${JSON.stringify(version)})`);
  }
  return `mcr.microsoft.com/playwright:v${version}-jammy`;
}

// Pick the first available container runtime, podman preferred (rootless Fedora default).
export function pickRuntime(available) {
  for (const candidate of ['podman', 'docker']) {
    if (available.includes(candidate)) return candidate;
  }
  return null;
}
