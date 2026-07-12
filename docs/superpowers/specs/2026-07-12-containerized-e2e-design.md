# Containerized local e2e (#47) — design

Date: 2026-07-12. Prerequisite for getting WebKit fully green without skips
(local WebKit iteration loop) and permanently closes the "full matrix cannot
run on a stock Fedora host" gap.

## Problem

WebKit needs system libraries that `playwright install-deps` cannot install on
Fedora, so the cross-engine matrix (chromium/firefox/webkit × desktop/Pixel 5/
iPhone 13) only runs in CI. Every WebKit experiment is a push-to-CI round trip.

## Approach (chosen: stock Playwright image + thin wrapper)

Options considered: (a) stock `mcr.microsoft.com/playwright` image + wrapper,
(b) custom Containerfile baking `npm ci` into an image, (c) installing WebKit
deps on the host. Chosen: **(a)** — the official image ships all three engines
plus system deps and is exactly what CI runs, so local results match CI by
construction; (b) adds an image-rebuild lifecycle for no gain; (c) is
unsupported on Fedora and pollutes the host.

## Components

1. **`test/e2e/run-matrix.mjs`** (`npm run test:e2e:matrix`) — matrix runner,
   container-agnostic. Runs the mock-s3 + node layers once, then loops
   `E2E_ENGINES × E2E_DEVICES` (defaults `chromium,firefox,webkit` ×
   desktop + `Pixel 5` + `iPhone 13`), spawning the existing
   `run.mjs browser` per combo with `E2E_ENGINE`/`E2E_DEVICE` set. Per-combo
   pass/fail summary table at the end; exit non-zero if any combo failed.
   On the host, `E2E_ENGINES=chromium,firefox` restricts the loop (WebKit
   still cannot run there).

2. **`scripts/e2e-container.mjs`** (`npm run test:e2e:container`) — container
   wrapper. Detects `podman` first, else `docker` (fail with a clear message
   if neither). Derives the image tag from the **locked** playwright version
   in `package-lock.json` → `mcr.microsoft.com/playwright:v<ver>-jammy`, so
   the container always matches the suite. Runs:
   - repo bind-mounted at `/work` with `:Z` (SELinux relabel — standard
     rootless-Podman-on-Fedora practice),
   - a **named volume** (`bucketer-e2e-node_modules`) overlaid on
     `/work/node_modules` — the container gets its own jammy `npm ci`, never
     touching host `node_modules`; a lock-hash marker file in the volume
     skips reinstall when `package-lock.json` is unchanged,
   - `--ipc=host` (Playwright container guidance for Chromium),
   - `E2E_ENGINES`/`E2E_DEVICES`/`E2E_ENGINE`/`E2E_DEVICE`/`E2E_JUNIT`
     passed through, so single-combo containerized runs work too,
   - default command: `npm run test:e2e:matrix`.
   No ports published — mock S3, app server, and browsers all live inside
   the container.

3. **Pure helpers** in `test/e2e/matrix-helpers.mjs` (no side effects,
   unit-testable): combo expansion (engines × devices), image-tag derivation
   from lock JSON (fail-loud on missing/unparseable version), container
   runtime pick order.

## Testing

- Unit tests for the pure helpers (existing `e2e-harness-helpers` style).
- Acceptance: `npm run test:e2e:container` completes the full 9-combo matrix
  on this Fedora host with rootless Podman — including WebKit at
  38 tests / 35 pass / 3 skip parity with CI. First run pulls the ~2 GB image
  and does one in-container `npm ci`; subsequent runs skip both.

## Docs

README section (usage, Podman/Docker, SELinux note, first-run cost) and
CLAUDE.md test-suite entry. No `src/` changes; CI unchanged (keeps running
directly, per the issue). No version bump — tooling/tests only.
