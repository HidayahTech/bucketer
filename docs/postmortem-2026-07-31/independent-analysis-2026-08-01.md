# Independent postmortem analysis — 2026-08-01

**Author:** Claude Fable 5, at the operator's request, in a fresh session.
**Relationship to the other documents here:** `missteps.md` (the 51-item catalog) and
`handoff.md` were written by the Claude Opus 5 agent whose work is under review. This
document is independent of both: every defect claim below was re-verified against the
source, and every finding marked **[EXPERIMENT]** was demonstrated in a live browser with
a matched control. Per the handoff's constraint, this analysis was not performed on Opus 5.

**Constraints observed:** no subagents; no changes to the repository other than this file
(experiment scripts live in the gitignored `.claude-scratch/`); nothing committed.

---

## 1. Baseline (handoff step 2)

Established before touching anything, on the working tree as handed over (uncommitted
v1.44.0 + noble base switch present):

| Layer | Result |
|---|---|
| `npm test` | 1318 / 1318 pass |
| `npm run test:ui` | 457 / 457 pass |
| `npm run test:e2e:container` | **All 10 lanes passed** (9 browser lanes + node lane), noble image, no segfault |

The green suite is reported as context, not as evidence — which the rest of this document
proves out rather more sharply than the catalog did.

---

## 2. New findings — defects the 51-item catalog does not contain

Ordered by severity. **[EXPERIMENT]** = demonstrated live with a control arm;
**[CODE]** = confirmed by reading the source; file:line cited.

### F1 — CRITICAL, shipped in v1.43.0: the CSP silently blocks every folder download on an http endpoint — including the entire e2e environment [EXPERIMENT]

The bundle ships `Content-Security-Policy: … frame-src https: …`. The v1.43.0 navigation
fix routes every folder download through a hidden iframe (`download-issue.js`), and an
iframe's navigation is governed by `frame-src`. Consequence: against any **http** endpoint
the iframe never loads — no request leaves the browser, no error surfaces, and the app
still marks every file ISSUED and reports "Sent N of N".

Two distinct blast radii:

1. **Real users on http endpoints** (MinIO on a LAN is a first-class, supported provider —
   `PROVIDERS.MINIO`, path-style, the works) get a folder-download feature that downloads
   nothing, silently.
2. **The whole e2e harness runs over http** (`http://localhost:<port>` mock). So the
   shipped spec `download-navigation.test.mjs` passes its "the page did not navigate"
   assertion because the frame is CSP-blocked from loading *anything* — not because the
   attachment/iframe mechanism works. The spec cannot distinguish "contained" from
   "completely broken". Zero downloads have ever occurred in the e2e environment.

Evidence (scripts in `.claude-scratch/`, Playwright host Chromium 148 / Firefox 150,
serving the fresh `perf/` bundle built from this tree):

| Arm | Transport | Latency | Files issued | Downloads started | Object GETs at server |
|---|---|---|---|---|---|
| experiment2 | http (as e2e) | 0 ms | 3 | **0** | 0 (probes: 3/3 fine) |
| https arm | https (via TLS proxy) | 0 ms | 3 | 3 | 3 |

Discriminator: a minimal page with the identical hidden-iframe mechanism against a plain
http server *does* fire Playwright's download event (1/1), and the probes' `fetch` calls
succeed in both arms (`connect-src` allows `http:`; `frame-src` does not). The block is
the CSP, not the measurement, and not Playwright.

### F2 — CRITICAL, shipped in v1.43.0: reassigning the shared iframe's `src` cancels the previous file's still-pending download; at realistic latency, unprobed files are silently lost wholesale [EXPERIMENT]

`issueBrowserDownload` reuses one iframe and assigns `src` per file, paced by
`DOWNLOAD_ISSUE_DELAY_MS = 250`. A navigation only becomes a download once response
headers arrive. If the next `src` assignment lands first, the in-flight navigation is
replaced and that file's download never starts — while the engine has already marked it
ISSUED.

Matched pairs, one variable (mock latency), both engines, https transport so F1 is out of
the picture; 40-file job (⇒ probe interval 2, so half the items are unprobed):

| Engine | Latency | Downloads started / issued | Server received GETs |
|---|---|---|---|
| Chromium | 0 ms | **40 / 40** | 40 |
| Chromium | 400 ms | **20 / 40** | 40 |
| Chromium | 1000 ms | **20 / 40** | 40 |
| Firefox | 0 ms | **40 / 40** | 40 |
| Firefox | 1000 ms | **20 / 40** | 40 |

The lost 20 are exactly the unprobed items: a probe (which awaits a full round trip)
stretches the gap after it, protecting the file issued just before. The loss pattern is
identical in both engines and appears/disappears with latency alone.

Why the earlier arms hid this: for jobs of ≤ 20 files, `sampleInterval` probes *every*
item, and each probe waits out the latency — so the issue gap always exceeds TTFB and an
8-file test run can never lose anything. Scale the shape to the feature's target: a
3,800-file job probes ~20 items, so once TTFB > ~250 ms, **roughly every unprobed file —
upwards of 99% of the job — is silently lost**, all reported as sent. The v1.44.0 folder
verification would at least detect the carnage afterwards; nothing prevents it.

This is the concrete consequence of catalog item 38 ("no test asserts the iframe still
downloads"): the fix was verified against the defect it targeted (navigation) and never
against the behaviour it had to preserve (downloading). Both engines' "10 downloads, 1
iframe" manual observation from the earlier session cannot have been made against the e2e
mock (F1 makes that impossible over http), and at whatever latency it was made, the
pacing/probe shape above explains why a small manual test would pass.

### F3 — HIGH, uncommitted v1.44.0: verification's failure-marking is a dead end — a verified job with missing files is stranded on *every* browser, and its promised retry is unreachable [EXPERIMENT]

The catalog records #2 (DONE jobs invisible on non-Chromium) and #5 (a job can never be
verified twice). The live behaviour is worse than both combined, and it is on Chromium too:

- `verifyJob` marks missing/mismatched items FAILED *"so the existing resume path can
  re-issue exactly those"* (its own comment, and the delivered report's claim), and stamps
  `verifiedAt` on the job — but never touches `job.status`, which remains `DONE`.
- `listUnfinished` excludes `DONE` jobs (`App.jsx:529`) — so the resume path never sees it.
- `listVerifiable` excludes `verifiedAt` jobs (`App.jsx:559`) — so verification never sees
  it again either.
- Those two lists are the **only** ways any job or Discard control reaches the UI
  (verified by exhaustive search for `loadAllJobs`/`deleteJob` consumers).

Live run (Chromium, fake directory with 6 correct files, 1 wrong-size, 1 absent):
verification correctly reported "6 confirmed, 1 missing, 1 the wrong size" — then, on
reopening the panel: **resume rows: 0, verify rows: 0, discard rows: 0**, while IndexedDB
still holds the job (`status: "done", verifiedAt: true`) and its items (`6 done, 2
failed`). The two failed items can never be retried, re-checked, or deleted, and the
manifest is permanent. The feature's core promise — "anything it can't account for is
retried the next time you resume" (CHANGELOG 1.44.0) — is unreachable in the primary flow
it was written for.

### F4 — MEDIUM, uncommitted v1.44.0: a failed verification is silently swallowed by the UI [CODE]

`DownloadJobPanel.jsx` `verify()` catches errors with `setError(err)` — but the only
render of `error` is inside the `phase === 'error'` branch, and `verify()` never changes
`phase` (it stays `'options'`). The deliberate bucket-mismatch guard in `api.verify`
(`App.jsx:577`) therefore throws a message no user can ever see; an IndexedDB failure is
equally invisible. The user clicks "Check my downloads folder", picks a folder, and
nothing happens. (Also inconsistent: `scan()` stores `err.message`, `verify()` stores the
raw Error object, which Preact would not render meaningfully even if the branch existed.)

### F5 — MEDIUM, uncommitted v1.44.0: `counters.total` is inflated by archived items, not just `bytesTotal` [CODE]

The catalog's #19 records archived *bytes* persisting into `bytesTotal`. The item *count*
has the same defect: `appendManifestPage` counts SKIPPED rows into `counters.total`, and
`handleDownloadStart` uses that as the task total. A 412-file job with 12 archived files
runs to completion showing **"Sent 400 of 412 to your browser — check your downloads"** —
12 forever-unaccounted files in the master queue row, with the explanation visible only in
the panel the user has already closed. `sampleInterval` also computes from the inflated
total (minor).

### F6 — MEDIUM, uncommitted v1.44.0: a paused job with both failures and issued files appears in both lists at once [CODE]

`listUnfinished` (status ≠ DONE, remaining > 0) and `listVerifiable` (issued > 0, no
`verifiedAt`) are not mutually exclusive. A partially-failed run (PAUSED, issued > 0)
renders as two rows in the same panel — "N still to send" with Resume/Discard, and "M
files sent" with Check/Discard — two different framings and two Discard buttons for one
job. `listVerifiable` also does not exclude `RUNNING`/`ENUMERATING`, so a job can be
offered for verification while its run is mid-flight in another view; verifying it then
marks still-in-flight files FAILED. Related: `handleDownloadStart` ends with
`saveJob({ ...fresh, status })` where `fresh` was loaded at run start — a stale-snapshot
write that would clobber a `verifiedAt` (or any other field) written during the run.

### F7 — MEDIUM, design-invariant violation, uncommitted v1.44.0: verification materialises the whole job in memory [CODE]

`verifyJob` collects every ISSUED item into an array, and `readFolder` reads the entire
directory into a Map — for the million-item jobs this subsystem was explicitly designed
around. `download-records.js` states the invariant in its own comments ("a job can hold a
million items and the UI must never materialise them", citing BUG-021) and provides the
cursor API `verifyJob` bypasses. Works at demo scale; contradicts the module family's own
stated design rule at target scale.

### F8 — LOW/MEDIUM, infrastructure: the e2e stack cannot represent the features shipped against it [CODE]

- The mock hardcodes `<StorageClass>STANDARD</StorageClass>` on every listing entry —
  archived-object flagging is untestable end-to-end as-built.
- Playwright cannot drive `showDirectoryPicker` (known), but the panel's picker call can
  be stubbed at `window.` level — my experiment did exactly that and it works; an e2e spec
  for verification was possible all along.
- Comment rot: the third e2e test's premise ("the previous run issued every item, so its
  manifest is gone") is false under v1.44.0's retention change; the test still passes, for
  reasons it does not state.

### F9 — LOW: uncited and partly wrong vendor claims in `storage-class.js` [CODE]

"AWS ONLY. No other S3-compatible provider has a storage tier where a plain GET fails" is
asserted without citation (against the project's own cite-your-sources rule) and is wrong
as a general statement — e.g. Scaleway's Glacier class and OCI's Archive tier both refuse
plain GETs until restore. It is harmless *today* only because neither provider is in
`PROVIDERS`, i.e. the code is right for the supported list, but the comment teaches the
next reader a falsehood. The GLACIER_IR and INTELLIGENT_TIERING reasoning, by contrast,
checks out.

### F10 — LOW: the stale numbers survived into the tree that the postmortem itself flagged [CODE]

`docs/review-v1.44.0/doc/sections/crash.html.j2` still says "roughly 55% of full runs"
while `test/e2e/matrix-helpers.mjs` (same working tree, same session) says "9 failures in
14 full matrix runs" (64%). The report source also still presents the noble switch as "not
applied here" and — worse — its verification matrix states "Marked failed; a resume
retries it", which F3 shows is unreachable. The delivered PDF inherits all of this.

### Positive verifications (things that held up)

- The verification matching logic itself (`matchDownloads`) rendered correct verdicts on
  its first-ever browser execution ("6 confirmed, 1 missing, 1 the wrong size").
- `indexeddb-core` v3→v4 migration is additive and guarded; safe for existing users.
- `download-naming.js` sanitisation, `crawl-prefix.js`, `transfer-commands.js` (secret
  withheld by default, shell-quoting, ini-injection stripping) and
  `browser-capability.js` (feature-detection-only) survive adversarial reading.
- The noble base switch: 10/10 lanes on a full baseline run; no segfault. Consistent with
  the 6/6 evidence, now 16/16 cumulative.
- BUG-050's own narrative and the matched-pair evidence for the *navigation* half of the
  fix remain sound. It is the *download* half that F1/F2 break.

---

## 3. Verification of the catalog's seven defect claims

| Catalog defect | Verdict | Method |
|---|---|---|
| 1. Offer counts exclude archived, bytes don't (`DownloadJobPanel.jsx:326`) | **CONFIRMED** | Code; the button renders `sendable` with unadjusted `counts.bytes` |
| 2. DONE job unreachable on non-Chromium | **CONFIRMED, and understated** | Code + experiment — see F3: with verification it's stranded on Chromium too |
| 3. Archived bytes persisted into `bytesTotal` | **CONFIRMED, and understated** | Code — `total` is inflated as well (F5) |
| 4. `collisionBase` false positive on a user's own "report (1).pdf" | **CONFIRMED** | Code; regex attributes any " (n)" name to a base it may never have had; suppresses a genuine MISSING into RENAMED and leaves it ISSUED forever |
| 5. A job can never be verified twice | **CONFIRMED, and understated** | Code + experiment — the un-retryable half is worse than the un-re-verifiable half (F3) |
| 6. No test asserts the iframe still downloads (v1.43.0) | **CONFIRMED, consequence realised** | Experiment — not only is it untested, it doesn't work: F1 (http: nothing downloads) and F2 (latency: unprobed files lost) |
| 7. Pre-flight 403-on-missing refuses whole job on AWS (v1.43.0) | **CONFIRMED by reading** | Code: 403 → DENIED → `isBlocking` → job-wide stop; index 0 always probed. Not exercised against real AWS here either — flagged as still-unmeasured |

The catalog's three underlying patterns (tool output accepted unexamined; conditions not
held constant; appearance of verification substituted for verification) are all
re-confirmed by the new findings — F1 is the sharpest instance of the third pattern
anywhere in this codebase: a shipped e2e spec that passes *because* the feature under test
is inert in the test environment.

---

## 4. Systemic issues — what the correlation shows

1. **Verification theater, now with proof.** The session wrote "a green suite is not
   evidence" into its own report, then shipped v1.43.0 whose sole behavioural e2e proof
   passes identically whether downloads work or are wholly blocked (F1). The gap between
   "the assertion passed" and "the behaviour exists" was not marginal; it was total.

2. **Fixes verified only against their target defect.** The iframe fix was proven to stop
   navigation (true) and assumed to preserve downloading (false twice over — F1, F2). The
   lifecycle change was proven to retain manifests (true) and assumed to leave an exit
   path (false — F3). The pattern: each change validated forward, never sideways.

3. **Absolute claims with no citations at the trust boundaries.** The CSP was never
   mentioned in any design note for an iframe-based mechanism, though the CSP is the
   authority over what frames may load. The storage-class comments assert vendor behaviour
   uncited. The preflight status table was validated against a mock whose codes the author
   chose. Every one of these is the operator's existing "cite official docs" rule, unapplied.

4. **The test infrastructure's fidelity was never itself reviewed.** The mock has no
   StorageClass variation, http-only transport (which F1 turns from a fidelity gap into an
   active mask), and no download-event observation. No catalog pass examined "can our
   harness even represent the features we claim it verifies?" — that category was
   available and productive (this analysis found three items in it).

5. **Self-review found real defects but systematically under-scoped consequences.** Items
   the catalog did find (2, 5, 19, 38) each turned out worse than written (F3, F5, F1/F2).
   The catalog's discovery curve (0, 6, 4, 5 under operator pressure) predicted this:
   the correct prior on "the catalog is complete" was, and remains, low. This analysis
   should be assumed incomplete by the same logic.

### The handoff's §4 process questions, answered briefly

1. *Baseline at session start* — yes, encode it. This session ran the full baseline first
   (~35 min) and every subsequent claim was cheaper for it.
2. *Timebox trigger* — the signal was visible: the moment the crash reproduced on an
   unmodified HEAD control, it was provably not the feature's regression, and everything
   past that point was infrastructure work worth an explicit go/no-go.
3. *Low self-detection rate* — the two critical defects here (F1, F2) were found only by
   demanding an end-to-end observable (a download event / a server-side request count)
   rather than a code-level proxy (ISSUED counters, frame attached). Encodable rule: for
   every feature, name the one observable a user would accept as proof, and measure that.
4. *Is one-variable discipline encodable* — yes; every experiment above is a matched pair
   and each conclusion cites its control. It cost five extra runs, total.

---

## 5. Implications for the open decisions (no changes made)

- **v1.44.0 must not be committed as-is** — catalog 1–5 plus F3–F7 sit in it.
- **v1.43.0 needs a fix release more urgently than v1.44.0 needs finishing**: F1 and F2
  are in pushed, tagged code, and they gut the feature's core promise on real networks.
  (Mitigation option until then: the probe already runs per-file for small jobs; it is the
  pacing/iframe-reuse design that needs rework — e.g. issue only after the prior
  navigation resolves, or per-file frames with bounded recycling, or anchor+blob for error
  containment. Design decision — not made here.)
- **The base switch remains good** and is independent; its evidence strengthened to 16/16.
- **Issue #54 and the PDF remain stale** as the handoff already records; the PDF now has
  a third reason (its verification-matrix claim contradicted by F3).
- The e2e download spec needs a real-download assertion (Playwright download events work
  fine — demonstrated), an https-capable mock (or a CSP-aware note), and a StorageClass
  knob in the mock before the archived feature can honestly claim e2e coverage.

---

## 6. Experiment appendix

Scripts (gitignored, reproducible from repo root): `.claude-scratch/`
- `download-race-experiment.mjs` — http arm + first browser run of verification + stranded-job check
- `iframe-download-discriminator.mjs` — proves Playwright sees iframe downloads (method validity)
- `download-https-experiment.mjs` — TLS proxy in front of the mock; download counting + server-side GET counting
- `key.pem` / `cert.pem` — throwaway self-signed cert (CN=localhost, 2-day validity)

Environment: host Playwright (Chromium 148 / Firefox 150 per `~/.cache/ms-playwright`),
serving `perf/index.html` rebuilt 2026-07-31 23:57 from this working tree (verified fresh
before use). Host-run and so labelled: these are controlled experiments about a mechanism,
not coverage claims; per project rules, coverage claims still require the container.

Raw results (one line per run, as emitted):

```
http  0ms  8f  chromium: issued=8  downloads=0
http  0ms  3f  chromium: probes 3/3 ok, nav requests started=0  → CSP frame-src
https 0ms  3f  chromium: downloads=3/3, server GETs=3
https 1000ms 8f  chromium: downloads=8/8   (invalid race arm: every file probed)
https 0ms  40f chromium: downloads=40/40, server GETs=40   (control)
https 400ms 40f chromium: downloads=20/40, server GETs=40
https 1000ms 40f chromium: downloads=20/40, server GETs=40
https 0ms  40f firefox:  downloads=40/40, server GETs=40   (control)
https 1000ms 40f firefox:  downloads=20/40, server GETs=40
verify (chromium, fake picker 6 ok / 1 wrong-size / 1 absent):
  "6 confirmed, 1 missing, 1 the wrong size"
stranded-check after verify: UI rows resume=0 verify=0 discard=0;
  IndexedDB job {status: done, verifiedAt: true}, items {done: 6, failed: 2}
```

**Closing note.** This analysis, like the catalog it audits, should not be presumed
complete. The categories most likely to still hold defects, in this author's estimate:
real-provider behaviour (nothing in this branch has ever touched AWS, B2, or R2), WebKit
behaviour of the iframe mechanism (not runnable on this host; container run pending a
harness that can observe downloads at all), and multi-tab concurrency over the shared
IndexedDB stores.
