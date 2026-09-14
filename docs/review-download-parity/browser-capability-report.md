# Download Capability Across Browsers — Findings and Design

**Date:** 2026-07-30
**Status:** Investigation complete; tiering design proposed, not yet built
**Question:** How close can Bucketer get to cross-browser parity for large downloads, what is the
true extent of what each browser can do, and how do we tell the user?

---

## 0. Plain-English summary

A download has three jobs: **get the bytes**, **know how it's going**, and **put the bytes somewhere
the user can find them**. Every browser can do the first two. They differ almost entirely on the third.

There are only two ways to run a download:

- **Ask the browser to do it** — hand it a link and let its download manager take over. This is what
  Bucketer ships today. Works everywhere, at any size, but the app is blind: no progress, no completion,
  no control, and files land flat in Downloads.
- **Do it ourselves** — fetch the bytes in JavaScript, count them as they arrive (so: real progress and
  real completion), then put them somewhere. *Where* we may put them is what varies by browser.

The counterintuitive consequence: **the "dumb" method is the only one with no size limit.** Doing it
properly buys progress and resume but *caps* what we can handle on anything except Chromium, because
staging is bounded by a storage quota. So the shape is not "old bad, new good" — it is a choice of
mechanism per file size and per browser.

---

## 1. Method, and what it does and does not prove

Two kinds of evidence, kept deliberately separate.

**Measured.** A capability-and-behaviour probe (`probe/probe.html`, driven by `probe/run.mjs`) run
against real engines, writing 256 MiB and 1 GiB through three candidate staging paths while sampling
the resident memory of the whole browser process tree from outside. Chromium and Firefox ran natively;
WebKit ran in the official Playwright container.

Two confounds were found and corrected mid-investigation, either of which would have produced a
confidently wrong report:

- Playwright's default profile lives in `/tmp`, which is **tmpfs — RAM-backed** on this host, so every
  "disk" write in the first run went to memory. Quota read back as 3072 MiB and memory grew steeply.
  Repointing the profile at real disk changed the quota to 10240 MiB and **inverted the findings**.
  `TMPDIR` is not honoured; the path must be explicit.
- Reading getter properties off a prototype (`Response.prototype.body`,
  `ServiceWorkerRegistration.prototype.backgroundFetch`) throws `Illegal invocation`. Use `in`.

**Researched.** Mobile behaviour, vendor positions, and real-Safari specifics from primary
documentation. Mobile could not be measured here at all — those rows are literature, not evidence.

### Limits of the measurement

- **The WebKit run proves nothing about Safari, and this is now confirmed rather than suspected.**
  A direct introspection found `navigator.storage` **entirely absent** in Playwright's WebKit — not just
  `getDirectory`, but the whole Storage API, plus `FileSystemFileHandle` and
  `FileSystemDirectoryHandle` — in a secure context, in both a persistent profile and an ephemeral
  launch. Real Safari demonstrably has these. This is a property of Playwright's WebKit fork, which is
  **not Safari**; only `safaridriver` on real Apple hardware drives the actual browser.
- RSS is coarse and includes uncollected garbage. The *trend across sizes* and the *ratio between
  paths* are reliable; absolute figures are not.
- Desktop Linux only. No macOS, no Windows, no real mobile hardware.
- Absolute quota figures are environment-specific and say nothing about a user's machine.

---

## 2. What each engine has

| Capability | Chromium | Firefox | WebKit (Playwright) | Real Safari (documented) |
|---|---|---|---|---|
| `showDirectoryPicker` / `showSaveFilePicker` | ✅ | ❌ (position: negative) | ❌ | ❌ (position: oppose) |
| `createWritable` | ✅ | OPFS only | ❌ | **Safari 26+ only** |
| `createSyncAccessHandle` (worker-only) | ✅ | ✅ | ❌ | ✅ 15.2+ |
| OPFS | ✅ | ✅ | ❌ *(harness artifact)* | ✅ 15.2+ |
| `navigator.storage.estimate` / `persist` | ✅ | ✅ | ❌ *(harness artifact)* | ✅ |
| Background Fetch | ✅ | ❌ | ❌ | ❌ |
| `fetch` + `response.body` streaming | ✅ | ✅ | ✅ | ✅ |

**Chrome for Android does have File System Access.** Two sources contradicted each other; the
contradiction is resolved. It shipped in **M132** (~January 2025) — confirmed by Chrome Platform
Status (`android_first: 132`, `is_released: true`) and a Google engineer on the blink-dev thread.
**caniuse/MDN browser-compat-data is stale**, still reporting `"n"` for Chrome Android at the current
version. Two caveats: Android **WebView** did not fully land (disabled by default pending a 2026
Android release), and the four defects filed at launch — picker freezing on large folders like DCIM,
save being overwrite-only with no filename dialog, mime filters ignored, `InvalidStateError` on
save-to-project-folder — appear **still unresolved**; a downstream developer was still asking for
status eight months after launch with no answer.

---

## 3. The decisive measurement: what staging costs in memory

Three candidate paths at **1 GiB**, as peak RSS growth over baseline across the browser process tree.

| Path | Chromium | Firefox | WebKit | Verdict |
|---|---|---|---|---|
| **OPFS write** | **+41 MiB** | **+161 MiB** | n/a | genuinely disk-backed |
| **OPFS → Blob URL export** | **+33 MiB** (172 ms) | **+155 MiB** (211 ms) | n/a | nearly free, and fast |
| Blob assembled in memory | +1053 MiB | +1143 MiB | +1371 MiB | ~1× the file |
| IndexedDB chunks → reassemble | +2045 MiB | **+3817 MiB** | +1759 MiB | **2×–3.7× the file** |

**This inverts the prevailing literature.** Desk research had concluded IndexedDB staging was "the
strongest lever" for engines without File System Access, and left open whether an OPFS-backed `File`
→ `createObjectURL` streams from disk or buffers in RAM.

Measured: it streams. A 1 GiB OPFS file becomes a downloadable Blob URL in ~200 ms for ~35 MiB. And
IndexedDB — the recommended path — is the **worst**, costing up to 3.7× the file size on Firefox.

**Caveat that matters:** this is measured on Chromium and Firefox only. See §6.

---

## 4. True extent, per target

Desktop rows measured. **Mobile rows researched, not measured.**

| Target | Real progress | Completion known | Resume across sessions | Folder structure | Realistic ceiling |
|---|---|---|---|---|---|
| **Chromium desktop** | ✅ | ✅ | ✅ byte-range | ✅ real tree | disk-bound |
| **Chromium Android** | ✅ | ✅ | ⚠️ lifecycle | ⚠️ FSA present, defects open | low GB, foreground only |
| **Firefox desktop** | ✅ | ✅ | ✅ via OPFS | ❌ flat | ~10 GB without a `persist()` grant |
| **Firefox Android** | ✅ | ✅ | ⚠️ lifecycle | ❌ flat | hundreds of MB |
| **Safari desktop** | ✅ | ✅ | ⚠️ **7-day eviction** | ❌ flat | ~77 GB quota, mechanism unverified |
| **Safari iOS/iPadOS** | ✅ | ✅ | ⚠️ **7-day eviction** | ❌ flat | **~100 MB** |

### The finding that most threatens the design

**Safari deletes script-created storage after seven days without user interaction.** MDN's storage
eviction page, last modified 2026-01-05: *"If an origin has no user interaction… in the last seven days
of browser use, its data created from script will be deleted."*

This lands directly on the core user story — "stop, close the browser, come back in two weeks, resume."
On Safari the staged bytes may simply be gone. Chromium and Firefox do not do this. WebKit's policy post
indicates origins in **persistent** storage mode may be excluded and home-screen web apps are treated
differently, but neither is something the app can silently guarantee.

### Other Safari-specific costs

- `createWritable` did not exist until **Safari 26** (September 2025). Before that the only OPFS write
  path is a **worker-only** `createSyncAccessHandle` — a materially more complex implementation, not a flag.
- OPFS is **entirely disabled in Safari private windows**.
- Concurrent sync access handles are capped at **252** (matters for many-small-files, not one large one).
- Quota is generous: ~77 GB on Safari 26/macOS, ~38 GB on iPhone.
- The ~100–200 MB iOS crash ceiling was measured on **JS heap**, not file APIs. Whether OPFS traffic is
  exempt is plausible by architecture but **unconfirmed**, and it decides whether iOS is usable at all.

### Mobile, briefly

iOS suspends JavaScript essentially immediately when Safari is backgrounded; downloads are reported
cancelled on app switch. Screen Wake Lock does not help — it only stops the screen auto-locking and does
nothing once the user switches apps.

---

## 5. Proposed design: tiers, feature-detected

Not a quality ladder — genuinely different mechanisms, each honest about itself.

### Tier 1 — Managed folder (Chromium desktop; Android with caveats)
Stream to a user-chosen directory via File System Access. Real progress, byte-range resume, real folder
tree, no quota ceiling. Per-chunk presigning means no long-lived URL exists.

### Tier 2 — Staged download (**Chromium and Firefox**; Safari *attempted, not claimed*)
Fetch with `response.body` streaming for progress and completion; stage into OPFS (measured cheap and
disk-backed); export via Blob URL. Resume works because OPFS survives reload.
*Costs:* files arrive flat; bounded by quota; the file is transiently on disk **twice**, so a 40 GB
download needs 80 GB free.

### Tier 3 — Browser-managed handoff (everywhere; shipped today)
Presigned URL plus `Content-Disposition`, handed to the browser's download manager. No progress, no
completion — but no memory ceiling either, and on Android the OS download manager can continue after the
browser exits. **Still the only viable path for genuinely huge jobs off Chromium.**

### Tier 0 — CLI handoff (shipped)
For anything approaching a terabyte, a real transfer tool beats any browser.

Selection is by **feature detection, never user-agent sniffing**.

**Full parity is not achievable and must not be promised.** Progress-and-completion parity *is*
achievable everywhere, because `fetch` streaming is universal. The destination is what cannot be equalised.

---

## 6. Decision: keep the single-file architecture

An earlier draft flagged the no-service-worker pillar as worth re-deciding, since Background Fetch and
service-worker streaming both need a separate script file. The evidence says **don't**:

- **Safari and iOS gain nothing** from either technique — no FSA, no Background Fetch, and SW-driven
  downloads are unreliable there.
- **Firefox's SW path is actively dangerous.** StreamSaver's service worker goes idle after ~30 s
  without keep-alive pings, and an open issue (January 2026) reports Firefox halting mid-stream and the
  browser reporting **success on a truncated file** — silent corruption, the worst possible failure for a
  backup tool.
- **Chromium already has the better option for free.** `showSaveFilePicker` + `createWritable` is a plain
  `Window` API needing no separate script, and it solves the larger-than-RAM problem outright.

A dedicated service-worker file buys nothing on the one platform it would help, and doesn't fix the
platforms it wouldn't. The pillar stands.

---

## 7. What must be verified before Tier 2 ships on Safari

Tier 2 on Safari currently stacks three unvalidated assumptions. **No published source anywhere**
describes running OPFS → `getFile()` → `createObjectURL` → `<a download>` on a multi-GB file in real
Safari and reporting the result; the one thread proposing exactly this pattern has its author stating
they never tested Safari. That absence is itself the finding.

The assumptions, riskiest first:

1. That WebKit's `getFile()` returns a **lazy, disk-backed** `File` rather than copying into the
   WebContent process. The entire Safari case rests on this.
2. That `createObjectURL` + `<a download>` on a GB-scale OPFS file actually completes on macOS and iOS
   rather than routing bytes through page memory or failing above some undocumented ceiling.
3. That the ~100–200 MB iOS page-memory ceiling does not apply to OPFS traffic.

Plus: whether a paused job survives Safari's 7-day eviction, and whether Chrome for Android's launch
defects are fixed.

Verification requires real Apple hardware (`safaridriver` or a device cloud) — Playwright cannot do it.
**Until (1) and (2) are answered, Tier 2 is a Chromium-and-Firefox feature.**

---

## 8. Telling the user

The governing rule is already in `docs/intent/master-queue.md`: never claim progress the app cannot
observe. Prior art suggests five more.

**Gate the feature, not the app.** Google Docs gates only offline mode; VS Code for the Web gates local
folder access while the editor still loads. Figma blocks the whole app — defensible for a renderer with
no fallback, wrong here, where a fallback always exists.

**Describe the layer, not the deficiency.** The GOV.UK service manual frames progressive enhancement as
what each layer provides, never as a judgment on the user.

**Disclose before commitment.** The job panel already lists the folder before offering to start, so size
is known at the moment of decision. Capability belongs in the same place.

**Never fake a percentage.** Git shows `Receiving objects: 55% (275/500)` — a real bounded count standing
in for an unknowable one. Chrome's own download UI drops to bytes-received when `Content-Length` is
absent. (Some practitioner writing claims dishonest progress bars reduce abandonment; that conflicts with
this project's doctrine and is rejected.)

**Explain disabled things inline.** Unexplained disabled controls are a documented top usability
complaint, and tooltips alone fail for accessibility.

### Where it goes

The app already has a **CapabilityPanel** for per-connection permissions. Browser capability is a
different axis and belongs near the download job panel — but the visual pattern is established and should
be reused. Three placements: a capability line in the job-creation panel; the existing "Browser-managed"
queue badge extended to name the tier; and an inline "why?" affordance.

### Proposed copy

> Chrome and Edge on desktop can download straight into a folder you choose, with progress and resume.
> This browser downloads files individually into your Downloads folder instead.

> Files arrive as a flat list — no browser can create folders when downloading from a webpage.

> 12 of 412 files handed to your browser. Bucketer can't see their progress or confirm they finished —
> check your browser's download list.

> Downloads over a few hundred MB are unreliable on phones: the browser stops this tab when you switch
> apps. For anything large, use a desktop browser or the command-line option.

> This job is 840 GB. A transfer tool will finish sooner and survives restarts — this tab can't.

> Safari clears a site's saved data after seven days without a visit. If you pause this job, open
> Bucketer at least once a week so it can resume.

### Anti-patterns

- Whole-app browser gating when a fallback exists.
- Bare technical strings with no consequence or next step.
- Repeating a capability notice every session.
- User-agent sniffing instead of feature detection.
- Any percentage, ETA, or transfer rate on Tier 3.

---

## 9. Open questions

1. OPFS export behaviour on real Safari, desktop and iOS (blocks Tier 2 on Safari).
2. Whether Chrome for Android's four launch defects are fixed.
3. Whether persistent-mode storage reliably exempts a job from Safari's 7-day eviction.
4. Blob and memory ceilings on Chrome Android and Firefox Android — no current figures found.
5. Whether Samsung Internet and other Chromium-Android forks inherited M132's FSA.
6. Nobody has publicly compared these techniques or documented abandoning one for another — so there is
   no external experience to lean on beyond what is cited here.

---

## Appendix — reproducing

```
node docs/review-download-parity/probe/run.mjs          # SIZES / ENGINES env vars
```

The profile must be on real disk, not tmpfs; the runner handles this. WebKit requires the container:

```
podman run --rm --ipc=host -v "$PWD":/work:Z -w /work/docs/review-download-parity/probe \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e ENGINES=webkit \
  mcr.microsoft.com/playwright:v1.60.0-noble node run.mjs
```

`probe/results-webkit.json` holds the raw WebKit run. Note that run establishes only that Playwright's
WebKit lacks the Storage API — it says nothing about Safari.
