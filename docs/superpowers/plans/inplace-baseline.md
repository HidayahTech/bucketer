# In-place composition — e2e baseline + fidelity gate

Image: `mcr.microsoft.com/playwright:v1.60.0-noble` (tag derived from locked playwright version).
Scope: `E2E_DEVICES=desktop` (chromium, firefox, webkit × desktop). Runtime: podman.

## Baseline (untouched tree + the fidelity probe), run bz70ep4yg — all green

| Lane | pass | fail |
|------|------|------|
| node layer | 53 | 0 |
| chromium × desktop | 55 | 0 |
| firefox × desktop | 55 | 0 |
| webkit × desktop | 53 | 0 |

A later red lane can be attributed against this. (Full 3×3 incl. mobile is run at release, Task 10.)

## Fidelity gate (design D6) — the decision

The probe (`test/e2e/browser/opfs-sync-fidelity.test.mjs`) spawns a Web Worker, opens one
exclusive `FileSystemSyncAccessHandle` on an OPFS file, writes three regions **out of order**
(C, then A, then B) leaving a gap, then reads the whole file back through the same handle and
asserts byte-exact content + correct length.

| Engine | Result |
|--------|--------|
| chromium | **PASS** — out-of-order positioned writes byte-faithful |
| firefox | **PASS** — out-of-order positioned writes byte-faithful |
| webkit | **UNSUPPORTED** — `navigator.storage.getDirectory` is undefined in the WebKit DedicatedWorker (no OPFS in worker) |

**Decision:** in-place composition ships on **chromium + firefox**; **webkit** stays on the
serial/handoff path. WebKit already does not render the ZIP button (its `zipGate` needs
`writableFiles`, which WebKit lacks), so in-place is moot there regardless. No engine regresses.

## Probe-caught design correction

The first probe run reported UNSUPPORTED on **all three** engines — because it feature-detected
`createSyncAccessHandle` on the **main thread**, where the method never exists (it is exposed
only in worker global scope). This would have made the originally-planned main-thread
capability check (`isFn(FileSystemFileHandle.prototype.createSyncAccessHandle)`) false
everywhere, so in-place would never have activated. Corrected: detect **inside the worker**;
selection is optimistic (`opfs && streamingFetch && webWorker`) with a runtime worker fallback
(worker `init` self-reports `{unsupported}` → `runInPlaceJob` returns `{unsupported:true}` →
`runZipJob` runs serial). See design D8 (revised) and plan Tasks 4–6.
