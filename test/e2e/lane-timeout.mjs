// Per-lane e2e timeout scaling. The cross-engine × device matrix runs the same specs on lanes
// with very different speeds: webkit is slower than chromium/firefox, and mobile device
// emulation (viewport + touch + a throttled-feeling render path) is slower still. Under shared
// CI-runner CPU contention the slow lanes intermittently blow deadlines that the fast lanes
// clear easily — a DIFFERENT timing-sensitive spec each run (sort re-render, move picker,
// batch state). Rather than raise every deadline for everyone (which would hide real hangs on
// fast lanes) or chase them one spec at a time, scale every e2e deadline by a single lane
// factor derived from the engine + device. Paired with CI job retry (.gitlab-ci.yml) for the
// residual transient stalls that more time cannot prevent.
//
// Kept in its own tiny module (no playwright import) so the pure factor logic is unit-tested
// under `npm test` without dragging the whole harness graph in. harness.mjs re-exports these.

// Empirical lane factors: webkit ×2, any mobile device profile ×1.5 (so webkit-mobile ×3,
// chromium/firefox desktop ×1). `device` is a playwright.devices key; the desktop lane is the
// empty string / unset (no profile) → factor 1.
export function laneTimeoutFactor(engine = process.env.E2E_ENGINE, device = process.env.E2E_DEVICE) {
  const engineFactor = engine === 'webkit' ? 2 : 1;
  const deviceFactor = device ? 1.5 : 1;
  return engineFactor * deviceFactor;
}

// Scale a base timeout (ms) by the current lane's factor. Pass explicit {engine, device} to
// compute for a specific lane (used by the tests); defaults read the E2E_ENGINE/E2E_DEVICE the
// matrix runner sets.
export function scaleTimeout(ms, { engine, device } = {}) {
  return Math.round(ms * laneTimeoutFactor(engine, device));
}
