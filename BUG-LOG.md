# Bug Log

A living record of real bugs encountered and resolved during development. Each entry captures the symptom, root cause, fix, why it wasn't caught earlier, and the test case it suggests. This log feeds directly into the test suite — bugs that have bitten us once should be mechanically prevented from recurring.

---

## BUG-054 — A verified download job could become unreachable on every browser

**Symptom.** Caught before release, by the 2026-08-01 independent postmortem (finding F3;
also catalog defects 18/37), and reproduced live: verify a completed folder download whose
check finds missing files, reopen the panel — zero rows. No resume for the failures the
check itself marked retryable, no way to check again, and no Discard, so the manifest and
its FAILED items sat in IndexedDB permanently. On Firefox and Safari even a *clean* job
was unreachable, because the only row that could show it sat behind a Chromium-only
capability gate. A paused job with both failures and issued files also rendered as two
rows with two Discards.

**Root cause.** The panel's sections came from two independent filters
(status ≠ DONE ∧ remaining > 0; issued > 0 ∧ !verifiedAt) whose union was not total and
whose intersection was not empty. Verification stamped `verifiedAt` (excluding the job
from re-checking) and left `status` DONE (excluding it from resuming) — the promised
retry was structurally unreachable. The section carrying Discard was capability-gated.

**Fix.** One total classifier (`src/lib/download-lifecycle.js`): every persisted job maps
to exactly one of unfinished/sent/settled, every class renders a row, every row carries
Discard; capability gates may hide an action, never a row. A check that finds failures
demotes DONE → PAUSED so the classifier lists it as resumable; `verifiedAt` became purely
informational; verify results persist on the job (`lastVerify`) instead of dying with the
component; verification errors render (they were previously stored into state no branch
displayed — F4); end-of-run job writes go through a read-merge-write `updateJob` instead
of a stale whole-record snapshot (F6). Verification itself became streaming — key-ordered
item pages, per-name folder lookups, an O(1) `by_job_localname` index count for ambiguity
— honoring the module family's own bounded-memory rule (F7 / BUG-021).

**Why it wasn't caught earlier.** The feature's entire verification was a green unit and
component suite; the flow "verify finds problems → user retries them" was never traced
past its happy path, and no test asked "can the user still see this job afterwards?" The
reachability question only has meaning across the whole UI, which no per-list test asks.

**Test case.** `test/download-lifecycle.test.js` — the cross-product invariant (every
count combination classifies; the F3 shape classifies unfinished);
`test/e2e/browser/download-verify.test.mjs` — the full live flow: check finds problems →
job resumable on-screen → resume → re-check → settles → discardable; plus the unstubbed
"discardable without a picker" spec for the Firefox/Safari shape.

---

## BUG-055 — Archived files inflated every count the download promised

**Symptom.** Caught before release (postmortem F5, catalog 17/19). With 12 of 412 files
archived: the offer button said "Send 400 files (840 GB)" — the count for one set, the
size for another — and after a clean run the queue row read "Sent 400 of 412 — check your
downloads" forever, 12 files unaccounted with no explanation in sight.

**Root cause.** `appendManifestPage` accumulated every recorded item into
`counters.total`/`bytesTotal`, including SKIPPED (archived) rows that can never be
issued, and both UI surfaces read those counters.

**Fix.** The counters split: `total`/`bytesTotal` remain manifest truth;
`sendable`/`bytesSendable` (SKIPPED excluded) are what the offer quotes, and the task
total is the live PENDING count at run start — so a resume of 2 remaining files reads
"Sent 2 of 2", not "Sent 2 of 3". Legacy manifests self-heal on first listing. The
archived notice states both the count and the size set aside.

**Test case.** `test/download-manifest.test.js` — "archived items are counted in the
manifest totals but not the sendable counters"; component tests assert the offer button's
count and bytes describe the same set; `test/e2e/node/download-archived.test.mjs` runs
the pipeline against the real mock protocol (which now carries StorageClass). Browser-UI
e2e of archived flagging remains impossible honestly — the app derives the provider from
the endpoint, and a localhost mock can never detect as AWS; recorded here per the
harness-fidelity rule instead of implied by a green lane.

---

## BUG-056 — A user's own "(1)"-suffixed file could silence a missing-download verdict

**Symptom.** Caught before release (postmortem catalog defect 20). If the user's folder
contained their own, unrelated `report (1).pdf`, a genuinely missing `report.pdf` from
the job was reported "probably renamed by the browser" — exactly the reassurance that
sends nobody looking for a file that never arrived.

**Root cause.** The rename heuristic treated ANY collision-suffixed name as evidence for
its base name, keyed on the name alone.

**Fix.** A collision variant only counts as "probably ours, renamed" when its SIZE also
matches the expected file; a wrong-size variant is somebody else's file and the verdict
stays missing (and the item is marked FAILED, so a resume retries it).

**Test case.** `test/download-verify.test.js` — "a collision-suffixed file of the WRONG
size does not suppress a missing verdict" (and its right-size sibling).

---

## BUG-057 — A resumed ZIP download's progress label could read "N of M" with N > M

**Symptom.** Found in the final whole-branch review of the ZIP-download feature (not yet
released). Resume a ZIP job that already had some files staged from an earlier run — e.g.
5 DONE, 3 PENDING left — and the MasterQueue row read "Zipping 5 of 3…", then "Paused — 8
of 3 zipped": the "so far" count exceeding the "out of" total on the one row in the app
whose entire job is to report a count honestly (`docs/intent/master-queue.md`'s reason
downloads were excluded from the queue in the first place).

**Root cause.** `runZipJob`'s progress is deliberately cumulative — `completed` in
`src/lib/zip-job.js` starts at the prior run's DONE count and climbs through this run's
completions, because a ZIP is one file whose displayed progress must never regress across
a resume (confirmed by reading `onProgress`'s call sites in `zip-job.js` and the terminal
`doneCount = await countItemsByStatus(..., DONE)` read in `handleZipStart`, App.jsx —
both cumulative by design). But `total`, set once at task creation in `handleZipStart`
(`src/components/App.jsx`), was only `countItemsByStatus(..., PENDING)` — the per-run
remainder, not the cumulative scale `current` is measured on. On a fresh job DONE is 0, so
the two scales coincide and the bug is invisible; only a resume with prior DONE items
exposes the mismatch, because that specific case has no e2e coverage (the branch's e2e
resume arm's first run is not itself a resume — see the harness-fidelity note in this
entry's PR).

**Fix.** `handleZipStart` now sums `countItemsByStatus(..., DONE) +
countItemsByStatus(..., PENDING)` and uses that cumulative figure as both the task's
`fileCount` and `total`. A fresh run is unchanged (DONE is 0, so total still equals the
sendable count); a resume's total now covers everything sendable — prior and current — so
`current` can never exceed it.

**Why it wasn't caught earlier.** `test/components/master-queue-download.test.jsx`'s
running-zip-state test asserted only `/zipping/i` plus separate `body.includes('12')` /
`body.includes('412')` checks — loose enough to pass even with the two numbers
transposed, unrelated, or (as here) simply on different scales from each other. No test
modeled the specific resumed shape (`current` already past what a fresh run's `total`
could show).

**Test case.** `test/components/master-queue-download.test.jsx` — tightened the running-zip
test to the exact string `Zipping ${current} of ${total}…`, and added "REGRESSION: a
resumed zip label never shows current exceeding total (N ≤ M)": a task with
`current: 5, total: 8` (the post-fix cumulative shape) must render "Zipping 5 of 8…", and
must NOT render "Zipping 5 of 3…" (the pre-fix per-run-remainder shape).

---

## BUG-052 — The CSP silently blocked every folder download on an http endpoint

**Symptom.** Against any http endpoint — MinIO on a LAN is a first-class supported
configuration — a folder download issued nothing at all: no request left the browser, no
error appeared anywhere, and the app reported "Sent N of N". Present in the v1.43.0 branch
tag (never merged to `main` or deployed — production stayed v1.39.1). The same
block made the entire e2e environment (an http mock) inert: the download spec passed its
"page did not navigate" assertion precisely because the frame was forbidden from loading
anything, and zero downloads had ever occurred in e2e.

**Root cause.** v1.43.0 moved download issuance from an anchor to a hidden iframe
(BUG-050), and an iframe's navigation is governed by the bundle CSP's `frame-src` — which
was `https:` only. `connect-src` allowed `http:`, so probes and listings worked, masking
the block. The CSP was never considered in the iframe design; no design note mentions it.

**Fix.** `frame-src https: http:` in `src/index.html`, mirroring `connect-src` — no new
plaintext exposure, since credentials and object bytes already flow over http when the
user chooses an http endpoint. The e2e mock gained an https listener AND kept http, so
both transports are exercised.

**Why it wasn't caught earlier.** Three layers: the failure is silent by CSP design (a
blocked frame navigation reports nothing); the e2e harness was http-only, so the
environment that should have caught it was the one place the feature could never work;
and the spec asserted only an absence, which an inert feature satisfies. Found by the
2026-08-01 independent postmortem (finding F1), by demanding a presence observable.

**Test case.** `test/e2e/browser/download-completion.test.mjs` — "every issued file
becomes a download over plain http". Matched pair: pre-fix, 0 of 8 downloads (run
recorded 2026-08-01); post-fix, 8 of 8, http and https arms, with the mock's request log
confirming the attachment GETs server-side.

---

## BUG-053 — Reassigning the shared download iframe cancelled still-pending downloads

**Symptom.** In a folder download, files whose first response byte took longer than the
250 ms issue pacing silently never downloaded, while the app counted them ISSUED and
reported "Sent N of N". At 400 ms latency, a 40-file job delivered exactly 20 files — on
Chromium and Firefox alike. Only files issued immediately after a sampled probe (which
paced the loop by a full round trip) survived. Present in the v1.43.0 branch tag (never
merged to `main` or deployed — production stayed v1.39.1).

**Root cause.** All downloads shared one hidden iframe; assigning `src` REPLACES the
frame's in-flight navigation, and a navigation only becomes a download once response
headers arrive. Probe sampling (~20 per job) meant most issues were paced only by the
250 ms delay, so at any realistic TTFB the next assignment landed first and cancelled the
pending download. The fix was verified against the defect it targeted (navigation, from
BUG-050) and never against the behaviour it had to preserve (downloading).

**Fix.** Two independent layers: every file is now probed before issue (the probe's
awaited round trip guarantees at least one full RTT of pacing per file — the mechanism
that measurably protected files in the postmortem experiments), and issuance uses a
bounded pool of per-file iframes (`MAX_DOWNLOAD_FRAMES = 8`, oldest recycled) so
consecutive issues never share a frame. Probe semantics also became per-file: a failed
probe fails that file honestly instead of issuing a download that cannot succeed, and
only a streak of 3 consecutive denials blocks the job — one denial can be one deleted
object, because AWS returns 403 for a missing key when the caller lacks `s3:ListBucket`
(documented; real-provider measurement still pending — see
`docs/manual-checks/preflight-real-providers.md`).

**Why it wasn't caught earlier.** No test asserted a download ever completes — the e2e
proved the page didn't navigate, nothing more (and BUG-052 made downloads impossible in
e2e anyway). Manual verification ("10 downloads, 1 iframe") ran at localhost latency,
where responses always beat the pacing. Found by the independent postmortem (finding F2)
via matched-pair latency experiments.

**Test case.** `test/e2e/browser/download-completion.test.mjs` — "no file is lost when
the response is slower than the issue pacing": 40 files at 400 ms mock latency must
produce 40 download events. Matched pair: pre-fix 20 of 40 (run recorded 2026-08-01,
identical loss list to the postmortem experiment); post-fix 40 of 40, with a 0 ms control
arm proving the measurement.

---

## BUG-051 — Chromium segfaulted at launch in the e2e container, killing a random lane

**Symptom.** Roughly two full containerized e2e matrix runs in three (9 of 14 measured)
lost one lane: the browser process died with signal 11 at launch, before any page loaded.
Each failure claimed a different test as its victim — six failures produced six different
victims across unrelated specs — and the lane's own summary still printed "fail 0",
because the crash killed a suite-level setup hook, so subtests were reported cancelled
rather than failed.

**Root cause.** A race in glibc 2.35 (the Playwright `jammy` image's C library): reading
an environment variable is not safe against another thread writing one. `setenv`
reallocates the environ array; a concurrent `getenv` walking it can dereference freed
memory. Chromium is heavily multithreaded from early startup, which is when it fires.
Evidence: the fault address resolves inside `getenv` (173 bytes into the 229-byte
symbol); two crashes in different address-space layouts share identical low 12 bits of
the instruction pointer (same instruction, not scattered corruption); trap 13 with a
register value outside valid address space. glibc 2.39 (the `noble` image) includes the
upstream work making the read safe in these cases. Externally caused — nothing in this
project's code — recorded here per the BUG-025 precedent for external causes. Full
analysis: GitLab #54.

**Fix.** Container base switched jammy → noble in lockstep: `.gitlab-ci.yml` image,
`scripts/e2e-container.mjs`, `test/e2e/matrix-helpers.mjs` (`imageTagFromLock`), and its
unit test. Same Playwright version, same browser builds; one variable changed.

**Why it wasn't caught earlier.** Three compounding masks: the crash predated the session
that noticed it, and no baseline run existed to attribute it; the "fail 0" summary line
actively misreported a failed lane; and the failure was treated as a boolean
(`grep -c "Received signal 11"`) for several rounds of experiments instead of reading the
crash dump that contained the whole answer from its first occurrence.

**Test case.** `test/e2e-matrix-helpers.test.js` — "derives the pinned noble image from
the locked playwright version" pins the base and its comment records why it is
load-bearing. Evidence standard: 16 of 16 clean full-matrix runs post-switch against the
64% pre-switch failure rate (matched environment, one variable).

---

## BUG-050 — A failing download navigated the whole application away

**Symptom.** Caught before release, during browser verification of the folder-download
queue. A queued download whose presigned URL returned an error — a 403 from an
expired credential, a 404 from a key deleted between enumeration and issue — replaced
the running application with the bucket's error XML. The job died with it: the queue,
its progress, and the in-memory task state all went with the unmounted app. Reproduced
in Chromium, Firefox and WebKit.

**Root cause.** `issueBrowserDownload` created an `<a>` in the top-level document and
clicked it. A download only stays a download while the response carries
`Content-Disposition: attachment`. An error response does not — it is a small XML body
the browser is entitled to render — so the click stopped being a download and became a
navigation of the frame the anchor lived in, which was the application's own document.

The `download` attribute could not have prevented it: presigned S3 URLs are
cross-origin, and MDN is explicit that `download` "only works for same-origin URLs, or
the `blob:` and `data:` schemes".

**Fix.** `src/lib/download-issue.js` now loads the URL in one hidden, reused iframe
instead. A real download is still taken over by the download manager; an error renders
into a frame nobody sees. The frame is found by id rather than held in a module
variable, so a wiped DOM re-creates it instead of issuing into a detached node, and one
frame is reused because a job can be thousands of files. No `sandbox` attribute: it
blocks downloads outright without `allow-downloads`, and the configuration proven in
all three engines was a plain hidden frame (see BUG-038 for the local precedent of a
sandbox value breaking one engine).

**Why it wasn't caught earlier.** Nothing in the suite can navigate. Unit and component
tests run under jsdom, which does not implement navigation — it prints "Not implemented:
navigation to another Document" and continues, so the anchor's own behaviour was
invisible. The existing download e2e asserted that a correctly signed request went out
and returned the right bytes, which it did; the defect was entirely in what the browser
then did with a response that was *not* a success. It needed a real engine, the built
bundle, and an error status at the same time.

**Test case.** `test/e2e/browser/download-navigation.test.mjs` — "an error response
renders into the hidden frame, not the top frame": serves a 404 for `GetObject`, runs a
folder download, and asserts `page.url()` is unchanged, `#app` is still mounted, and
exactly one frame exists.

Proven by a matched pair on identical lanes, one variable changed — the pre-fix
`download-issue.js` restored from HEAD, then the fix put back:

| | pre-fix | post-fix |
|---|---|---|
| chromium / firefox / webkit × desktop | 0 of 3 lanes pass | 3 of 3 pass |
| `navigated to "…/dl/a.txt?X-Amz-…"` in the log | 3 (one per lane) | 0 |

Every engine ran in `mcr.microsoft.com/playwright:v1.60.0-jammy` (playwright 1.60.0;
chromium 148.0.7778.96, firefox 150.0.2, webkit 26.4). Uniform containerised execution
is deliberate and is the project's recorded methodology — see
`docs/review-download-parity/README.md`: "All three engines run in one container so no
engine is special-cased." Mixed native/containerised execution is listed in that
report's errata as a superseded method; a result obtained that way is not comparable
across engines.

The full 3×3 matrix (3 engines × desktop/Pixel 5/iPhone 13) is green with this spec
included: 42 tests per browser lane, 0 failed, 0 skipped.

`test/components/download-issue.test.jsx` covers frame reuse and re-creation under
jsdom, and is explicitly documented as *not* proof of the fix — jsdom cannot navigate.

---

## BUG-049 — Downloaded files were saved with percent-encoded names

**Symptom.** Downloading a file called `my file.jpg` saved it to disk as
`my%20file.jpg`. Any name containing a space, an accent, or most punctuation was
mangled the same way — `café.txt` became `caf%C3%A9.txt`. Live in production on
every download path: the per-row download in `Browser.jsx`, the duplicate-finder
row action in `DuplicatesModal.jsx`, and (newly) the Stage 2 download queue.

**Root cause.** All three call sites built the header as
`` `attachment; filename="${encodeURIComponent(name)}"` ``. `encodeURIComponent`
is for URL components; inside an HTTP quoted-string parameter nothing decodes it,
so the browser faithfully saved the literal percent-encoded text.

The reason this mattered at all is subtler than it looks. MDN states the
`download` attribute "only works for same-origin URLs, or the `blob:` and `data:`
schemes" — and presigned S3 URLs are cross-origin. So `a.download = leafName(key)`
was inert in **every** engine, and `Content-Disposition` was the only thing naming
the file. (This also corrects BUG-041, which recorded the ignored `download`
attribute as a WebKit quirk; it is spec-conformant behaviour everywhere.)

**Fix.** One tested helper, `contentDispositionAttachment()` in
`src/lib/presign-params.js`, emitting the two parameters RFC 6266 asks for: an
ASCII-only `filename="…"` fallback with `"` and `\` neutralised, plus
`filename*=UTF-8''…` carrying the real name percent-encoded per RFC 5987 —
including `*`, `'`, `(` and `)`, which `encodeURIComponent` leaves alone but
`attr-char` forbids. CR/LF are stripped so a key can never inject a second header.
All three call sites now presign through `presignDownloadParams()`.

**Why it wasn't caught earlier.** Nothing ever inspected the emitted header. The
existing download e2e spec asserts the *request* — that a correctly signed GET
goes out and returns the right bytes — which it did. The defect lived entirely in
a response header nobody read, and the saved filename is invisible to a test that
never touches the filesystem.

**Test case.** `test/presign-params.test.js` → the
`contentDispositionAttachment` suite: a space stays a space in the fallback and
becomes `%20` only in the ext-value; non-ASCII gets an ASCII fallback; `*'()` are
encoded; a `"` cannot terminate the parameter; CR/LF cannot inject a header. Plus
`test/source-invariants.test.js` → "download call sites use the shared presign
helper", which fails if any call site hand-rolls an attachment disposition again.

---

## BUG-048 — A regex written with raw control bytes blanked the whole app in the bundle

**Symptom.** Caught before release, during browser verification of the download
worklist. Every unit and component test passed (1,206 + 436), the build reported
success, and `dist/index.html` was produced — but loading it rendered nothing at
all. The console showed a single error at module load:
`Invalid regular expression: /[�-\u001F]/g: Range out of order in character
class`.

**Root cause.** `src/lib/download-naming.js` strips control characters from S3
keys before they become filenames. The character class was written with *literal*
control bytes rather than escape sequences — the file genuinely contained a NUL
byte, `0x1F`, and `0x7F` — because they are invisible in an editor and I did not
notice writing them.

Node read that source directly and formed a perfectly valid range, which is why
the whole test suite passed. esbuild, bundling the same file, could not carry a
raw NUL through its output and emitted U+FFFD in its place. The class became
`[�-\u001F]`, an inverted range, which throws at parse time. Because it is a
module-level `const`, the throw happened during module evaluation, so the entire
app failed to mount — a blank page, not a degraded feature.

**Fix.** One line in `src/lib/download-naming.js`: write the class as
`/[\u0000-\u001F\u007F]/g`. The behaviour is identical; only the source encoding
changes. The same literal bytes were also removed from
`test/download-naming.test.js`.

**Why it wasn't caught earlier.** The failure lives exactly in the gap between the
two things the test suite checks. Unit tests import source through Node, which
handles the raw bytes fine. Build tests assert on structure and version metadata,
not on whether the bundle *evaluates*. Nothing executed the bundled JavaScript, so
a bug that only exists after bundling was invisible to every automated check. It
surfaced only when the real `dist/index.html` was loaded in a real browser.

**Test case.** `test/source-invariants.test.js` → "no source file contains raw
control characters": walks `src/` and fails on any byte below `0x20` (other than
newline and tab) or `0x7F`. This is the cheap, general guard — it catches the
whole class rather than this one regex, and raw control bytes have no legitimate
place in this codebase's source anyway.

**Recurrence, in this entry itself (2026-07-31).** Control bytes above are now
written as backslash-`u` escape sequences. They were originally *literal* bytes
— this entry documented the mistake by committing it, and the "Fix" line quoted
the corrected regex using the very bytes the fix replaced, so it misrepresented
the one-line change it was describing.

The consequence was not cosmetic. A NUL makes `file` report BUG-LOG.md as
`data`, and any search that skips binary files then reports **no match, exit
code 1** — indistinguishable from a genuine absence — for strings this file
plainly contains. Verified: `/usr/bin/grep -c BUG-048 BUG-LOG.md` printed `1`
while a `-I`-passing ugrep printed nothing and exited 1. This log was therefore
unsearchable by any such tool for as long as those bytes were present, which
matters because CLAUDE.md directs readers to consult it *first* when writing
tests. The guard above did not catch it: it walks `src/` and only matches
`.js`/`.jsx`/`.css`, so Markdown was never in scope.

---

## BUG-047 — A share link does nothing when Bucketer is already open

**Symptom.** Reported in production. Opening a connection share link
(`#endpoint=…&bucket=…&keyId=…`) in a tab that already had Bucketer loaded left
the connect form completely empty, while the banner above it claimed "Endpoint
and bucket pre-filled from URL". Pressing Enter on the URL again did not help.
Only a hard reload worked.

**Root cause.** A URL differing only in its fragment — or identical to the
current one — is a *same-document navigation*. The browser does not reload, so
`readUrlParams()`, which `App.jsx` calls once in the `credentials` initializer
and once for `urlHadKeyId`, never ran again. Nothing anywhere listened for
`hashchange`; `Browser.jsx` listened for `popstate` but only to read the `prefix`
param for folder navigation.

This is sharper for Bucketer than for most apps: every deep-link parameter lives
in the fragment deliberately, so it never reaches a server (REQ-5). The
consequence is that *every* share link opened in an already-loaded tab is a
same-document navigation — the failure is the normal case, not an edge case.

The contradictory display came from the same hash being read at two different
times: `hasUrlParams()` runs on every render and saw the params, so the banner
appeared; `urlHadKeyId` and the form values were fixed at mount, when the hash
was different. The reporter's variant reached it via disconnect — the URL still
held the link, but `handleDisconnect` blanked the form, and re-entering that URL
could not restore it.

**Fix.** Two changes in `src/components/App.jsx`, both scoped to the
non-connected states:

1. A `hashchange` listener re-applies URL connection params, refreshes
   `urlHadKeyId`, and bumps `formResetKey` so `CredentialForm` — which reads
   `initial` only at mount — actually remounts. It ignores a hash carrying no
   connection params, so folder navigation's `#prefix=` rewrites are inert.
2. `handleDisconnect` merges `readUrlParams()` over the values it restores rather
   than blanking them, and forces the same remount only when the URL supplied
   something, leaving the ordinary disconnect path unchanged.

Scoped to disconnected/failed on purpose: `pushPrefixHistory()` only runs while
`Browser` is mounted, so there is no self-inflicted hash churn to react to, and a
pasted link must never swap the credentials of a live session out from under an
in-flight operation.

**Limit, deliberately not fixed.** Re-entering a URL *identical* to the current
one fires no event at all — not even `hashchange`. Nothing can be done from
JavaScript; the changelog says to reload. Fix 2 covers the common shape of it.

**Why it wasn't caught earlier.** Pre-existing since share links shipped;
v1.38.4 had no `hashchange` listener either, and the release that surfaced it did
not touch `url-params.js`, `CredentialForm.jsx`, or `s3-client.js`. Every test —
component and e2e — navigated to the link as a *fresh page load*, which is the
one path that works. Nothing exercised "app already loaded, then the URL
changes." My own first reproduction hit the bug exactly, and I dismissed it as a
harness artifact because it contradicted what I expected.

**Test case.** `test/components/app.test.jsx` — "a share link pasted while the
app is already open is applied": mount with an empty hash, assert the form is
empty, set the hash and dispatch `HashChangeEvent`, assert all four fields
populate. Fails against the pre-fix build. Paired with "a hashchange carrying no
connection details leaves the form alone", a guard that a `#prefix=` rewrite does
not disturb the form (passes either way — it guards the fix, it does not
reproduce the bug). `test/e2e/browser/profiles.test.mjs` — "BUG-047 — a share
link survives disconnect": in a real browser, load via a share link, connect,
disconnect, and assert endpoint/bucket/keyId survive. Fails against the pre-fix
bundle.

---

## BUG-046 — Saving a profile blanks the credential form when the storage write silently fails

**Date:** 2026-07-26

**Symptom:**
On the splash screen: type endpoint, bucket, key ID, and secret key; click "Save as profile…"; name it; click Save. In Safari private browsing, with site data blocked for the origin, or under storage quota exhaustion, the endpoint, bucket, key ID, and provider fields cleared instantly — the secret key was the only field left standing. `canSaveProfile()` then evaluated false against the now-empty fields, disabling the Save button, so the user could not even retry without retyping everything from scratch.

**Root cause:**
`handleSaveProfile` (`src/components/App.jsx`) persists a credential and a connection via `saveCredentialRecord`/`saveConnectionRecord`, both of which write through `safeSetRaw` — a wrapper that deliberately swallows `localStorage.setItem` exceptions (private browsing, blocked site data, and quota exhaustion all throw there) so the app degrades instead of crashing. After those writes, the handler re-read its own write back from storage to build the `credentials`/`liveFormData` state used to repopulate the form: `const saved = updated.find(c => c.id === id); const creds = { ...saved, secretKey: ... };`. When the write silently didn't land, `updated` (from `listResolvedConnections()`) had no matching row, `saved` was `undefined`, and `{ ...undefined }` evaluated to `{}` — collapsing `creds` to just `{ secretKey }`. `setSelectedConnectionId(id)` then changed `CredentialForm`'s `key` prop, forcing an immediate remount against that blanked `initial`. Confirmed by reading `safeSetRaw`'s try/catch (`storage.js`) and `findOrCreateCredential`/`saveConnectionRecord` (`connections.js`), which both return valid in-memory objects regardless of whether the underlying write succeeded — and by a component test that stubs the write to throw and observes the blank exactly as described.

**Fix:**
Build the post-save `credentials`/`liveFormData` object from the in-memory `cred` (returned by `findOrCreateCredential`, always defined) and `conn` (the object the handler itself constructed, always defined) instead of reading the write back from storage. The constructed shape matches `resolveConnection()`'s field set exactly (`id`, `name`, `bucket`, `capabilities`, `credentialId`, `endpoint`, `keyId`, `provider`, `regionOverride`) plus `secretKey`, so `CredentialForm` receives an identical shape whether or not the write actually landed. `capabilities` mirrors the same `existing`-based branch the handler already uses to decide whether this is a create or an update.

**Why it wasn't caught earlier:**
This handler had already been reviewed five times across the connection-model whole-branch review (the original task review, plus rounds 1–4 of the review's own fix cycle), and every pass asked "which records exist and are they consistent with each other" — never "what does this handler do when one of its own writes silently fails." The storage layer's core design (swallow write errors, degrade gracefully) is exactly what makes this module unusually prone to that class of bug: every write is a potential silent no-op, but nothing in the surrounding code is written defensively against that possibility unless someone asks the question directly. There was also zero test coverage anywhere in the suite for a throwing `localStorage` — private browsing and quota exhaustion are both hazards the codebase explicitly designs for elsewhere (`FileBanner.jsx` names private browsing directly), but no test had ever simulated the write actually failing.

**Test case:**
`test/components/app.test.jsx` — "App — a storage write that silently fails does not blank the form (BUG-046)": stubs `Object.getPrototypeOf(localStorage).setItem` (not the instance property — jsdom's `Storage` is a legacy platform object where instance-level assignment silently stores a literal key named `"setItem"` instead of overriding the method, confirmed by direct experiment) to throw, drives the splash form and the ProfilePicker "Save as profile…" flow, and asserts the endpoint/bucket/key-ID inputs still hold their typed values afterward. Fails against the pre-fix commit with the endpoint reading back as `''`; passes after. Restores the prototype method in `finally`, since the stub sits on state shared by every other test in the file.

---

## BUG-045 — Deleting a connection resurrects it as a phantom on the next reload

**Date:** 2026-07-26

**Symptom:**
On the `connection-model` branch, deleting a saved connection did not stay deleted. The most ordinary sequence reproduced it: connect to a bucket, save the connection under a name (e.g. "My Bucket"), delete it, reload the page. The connection reappeared under a new, auto-generated id and a generic auto-generated name instead of the one the user had given it — the delete silently didn't stick.

**Root cause:**
Three successive attempts at the surrounding migration logic each answered the same underlying question — "is this user already on the connection model, so the legacy flat-key migration chain should not run?" — by *deriving* it from mutable evidence instead of *recording* it as a fact:

1. The original form of this class of bug: `migrateProfilesToConnections()` used `connections.length > 0` as its "already migrated" sentinel. Deleting the last connection emptied the list, making the next mount look "unmigrated" and resurrect every deleted connection from the never-deleted `s3b_profiles` record. Fixed by introducing an explicit `s3b_connections_migrated` marker for *that* function's own guard.
2. `migrateProfilesFromLegacy()` was then wired in ahead of `migrateProfilesToConnections()` to restore migration for users who never reached the `s3b_profiles` stage. Gating it on the marker alone broke for a connection created via `handleSaveProfile` (which never sets the marker) once the user reloaded before ever triggering a real migration — same resurrection, different trigger.
3. `hasMigratedConnections()` was widened to `marker set OR connections.length > 0`, fixing case 2 — but the `connections.length > 0` arm reintroduced exactly the same conflation as the original bug, one level up: `deleteConnectionRecord` empties the connection list, so deleting the *only* connection a user had ever saved (regardless of whether the marker had ever been set) flipped this predicate back to `false`, and the legacy chain resurrected it from the flat credential keys `saveCredentials()` leaves behind on every connect.

Confirmed via a reproduction script and an automated test (`test/components/app.test.jsx`, "F1 round 4"): fresh install → connect → save a connection → delete it → reload produced a new connection with a fresh id and a generated name in place of the deleted one.

**Fix:**
Stopped deriving the fact and started recording it. `saveConnectionRecord()` (`src/lib/connections.js`) now sets the `s3b_connections_migrated` marker itself, unconditionally, the instant any connection is created — whether by `migrateProfilesToConnections()`'s conversion loop or by `handleSaveProfile`. `hasMigratedConnections()` still checks the marker first and falls back to `connections.length > 0` only for records written by a build predating this fix; that fallback is documented as non-monotonic (it can flip back to `false` after a delete) precisely so a future change doesn't rely on it as authoritative. `migrateProfilesToConnections()`'s own guard is untouched and stays marker-only.

**Why it wasn't caught earlier:**
Every unit test in the suite exercised a single function or a single mount in isolation. This class of bug lives entirely in a *sequence* — connect, then save, then delete, then reload — spanning three functions across two modules and a component's mount effect. No single-function test can see a predicate that is correct at every point it's checked in isolation but wrong once the operations are composed in the order a real user performs them. Three rounds of code review each caught the case immediately in front of them (missing-case reviews) rather than the structural pattern (a derived, non-monotonic predicate standing in for a recorded fact) until an adversarial fourth-round review looked for the pattern itself instead of another missing case.

**Test case:**
`test/components/app.test.jsx` — "App — a deleted connection does not resurrect after this sequence: connect, save, delete, reload (Finding A, F1 round 4)": seeds live flat credential keys, saves a real connection via `saveConnectionRecord`, deletes it via `deleteConnectionRecord`, mounts `App` once (the actual mount-effect ordering), and asserts the connection list stays empty and no phantom `s3b_profiles` record is written. Failed against the pre-fix commit (`5797003`) with a resurrected connection; passes after.
`test/connections.test.js` — `hasMigratedConnections` describe block: direct unit coverage of both arms of the predicate (marker-only, connections-only, neither, and an orphaned connection whose raw record counts even though the resolved view filters it out) — previously had no direct test at all, which is how the predicate passed review three times without one.

---

## BUG-044 — In-app changelog truncates every wrapped bullet (#50)

**Date:** 2026-07-26

**Symptom:**
The ChangelogModal showed each release's bullets cut off at their first physical line — e.g. the v1.38.0 bullet ended mid-parenthetical at "(connect screen,". All 128 entries were affected; ~20 KB of changelog text was silently missing from the bundle.

**Root cause:**
`parseChangelog()` in `build.mjs` recognized only lines starting with `- ` (bullets) or `**…**` (group headers). A bullet wrapped across multiple physical lines — the normal formatting for every long CHANGELOG.md entry — had its indented continuation lines match neither pattern, so they were dropped. `src/lib/changelog.js` is generated from this parse, and the modal renders the generated data.

**Fix (v1.38.2):**
Continuation lines (non-empty, not a bullet, not a group header, not a `---` rule) now append to the most recent bullet, joined with a space and with the same backtick stripping. Fix is in the parser, so a rebuild repairs the entire history at once.

**Why it wasn't caught earlier:**
The generated file *looked* complete — every bullet was present, just truncated — and no test compared the generated text against the source CHANGELOG.md content. Existing changelog tests asserted structure (version/date/entry presence), not fidelity. Found by code review during the v1.38.0 release, when that entry's cut was unusually visible.

**Test case:**
`test/build.test.js` (#50 describe): the generated `changelog.js` entry for v1.38.1 must contain text that only exists on a continuation line (`x-amz-meta-file-mtime`) and must not end at its first physical line.

---

## BUG-043 — Setup Guide CORS command rejected by B2: wildcard in ExposeHeaders

**Date:** 2026-07-26

**Symptom:**
Copy-pasting the B2 Setup Guide's `aws s3api put-bucket-cors` command verbatim failed with `An error occurred (InvalidRequest) when calling the PutBucketCors operation: illegal '*' in an exposeHeaders value.` Reported live by the operator while configuring a newly created B2 bucket — the guide's command was unusable on the provider Bucketer targets most.

**Root cause:**
`corsJson()` in `src/lib/cors-config.js` emitted `x-amz-meta-*` in `ExposeHeaders` unconditionally (added by BUG-028 so stored object metadata is readable from the browser). B2 permits wildcards in `allowedHeaders` but rejects them in `exposeHeaders`; AWS S3 accepts both, which is why the config validated there. Confirmed by the live PutBucketCors error against `s3.us-west-000.backblazeb2.com`.

**Fix (v1.38.1):**
`corsJson(origin, provider)` is now provider-aware: for `PROVIDERS.B2` it replaces the `x-amz-meta-*` wildcard with the explicit meta headers the app reads — `x-amz-meta-${CONTENT_HASH_KEY}` and `x-amz-meta-${FILE_MTIME_KEY}` (derived from constants so they cannot drift). All other providers keep the wildcard, since Browser's metadata panel displays arbitrary `x-amz-meta-*` keys and the move pipeline preserves `head.Metadata`, both of which need the wildcard where it is legal. Known trade-off: on B2, third-party metadata beyond those two headers stays invisible to the browser (it already was — the guide's config had never applied successfully on B2).

**Why it wasn't caught earlier:**
BUG-028's fix was validated against providers that accept the wildcard; no test executed the generated config against a real B2 `PutBucketCors`, and the unit tests asserted the wildcard's *presence* (the BUG-028 regression test) but nothing about per-provider legality. The e2e mock S3 server does not model provider-specific CORS-rule validation.

**Test case:**
`test/cors-config.test.js` (BUG-043 describe): for provider `'b2'`, no `ExposeHeaders` value may contain `*`, and both explicit meta headers must be present; non-B2 providers must retain `x-amz-meta-*` (BUG-028 preserved). `test/components/setup-guide.test.jsx`: the rendered B2 guide command contains no `x-amz-meta-*` and includes both explicit headers.

---

## BUG-042 — Mobile: long filenames push the actions column off-screen (name column cannot shrink)

**Date:** 2026-07-12

**Symptom:**
Reported from a real device (Firefox Android) reviewing v1.37.3: in the file listing, part of the rename button was cut off and the remaining per-row actions were only reachable by scrolling the table sideways — the exact symptom #49 was meant to fix, but only for rows with long filenames.

**Root cause:**
The desktop name-truncation treatment (`.file-name` = inline-block + `white-space: nowrap` + `max-width: 100%`) cannot shrink inside an auto-layout table: a percentage max-width is circular during table intrinsic sizing, so the name column's min-content width is the **full nowrap filename width**. One long filename (e.g. 64 chars ≈ 437px) forces the whole table to ~690px on a 393px viewport, pushing the actions column off-screen. Probe-verified **identical on Chromium and Firefox** (689 vs 690px) — an engine-neutral CSS-table property, not the suspected Gecko quirk.

**Fix (v1.37.5):**
At ≤640px, filenames wrap instead of truncating: `.col-name { overflow-wrap: anywhere; }` + `.file-name { white-space: normal; }`. `overflow-wrap: anywhere` reduces the name cell's min-content contribution to ~one character, so the table always fits; long names break (preferring hyphen/word boundaries) across lines.

**Why it wasn't caught earlier:**
Two test blind spots. (1) All #49 e2e fixtures and manual screenshots used short filenames (`reflow.txt`, `notes.txt`) — the failure needs a single filename whose nowrap width exceeds the viewport. (2) The spec's page-level guard (`document.documentElement.scrollWidth <= innerWidth`) cannot see it: an inner wrapper scrolls, not the document, so only per-button bounding-box assertions catch this class of overflow.

**Test case:**
`issue-49-mobile-actions` now seeds a 64-char filename and asserts every action button in that row has a bounding box inside the Pixel-5 viewport. Verified red on pre-fix CSS (button at x=576 on a 393px viewport) → green with the fix, on Firefox (reported engine) and Chromium.

---

## BUG-041 — Drag-drop upload dies silently when FileSystemEntry resolution fails (WebKit)

**Date:** 2026-07-12

**Symptom:**
In WebKit, drag-dropping files onto the app did nothing — no upload, no error. Surfaced as the two deterministic WebKit e2e failures (`issue-2-drop-destination`, `issue-4-refresh` part 2) that were initially skipped as "harness emulation gaps"; the containerized WebKit loop (#47) allowed a proper diagnosis, which proved the app itself was at fault.

**Root cause:**
Both drop handlers (`Browser.jsx handleTableDrop`, `useWindowDragDrop.js handleWindowDrop`) prefer the `webkitGetAsEntry()` path and fall back to `dataTransfer.files` only when **no** item yields an entry. Probed per engine: Chromium returns `null` entries for synthetic DataTransfers (→ fallback works), but WebKit returns **truthy** entries (`isFile=true`, correct name) whose `.file()` callback then errors `NotFoundError`. `collectFileEntries` skips unreadable files, resolving `[]`, and `if (fileEntries.length)` + `.catch(() => {})` swallowed the drop with no user feedback — a silent-failure path for ANY entry-resolution failure, not just synthetic drops.

**Fix (v1.37.4):**
Extracted the duplicated resolution logic into `resolveDroppedFiles(dataTransfer)` in `src/lib/file-entries.js`: entries path first (preserves folder structure), but when it yields nothing or rejects, fall back to the synchronously-snapshotted flat `dataTransfer.files` list. Both handlers now share it. Also removed the three WebKit e2e skips; B7 (presigned download) was separately rewritten to assert the app's network-level contract (presigned GET status/disposition/bytes) instead of Playwright's engine- and state-dependent `download` event — instrumentation showed WebKit ignores the cross-origin `download` attribute and, right after an upload, navigates instead of converting the `attachment` response, so the event never fires there.

**Why it wasn't caught earlier:**
The failure needed WebKit + an entries-path failure, and every failure mode was silenced (`() => resolve()` skip, `.catch(() => {})`, `if (length)`). WebKit could not run locally until #47, and once CI showed the failures they pattern-matched to "synthetic-event emulation gap" — the initial skip reasons were plausible but wrong. Only a per-engine probe of each link in the chain (constructor → items.add → DragEvent init → getAsEntry → entry.file()) isolated the real break.

**Test case:**
Unit: `test/file-entries.test.js` — `resolveDroppedFiles` falls back to `files` when a truthy entry's `.file()` errors (the exact WebKit shape), when entries are null (Chromium shape), and on degenerate inputs. Structural: `source-invariants.test.js` requires both drop handlers to use `resolveDroppedFiles`. E2E: the previously-skipped specs now run and pass on WebKit (container + CI), skip-free.

---

## BUG-040 — Mobile: file-table per-row action buttons unreachable (actions column overflow)

**Date:** 2026-07-11

**Symptom:**
On a phone viewport, the file-table actions column ran past the right edge, so the per-row buttons (properties, rename, download, copy link, move, delete) could not be tapped. Only batch selection + the toolbar worked on mobile (BUG-039 fixed those). Opening the copy-link popover from a row would also have overflowed both screen edges (~445px wide, anchored).

**Root cause:**
The table had no mobile layout: every non-name column is `white-space: nowrap`, and the six action buttons cannot wrap because JSX emits them with no whitespace between elements — inline-blocks with no text between them have no soft-wrap opportunities, so the actions cell has a fixed ~230px min width that pushed rows past a 393px viewport. The anchored popover (`right: 0`, content up to ~445px wide) is simply wider than a phone.

**Fix (v1.37.3):**
At ≤640px: hide the two Modified date columns; wrap the row's buttons in an inline `.row-actions` span that becomes a `flex-wrap` container on mobile (with `min-width: 9.5rem` on the cell) so buttons wrap 3–4 per line; enlarge tap targets; re-position the copy-link/share popover as a `position: fixed` lower-viewport sheet. `SortTh` gained a `colClass` passthrough so the Modified header is hideable by class. Desktop rendering unchanged.

**Why it wasn't caught earlier:**
Two reasons. (1) Same as BUG-039: no mobile testing existed until the cross-engine e2e matrix. (2) More subtle: the existing e2e specs click per-row buttons with `{ force: true }`, which bypasses Playwright's actionability checks — so the mobile matrix stayed green while the buttons were off-screen. Force-clicks silently mask reachability regressions.

**Test case:**
`test/e2e/browser/issue-49-mobile-actions.test.mjs` (Pixel 5 emulation): asserts no horizontal page overflow, that every file-row and folder-row action button's bounding box sits inside the viewport, per-row delete end-to-end against the mock bucket, and the copy-link popover opening within viewport bounds — all **without** `{ force: true }`. Failed before the fix (button at x=419 on a 393px viewport; popover at x=−128, w=444.75); passes after.

---

## BUG-039 — Mobile: header controls and modal buttons unreachable (no responsive layout)

**Date:** 2026-07-11

**Symptom:**
On a narrow (phone) viewport, a user could not disconnect, delete, or move: the header's Disconnect / Copy link / Find duplicates buttons ran off the right edge, and the Delete / "Move here" confirmation buttons in modals could not be tapped.

**Root cause:**
Bucketer had no responsive CSS at all (only a dark-mode media query). `.app-header` is a no-wrap flex row; on a narrow viewport its controls overflowed horizontally off-screen. That header overflow also forced the whole document wider than the viewport, which displaced the `position:fixed` centered modals so their action buttons fell outside the visual viewport — unreachable by tap (and by Playwright).

**Fix:**
Added the app's first responsive breakpoint (`@media (max-width: 640px)`): `.app-header` wraps its controls (dropping the flex spacer that would otherwise break wrapping), and `.modal-dialog` is capped to the viewport (`max-width: min(94vw, 480px)`, `max-height: 88vh`, `overflow-y: auto`) so a modal always fits and its footer stays reachable.

**Why it wasn't caught earlier:**
The app was only ever tested and used on desktop; there was no mobile/responsive e2e until the cross-engine matrix added Pixel-5 / iPhone-13 device profiles, which immediately surfaced these as 6 failing specs.

**Test case:**
The browser e2e suite under `E2E_DEVICE="Pixel 5"` / `"iPhone 13"` — batch delete/move, move-via-picker, delete, versioning delete-marker/undelete, and post-disconnect form all failed before the shell fix and pass after. Run: `E2E_ENGINE=chromium E2E_DEVICE="Pixel 5" node test/e2e/run.mjs browser` (35/35).

---

## BUG-038 — PDF preview renders blank in Firefox (sandboxed iframe blocks pdf.js)

**Date:** 2026-07-11

**Symptom:**
Previewing a PDF showed a blank preview in Firefox (desktop). It rendered fine in Chromium-based browsers. A user was confident it used to work — a regression.

**Root cause:**
PDFs preview in an `<iframe class="preview-pdf" sandbox="">` (`PreviewMedia.jsx`). An empty `sandbox=""` disables scripts in the frame. Firefox renders PDFs with its script-based **pdf.js** viewer, so with scripts blocked it cannot run and nothing renders. Chromium uses a native (non-JS) PDF viewer, so it was unaffected — which is why it went unnoticed. Introduced in v1.11.1 (commit `039599b`, "Sandbox PDF preview iframe"), which added `sandbox=""` as a security hardening; PDF preview originally shipped with no sandbox (`a6195e7`) and worked in Firefox.

**Fix:**
Change the PDF iframe to `sandbox="allow-scripts"` — enough for Firefox pdf.js to run, while still blocking same-origin access, forms, top-navigation, popups, and plugins. Safe because (1) the preview URL is presigned with `ResponseContentType: 'application/pdf'` (`usePreview.js`), so the frame is served as a PDF and never interpreted as executable HTML, and (2) there is no `allow-same-origin`, so any script runs in an opaque origin with no access to our credentials, cookies, DOM, or storage.

**Why it wasn't caught earlier:**
The v1.11.1 hardening was validated in Chromium (which renders PDFs natively regardless of the sandbox), and the existing `preview-media` component test explicitly skipped the PDF case citing a jsdom iframe concern — so no test guarded the PDF iframe. The regression was Firefox-only and there was no cross-engine e2e.

**Test case:**
`test/components/preview-media.test.jsx` — "the PDF iframe sandbox permits scripts so Firefox pdf.js can render": mounts `PreviewMedia kind="pdf"` and asserts the iframe sandbox is absent or includes `allow-scripts` (red on `sandbox=""`, green on `allow-scripts`). Plus `test/e2e/browser/pdf-preview.test.mjs` verifies the full connect→preview pipeline produces a script-permitting iframe fed a presigned PDF URL, running under Firefox as well as Chromium. (Pixel-level PDF rendering is not automatable in Playwright's bundled browsers; the definitive visual confirmation is a manual open in real Firefox.)

---

## BUG-037 — Cancelling a delete/move during its final batch group falsely reports "Cancelled"

**Date:** 2026-07-08

**Symptom:**
When the master-queue cancellation feature (v1.35.0) was first wired, a delete or move that received a cancel request while its *last* batch group was already in flight completed all its work but reported the operation as **cancelled** — the row read "Cancelled — deleted N of N" for an operation where nothing was actually skipped. Users would think objects were left behind when the operation had in fact finished cleanly.

**Root cause:**
The delete engine's batch loop checked `shouldCancel()` after each group of `CONCURRENCY` batches and, if true, set `cancelled = true` and broke. When the request arrived during the final group, the check fired after that group completed — but the loop was about to exit anyway, so `cancelled` was set despite zero remaining work. The contract is that `cancelled: true` must mean work was genuinely skipped.

**Fix:**
Guard the flag with a remaining-work check: `if (shouldCancel() && i + CONCURRENCY < batches.length) { cancelled = true; break; }`. A cancel during the final group now reports `cancelled: false` (a clean completion). The move/copy engine's per-item worker model was already correct by construction (it checks at claim time, so once all items are claimed the workers exit via the loop condition without flipping the flag).

**Why it wasn't caught earlier:**
The feature was new; the first cancellation tests only exercised a cancel arriving with multiple groups still pending (the common case), where the flag is correct. The single-group / final-group boundary is the edge that the "check after the group" structure got wrong.

**Test case:**
`test/delete-queue.test.js` — "cancel arriving during the final batch group reports cancelled=false (nothing skipped)": 2000 keys → one batch group; the cancel flag flips as soon as deletions report, but no further group exists to skip, so `done.cancelled === false` and `done.deleted === 2000`.

---

## BUG-036 — Task store notifies subscribers twice when a task with pending progress is removed

**Date:** 2026-07-08

**Symptom:**
Removing (dismissing) a master-queue task that still had a coalesced progress update pending fired the store's subscribers **twice** for one logical removal — once with the task still present (the flushed pending patch) and once with it gone. A single "Dismiss" produced two React renders; the intermediate render briefly showed the task with stale progress.

**Root cause:**
`remove(id)` calls `batcher.flush()` first (to apply any pending patches before dropping the task, so a queued patch can't resurrect a removed entry), then filters the task out and calls `emit()`. The internal `setItems` adapter passed to the update-batcher itself calls `emit()`, so when pending patches existed the flush emitted once and the subsequent filter emitted again.

**Fix:**
Add a `suppressEmit` flag set around the internal flush inside `remove()`: the pre-remove flush applies pending patches silently, and the single post-filter `emit()` is the one notification. `remove()` is one logical event and now notifies exactly once. The flag is reset before the notifying `emit()` and cannot leak (the only code between set and reset is a pure array patch-merge that cannot throw in practice).

**Why it wasn't caught earlier:**
The store was brand-new; the initial "update for a removed task is dropped" test only asserted final store contents (`get().length === 0`), never the subscriber call count, so the extra notification was invisible to it.

**Test case:**
`test/task-store.test.js` — "remove with pending updates notifies subscribers exactly once": add a task, subscribe, queue a non-urgent `update`, then `remove`; assert the subscriber received exactly `[1, 0]` (one notification for the removal, none for the flushed patch).

---

## BUG-035 — ReferenceError on multipart completion for the non-probe path (manual mode, small multipart, sharded)

**Date:** 2026-06-30

**Symptom:**
A multipart upload that did **not** run the throughput probe — manual concurrency mode, an adaptive upload with fewer than 20 parts, or the new sharded path — threw `ReferenceError: probeResolved is not defined` at the very end of `uploadMultipart`, *after* `CompleteMultipartUpload` had already succeeded. The object landed on the server but the item showed as failed.

**Root cause:**
The BUG-033 refactor (v1.29.0) restructured the concurrency block and moved `probeResolved` from an outer `let probeResolved = null;` to a `const probeResolved` scoped **inside** the `if (shouldProbe)` block. The completion annotation `return { … probeResult: probeResolved ? … : null }` still references it at function scope. When `shouldProbe` is false, that block never executes and the identifier is out of scope → ReferenceError. Shipped in v1.29.0 and v1.30.0.

**Fix:**
Restore `let probeResolved = null;` at function scope and change the inner statement to a plain assignment (`probeResolved = resolveProbe(state);`).

**Why it wasn't caught earlier:**
`npm test` (unit + component) never executes `uploadMultipart` — it is a closure inside the `UploadQueue` component that needs the full upload flow against a live/mock S3 client. Only the **browser e2e** suite exercises it, and that suite is not run by the pre-push hook (and was itself red from an unrelated stale selector, masking its value). The probe path (adaptive, ≥ 20 parts) worked, so large adaptive uploads were unaffected — which hid the bug.

**Test case:**
The browser e2e multipart path (`test/e2e/browser/*.test.mjs`) exercises `uploadMultipart` end-to-end and now passes; a minimal block-scope repro confirmed both the fault and the fix. **Prevention: run `npm run test:e2e:browser` before shipping upload-path changes** (the unit/component suites structurally cannot cover the completion path).

---

## BUG-034 — One transient network error fails an entire large upload; "Retry" then re-uploads from zero

**Date:** 2026-06-30

**Symptom:**
A 235.7 GiB upload (all parts already transferred — progress showed full size) failed at the very end with `TypeError: "NetworkError when attempting to fetch resource."` (status `null`, requestId `null`). The only recovery offered was a "Retry" button that restarts the whole upload from zero.

**Root cause:**
Two independent gaps, both surfaced once uploads got fast (16 connections, ~16 min of transfer):
1. **No transient-error retry.** Each `UploadPartCommand` and the final `CompleteMultipartUploadCommand` used a raw `client.send()`. The AWS SDK's retry classifier does not treat a browser fetch `TypeError` ("NetworkError…" / "Failed to fetch") as retryable, and the project's `sendWithRetry` (throttling-only, and unused on the upload path) didn't cover it either. So one transient blip on any of ~1,900 parts — or on the single completion call — throws straight out and fails the entire upload.
2. **Failed-upload recovery was destructive.** A failed item's "Retry" button calls `handleRestart`, which aborts the multipart session (discarding every uploaded part) and re-uploads from scratch. The resume machinery (`handleResume` + `collectParts` → upload only missing parts) existed but was wired only to the `paused` re-select flow, never to failed uploads.

**Fix:**
1. Added `isTransientNetworkError` + `isRetryableUploadError` + `withUploadRetry` (exponential backoff + jitter, abort-aware) to `s3-retry.js`, and wrapped every `UploadPart` and `CompleteMultipartUpload` send (fresh **and** resume paths) with it.
2. On a multipart, non-permission failure, attach the surviving resume record to the failed item and offer a **Resume** button (upload only the missing parts), keeping **Restart** as the secondary action.

**Why it wasn't caught earlier:**
Small/fast test uploads rarely hit a transient network error, and the upload path had no retry test. The gap only bites on long, high-throughput, many-part uploads — which became common only after the connection/concurrency fixes (BUG-033 + the browser connection cap) made uploads fast. The destructive-Retry behaviour was masked because resume "worked" via the separate re-select flow.

**Test case:**
`test/s3-retry.test.js` — `isTransientNetworkError` recognises Firefox/Chromium/Safari fetch errors and excludes `AbortError`; `withUploadRetry` retries transient errors, gives up after `maxRetries`, and does not retry non-retryable or aborted operations. `test/components/upload-queue-ui.test.jsx` — a failed item with a resume record offers Resume; without one, only Retry.

---

## BUG-033 — Large part sizes silently collapse multipart upload concurrency to 1 (fully sequential)

**Date:** 2026-06-30

**Symptom:**
Uploading a large file (e.g. 20 GB) with a configured part size of 128 MiB uploaded its parts **one network request at a time** — fully sequential — even though a higher part concurrency (8) was selected. On a fast link this pinned per-file throughput to a single stream (~20 MB/s), and choosing a *larger* part size made it worse, not better. Multipart itself worked (parts uploaded, completed, saved); only the parallelism was missing.

**Root cause:**
`uploadMultipart` (and the resume path) bound part concurrency with `capConcurrencyByMemory(requested, partSize, perFileBudget)`, where `perFileBudget = MAX_ADAPTIVE_MEMORY_BYTES / activeFiles`. `MAX_ADAPTIVE_MEMORY_BYTES` was **200 MiB**. With a 128 MiB part size and one active file, `floor(200 MiB / 128 MiB) = 1`, clamping concurrency to 1 regardless of the user's explicit setting. The cap legitimately bounds resident ArrayBuffer memory, but its default was small enough that any user-chosen part size above ~100 MiB (the UI allows up to 512 MiB) collapsed concurrency toward a single sequential stream — silently overriding the user's choice.

**Fix:**
Raised the default budget to **1 GiB** (`DEFAULT_UPLOAD_MEMORY_MB = 1024`; `MAX_ADAPTIVE_MEMORY_BYTES` now derives from it) and exposed it as a user-tunable **"Upload memory budget (MiB)"** setting (`loadUploadMemoryMB`/`saveUploadMemoryMB`, range 64–8192, default 1024). Both the fresh and resume upload paths read the configured budget. At 128 MiB parts, a 1 GiB budget allows 8 concurrent parts.

**Why it wasn't caught earlier:**
`capConcurrencyByMemory` was unit-tested only with small (5/50 MiB) part sizes against an explicit 200 MiB budget, where the cap behaves benignly. No test exercised the *default* budget against a large, user-selectable part size, so the collapse-to-1 interaction was invisible. The part-size field (up to 512 MiB) and the memory budget were never tested together. Found by a real upload on the author's own machine.

**Test case:**
`test/concurrency-strategy.test.js` — "default budget keeps large (128 MiB) parts parallel": asserts `capConcurrencyByMemory(8, 128 MiB, MAX_ADAPTIVE_MEMORY_BYTES) >= 6`. Fails at the old 200 MiB default (yields 1), passes at 1 GiB (yields 8). Plus a `test/storage.test.js` round-trip for the new accessor and a `test/components/settings-panel.test.jsx` render assertion for the field.

---

## BUG-031 — Drag-and-dropped uploads always land at the bucket root, ignoring the current folder

**Date:** 2026-06-20 · **GitLab:** #2

**Symptom:**
While viewing a nested folder, dragging files or folders from the OS onto the app uploaded them to the bucket **root** instead of the folder being viewed. Uploading via the "Choose files" button (file picker) worked correctly and targeted the current folder.

**Root cause:**
`UploadQueue.jsx` exposes its `addFiles` function to the parent once, at mount: `useEffect(() => { onMount?.({ addFiles }); }, [])`. `App.jsx` stores that reference in `addFilesRef.current`. Because the effect has `[]` deps, the captured `addFiles` closure is the **mount-time** one, which closes over the mount-time value of `destinationPrefix` state (`''` = root). Every drag-and-drop path — the window overlay (`useWindowDragDrop.handleWindowDrop`) and the table drop (`Browser.handleTableDrop`) — routes through `addFilesRef.current`, so they always computed `destinationKey = '' + relativePath` and uploaded to root regardless of navigation. The file-picker path (`<input onChange={e => addFiles(...)}>`) calls the **current render's** `addFiles`, which reads the live `destinationPrefix`, which is why that path worked.

`Browser.jsx` had already encountered and documented this exact class of bug (its `prefixRef` exists specifically so onMount-exposed actions can read the live prefix "without stale-closure bugs"); `UploadQueue` did not apply the same pattern to `destinationPrefix`.

**Fix:**
Mirror `destinationPrefix` into a ref that is reassigned every render (`destinationPrefixRef.current = destinationPrefix`) and read `destinationPrefixRef.current` when computing `destinationKey` in `addFiles`. The captured closure now always sees the current destination.

**Why it wasn't caught earlier:**
The file-picker path (the one exercised in development and in the e2e suite via `setInputFiles`) uses the fresh closure and worked. No test drove the drag-and-drop upload path (window/table drop), which is the only one that goes through the stale `addFilesRef`. Reported by a real user (GitLab #2).

**Test case:**
`test/e2e/browser/issue-2-drop-destination.test.mjs` — navigate into `sub/`, dispatch a synthetic file `drop` on the Browser drop container (the `e.dataTransfer.files` fallback the OS uses), assert the object lands at `sub/dropped.txt`, never at the root. Verified to fail against the stale-closure version and pass with the ref.

---

## BUG-032 — A sub-folder created by an upload into the current view doesn't appear until reload

**Date:** 2026-06-20 · **GitLab:** #4 (part 2)

**Symptom:**
Uploading content that creates a **new sub-folder** in the folder you're currently viewing (e.g. dragging a folder `test/` into the current directory) did not show the new folder in the listing until the page was manually reloaded.

**Root cause:**
After an upload batch drains, `UploadQueue` passes the set of parent prefixes that received files to `Browser.onUploadsDrained`. That handler refetched the current listing only when the set contained the current prefix **exactly**: `if (prefixSet.has(prefixRef.current)) fetchPage(...)`. When an upload creates a sub-folder, the drained prefix is the **new sub-prefix** (e.g. `test/`), not the current view (e.g. `''`). The exact-match test failed, so the current listing was never refetched and the new `test/` folder (a `CommonPrefix`) never appeared until a reload re-listed.

**Fix:**
Refetch the current view when any drained prefix is the current prefix **or a descendant of it** — `[...prefixSet].some(p => p.startsWith(cur))` — and `invalidateCache(cur)` before the refetch so a still-valid cache entry isn't served stale.

**Why it wasn't caught earlier:**
The BUG-029 fix (which introduced `onUploadsDrained`) was exercised by uploading files *directly into* the current view (drained prefix == current), which the exact match handled. The sub-folder case (drained prefix is a descendant) was never tested. Compounded in the wild by BUG-031 (the upload often went to root entirely). Reported by a real user (GitLab #4).

**Test case:**
`test/e2e/browser/issue-4-refresh.test.mjs` — at root, drop a file with relativePath `newdir/x.txt`, assert the `newdir` folder row appears without a reload. Verified to fail against the exact-match version and pass with the descendant check. The same file also covers the existing manual **Refresh** control pulling an out-of-band (other-device) write.

## BUG-030 — Clicking a file's checkbox did not select the file (double-toggle no-op)

**Date:** 2026-06-20

**Symptom:**
In the file browser, clicking the checkbox on a **file** row did nothing — the row did not become selected and the batch action bar did not appear. Selecting a file only worked by clicking the surrounding cell padding, not the checkbox itself. Folder-row checkboxes worked correctly. Discovered while writing the e2e batch-selection tests: Playwright reported "clicking the checkbox did not change its state."

**Root cause:**
The file-row checkbox cell wires the toggle on **both** the `<td>` and the `<input>`:

```jsx
<td class="col-check" onClick={e => toggleSelect(obj.Key, e)}>
  <input type="checkbox" checked={isSelected} onChange={e => toggleSelect(obj.Key, e)} />
</td>
```

Clicking the checkbox fires the input's `onChange` (toggle #1) **and** the click bubbles to the `<td>`'s `onClick` (toggle #2). The two `setSelectedKeys` functional updates cancel out — net no change. `toggleSelect` calls `e.stopPropagation()`, but that does not prevent the already-dispatched `change` handler from also running. The **folder** row was correct because its input carried `onClick={e => e.stopPropagation()}`, which prevents the click from reaching the `<td>` — so only one toggle fires. The file row was missing that guard.

**Fix:**
Add `onClick={e => e.stopPropagation()}` to the file-row checkbox input, matching the folder row:

```jsx
<input type="checkbox" checked={isSelected} onChange={e => toggleSelect(obj.Key, e)} onClick={e => e.stopPropagation()} />
```

Clicking the checkbox now fires `onChange` once and the click no longer bubbles to the cell — a single toggle. Clicking the cell padding (which does not hit the input) still toggles via the `<td>` handler.

**Why it wasn't caught earlier:**
No test exercised checkbox selection — component tests asserted on rendered structure, and the earlier e2e flows selected rows via action buttons, not checkboxes. The bug is also partially masked in manual use: clicking the cell area around the checkbox works, so a user who clicks slightly off-target sees selection succeed and may not notice that the checkbox glyph itself is dead.

**Test case:**
e2e (`test/e2e/browser/batch.test.mjs`): after upload, check a file row's checkbox and assert the row gains `file-row-selected` and the batch bar appears; batch-delete/move of multiple selected files reflects in real bucket state.

## BUG-029 — Upload completion teleports user to bucket root

**Date:** 2026-06-16

**Symptom:**
After uploading any file or batch of files into a subfolder, the file browser would jump back to the bucket root once the queue drained. The URL hash `?prefix=...` was wiped (via `replaceState`, so the back button did not restore the previous view), and any in-progress selection or filter was cleared. The behaviour was the same regardless of where the user had navigated *to* during the upload — uploading into `a/` then navigating to `b/` mid-upload still ended at root, not at `b/` and not at `a/`.

**Root cause:**
`App.jsx` wired `onUploadsComplete={() => setBrowserKey(k => k + 1)}` on `<UploadQueue/>`. Incrementing `browserKey` changed the `key` prop on `<Browser/>`, which forced Preact to unmount and remount the component. The remounted Browser initialised `prefix` from this branch:

```js
const [prefix, setPrefix] = useState(() => {
  if (isFirstMount) return URL_HASH_PREFIX_OR_EMPTY;
  return '';
});
```

`isFirstMount` is `browserKey === 0` — false on any remount. So the new instance always started at root, then `navigateTo('', { historyMode: 'replace' })` ran in the initial-load effect, which wiped the URL hash prefix and fetched the root listing. The remount-on-key-change mechanism was intended for genuine reset events (reconnect, disconnect, refresh-permissions); reusing it for "the upload queue drained" was overkill and surprising.

The mechanism was probably picked because it conveniently invalidates the in-memory listing cache as a side effect of unmounting. A targeted invalidate-and-refetch was already available — `handleRefresh()` and the post-rename path both use `invalidateCache(prefix); fetchPage(prefix, null, true);` — but `onUploadsComplete` did not use it.

**Fix:**
Three coordinated changes:

- `UploadQueue.jsx` accumulates the parent prefix of every successful upload in a `drainedPrefixesRef = useRef(new Set())`. When the queue drains, the ref's `Set` is passed to `onUploadsComplete(drainedSet)` and reset.
- `Browser.jsx` exposes a new action `onUploadsDrained(prefixSet)` via the `onMount` payload. It invalidates the cache entry for each affected prefix (so a later navigation back picks up the new files), and refetches the current listing only if `prefixRef.current` (a live mirror of `prefix`) is in the set.
- `App.jsx` rewires `onUploadsComplete={(prefixSet) => browserActionsRef.current?.onUploadsDrained?.(prefixSet)}`. The `setBrowserKey(k => k + 1)` call is gone.

Net effect: the user stays exactly where they are. If they were in the upload target, the listing refreshes in place. If they navigated away, only the cache for the affected prefix is invalidated — no network traffic, no visible change, and the cached stale listing is rebuilt on next visit.

**Why it wasn't caught earlier:**
- The reset-to-root behaviour worked "correctly enough" for the common case where the user uploads into a folder, watches it finish, and was about to refresh anyway. The bug only surfaces when the user navigates away mid-upload, or cares about retaining selection / filter / URL state across an upload.
- No test covered the upload → navigation interaction. Component tests stop at single-component boundaries; the App-level integration was implicit.
- The reset was buried two levels of indirection deep (`setBrowserKey` → `key={browserKey}` → `isFirstMount={browserKey === 0}` → initial-state branch in Browser) and looked like normal reconnect handling at each layer.

**Test case:**
A source-invariant assertion that `App.jsx`'s `onUploadsComplete` handler does NOT call `setBrowserKey` and DOES delegate to `browserActionsRef.current.onUploadsDrained`. Plus structural checks that `UploadQueue.jsx` accumulates parent prefixes per success and passes them to the drain callback, and that `Browser.jsx` exposes `onUploadsDrained` via `onMount`. These prevent re-introducing the remount lever for this code path without forcing the test author to also think about the prefix/selection/URL reset side effects. See `test/source-invariants.test.js` describes under "BUG-029".

---

## BUG-028 — Custom object metadata invisible to browser despite being stored on S3

**Date:** 2026-06-12

**Symptom:**
After uploading a file to Wasabi, the "File Modified" column and properties modal showed no original modification time even though the upload succeeded. The DownloadPage also showed nothing. The metadata appeared never to have been stored, but checking via server-side tools confirmed `x-amz-meta-file-mtime` was present on the object.

**Root cause:**
The CORS `ExposeHeaders` list in `corsJson()` did not include `x-amz-meta-*`. Browsers silently strip response headers not listed in `ExposeHeaders` before JavaScript can read them — this is standard CORS behaviour. The AWS SDK v3 builds `head.Metadata` by reading `x-amz-meta-*` headers from the HeadObject response; with those headers stripped, `head.Metadata` was always `{}` from the browser's perspective, making all stored custom metadata invisible. The `fetch()` call in DownloadPage suffered the same block: `response.headers.get('x-amz-meta-file-mtime')` always returned `null`.

The upload side was unaffected: `AllowedHeaders` already contained `x-amz-*`, which covers `x-amz-meta-file-mtime` as a request header, so the preflight allowed the upload and the metadata was stored correctly.

**Fix:**
Add `'x-amz-meta-*'` to `ExposeHeaders` in `corsJson()` (`src/lib/cors-config.js`). Existing bucket owners must re-apply the CORS configuration (re-run the CORS command from the Setup guide) to pick up the change.

**Why it wasn't caught earlier:**
`ExposeHeaders` is easy to overlook because the upload path (controlled by `AllowedHeaders`) and the read path (controlled by `ExposeHeaders`) are separate concerns. The feature was tested by verifying the metadata was set on upload (correct) and displayed by HeadObject in Node.js (correct), but never tested in a real browser against a cross-origin bucket, where the CORS filter applies. The `cors-config.test.js` suite tested `ExposeHeaders` for `ETag`, `Content-Length`, and `Content-Type` but had no assertion about custom metadata headers.

**Test case:**
`test/cors-config.test.js` — "exposes x-amz-meta-* so custom object metadata is readable from the browser": asserts `x-amz-meta-*` is present in `ExposeHeaders`.

---

## BUG-001 — `$` special patterns in minified bundle corrupted build output

**Date:** 2026-05-21
**Commit:** `3497da5`

**Symptom:**
Built `dist/index.html` was malformed. Fragments of the HTML template appeared in the middle of the JS bundle output, or the bundle was truncated.

**Root cause:**
`String.prototype.replace()` treats certain `$` sequences in the replacement string specially: `$&` (full match), `$'` (string after match), `` $` `` (string before match), `$1`–`$9` (capture groups). The minified JS bundle contains these sequences naturally. Passing the bundle as a string literal to `.replace()` caused the HTML template to be spliced into the JS content.

**Fix:**
Pass a function as the replacement argument instead of a string. Functions disable all `$` interpretation.

```js
// Before (broken):
html.replace('<!-- BUNDLE_PLACEHOLDER -->', `<style>${css}</style><script>${js}</script>`);

// After (correct):
html.replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);
```

**Why it wasn't caught earlier:**
Only manifests with minified output. Development builds (`--dev`) skip minification and produce JS without `$`-heavy patterns, so the bug was invisible during development and only appeared in production builds.

**Test case:**
Build pipeline test: assert that `dist/index.html` contains a single `<script>` tag, that its content starts with the expected IIFE wrapper, and that the HTML surrounding it is intact. Can be run as a post-build assertion rather than a unit test.

**Coverage:** `test/build.test.js` — "Build output — BUG-001 (placeholder replacement)" suite.

---

## BUG-002 — esbuild defaulted to React JSX transform; app failed to render

**Date:** 2026-05-21
**Commit:** `3c49e7d`

**Symptom:**
App rendered a blank page. Console showed `ReferenceError: React is not defined`.

**Root cause:**
esbuild's default JSX transform compiles `<Component />` to `React.createElement(Component, ...)`. The project uses Preact, not React. `React` was not in scope, so every JSX expression threw immediately at runtime.

**Fix:**
Configure esbuild with `jsx: 'automatic'` and `jsxImportSource: 'preact'`, which imports from `preact/jsx-runtime` automatically.

**Why it wasn't caught earlier:**
First-time configuration error before any tests existed. Manifested immediately on first run.

**Test case:**
Build output should not contain the string `React.createElement`. The bundle should reference `preact` in its import map. Verifiable as a post-build string assertion.

**Coverage:** `test/build.test.js` — "Build output — BUG-002 (Preact JSX transform)" suite.

---

## BUG-003 — Small-file uploads failed with TypeError in AWS SDK browser handler

**Date:** 2026-05-22
**Commit:** `b231890`

**Symptom:**
All file uploads below 5 MB failed with a `TypeError`. Multipart uploads (≥ 5 MB) worked correctly.

**Root cause:**
The AWS SDK v3 browser fetch handler calls `.getReader()` on the `Body` parameter, expecting a `ReadableStream`. `File` and `Blob` objects do not have `.getReader()`. The small-file path passed the `File` object directly; the multipart path was already converting each part chunk via `.arrayBuffer()` to a raw buffer, which the SDK handles correctly.

**Fix:**
Convert the file to `Uint8Array` before passing it to `PutObjectCommand`:
```js
const body = new Uint8Array(await file.arrayBuffer());
```

**Why it wasn't caught earlier:**
The multipart path (≥ 5 MB) worked because it already did the conversion per part. The inconsistency between the two upload paths wasn't visible until small-file uploads were tested against a real bucket.

**Test case:**
Unit test for `uploadSmall`: mock the S3 client and assert that the `Body` passed to `PutObjectCommand` is a `Uint8Array`, not a `File` or `Blob`.

**Coverage:** `test/calc-part-size.test.js` — "preparePutBody" suite. The conversion is extracted to `preparePutBody()` in `src/lib/upload-queue.js`; tests assert the result is a `Uint8Array`, never a `Blob`, and that content and empty-file cases are correct.

---

## BUG-004 — Folder picker silently opened in plain file mode (Preact JSX + `webkitdirectory`)

**Date:** 2026-05-22
**Commit:** `ea57ecf`

**Symptom:**
Clicking "Choose folder" opened the OS file picker in single-file mode rather than folder selection mode.

**Root cause:**
Preact does not reliably forward non-standard boolean attributes like `webkitdirectory=""` through its JSX prop system to the underlying DOM element. The attribute was being silently dropped, so the `<input>` element never received it.

**Fix:**
Set the property directly on the DOM element via a ref callback:
```js
ref={(el) => { folderInputRef.current = el; if (el) el.webkitdirectory = true; }}
```

**Why it wasn't caught earlier:**
The JSX looked correct and raised no errors. The failure was silent — the picker just opened in the wrong mode. No console warning, no exception. Required manual testing of the folder pick flow to observe.

**Test case:**
Integration/smoke test: mount `UploadQueue`, query the folder input element, and assert `el.webkitdirectory === true`. Verifies that the property reaches the DOM regardless of JSX handling.

**Coverage:** None — requires DOM/jsdom environment to query real element properties. No automated test exists; the fix is verified by manual interaction with the folder picker.

---

## BUG-005 — Click conflicts between upload buttons and drop zone

**Date:** 2026-05-22
**Commit:** `09d6a5a`

**Symptom:**
Clicking "Choose files" or "Choose folder" also triggered the drop zone's click handler. `stopPropagation()` was not sufficient to prevent the conflict.

**Root cause:**
The buttons were nested inside the drop zone `<div>`. The event propagation path meant that even with `stopPropagation()` on the buttons, the DOM structure created implicit coupling between the button clicks and the zone's own handlers.

**Fix:**
Move the buttons outside the drop zone `<div>` entirely. The drop zone becomes a pure drag target with no click handler; each button owns its own interaction independently.

**Why it wasn't caught earlier:**
The initial structure seemed logical — upload controls grouped visually with the drop zone. The event conflict only became apparent during interactive testing.

**Test case:**
Verify DOM structure: assert that the "Choose files" and "Choose folder" buttons are not descendants of the drop zone element.

**Coverage:** None — requires DOM/jsdom to inspect element ancestry. No automated test exists; the fix is verified by code review of the component structure.

---

## BUG-006 — Copy button in SetupGuide submitted parent credential form

**Date:** 2026-05-21
**Commit:** `631d2c6`

**Symptom:**
Clicking the "Copy" button on a code block in the CORS setup guide triggered a connection attempt, as if the Connect button had been clicked.

**Root cause:**
The copy button was inside a `<form>` element (the credential form). HTML buttons default to `type="submit"` when no `type` attribute is set. Clicking the button submitted the form.

**Fix:**
Add `type="button"` to the copy button.

**Why it wasn't caught earlier:**
The default `type="submit"` behavior is easy to miss because buttons look and feel interactive regardless. Only manifested when the setup guide was rendered inside the credential form context.

**Test case:**
Assert that every `<button>` element inside `SetupGuide` has an explicit `type` attribute. No button inside a form should rely on the default.

**Coverage:** `test/source-invariants.test.js` — "SetupGuide — every `<button>` has explicit type (BUG-006)". Reads SetupGuide.jsx source directly and fails if any `<button>` is missing a `type=` attribute.

---

## BUG-007 — `ListParts` pagination incomplete in resume flow

**Date:** 2026-05-21
**Commit:** `c8d26d2`

**Symptom:**
For files larger than approximately 5 GB (> 1000 parts at 5 MB each), resuming an interrupted upload would re-upload already-completed parts and then fail at `CompleteMultipartUpload`.

**Root cause:**
`ListParts` paginates at 1000 parts per response. The resume flow fetched only the first page, missing all completed parts beyond part 1000. When uploading remaining parts, the "remaining" set included parts that were actually already done. `CompleteMultipartUpload` then received a malformed parts list (duplicate or inconsistent ETags) and failed.

**Fix:**
Loop `ListParts` until `IsTruncated` is false, accumulating all completed parts before computing what remains.

**Why it wasn't caught earlier:**
Requires a file > 5 GB with default 5 MB parts (> 1000 parts) to trigger. Not exercised in normal development testing. The failure mode was also non-obvious — the symptom looked like a `CompleteMultipartUpload` bug rather than a missing-pagination bug.

**Test case:**
Unit test for the resume flow: mock `ListParts` to return two pages (IsTruncated=true on first call, false on second), assert that `UploadPartCommand` is only called for part numbers not present across both pages.

**Coverage:** `test/collect-parts.test.js` — "collectParts — pagination" suite tests the extracted `collectParts()` function with mock clients for two-page and three-page responses.

---

## BUG-008 — Content hash not persisted in resume record (ordering bug)

**Date:** 2026-05-21
**Commit:** `7769395`

**Symptom:**
Resume hash verification was silently skipped on every resume attempt, even when a hash should have been present. File identity checks fell back to name/size/lastModified only.

**Root cause:**
The content hash was being computed *after* `saveResumeRecord()` was called. The record was saved without the hash, and the async hash computation result was never written back. The code read as if the hash was included, but the ordering meant it never was.

**Fix:**
Compute the hash before calling `saveResumeRecord()`, so the field is populated when the record is written.

**Why it wasn't caught earlier:**
The code path looked correct at a glance — `computeFileHash` was called nearby and its result assigned to `fileIdentity.contentHash`. The async ordering bug was subtle. No error was thrown; hash verification was just silently absent.

**Test case:**
After calling the upload initiation flow with a mock file, load the resume record from IndexedDB and assert that `fileIdentity.contentHash` is present and non-null.

**Coverage:** `test/indexeddb-storage.test.js` — "buildFileIdentityWithHash" suite verifies that `contentHash` is present, deterministic, and content-sensitive. The extracted `buildFileIdentityWithHash()` function in `src/lib/indexeddb.js` ensures the hash is always added before the record is saved.

---

## BUG-009 — Permission errors on multipart uploads left orphaned sessions

**Date:** 2026-05-21
**Commit:** `7769395`

**Symptom:**
When a multipart upload failed due to a permission error (`AccessDenied` / 403), the IndexedDB resume record was retained. On the next upload attempt to the same destination, the app offered to resume an upload that could never succeed with the current credentials.

**Root cause:**
The failure handling distinguished transient failures (network errors — keep resume record for retry) from non-resumable failures (UploadId expired — clear record), but permission errors were not treated as non-resumable. A permission error is permanent for the current credentials — there is nothing to resume.

**Fix:**
On `isPermissionError`, call `AbortMultipartUpload` and clear the IndexedDB resume record immediately, in addition to updating the capability state.

**Why it wasn't caught earlier:**
The happy path (successful upload) and the transient failure path (network error + resume) were both tested manually. The permission-error-during-multipart path was not explicitly exercised.

**Test case:**
Mock a multipart upload that fails with a 403 on `UploadPartCommand`. Assert that `AbortMultipartUploadCommand` is sent and that the IndexedDB resume record is deleted.

**Coverage:** None — requires a Preact component harness with a mock S3 client and fake-indexeddb wired through component props. The logic is embedded in the `UploadQueue` component's error handler. No automated test exists; verified by code review and the `isPermissionError` function is unit-tested indirectly via `test/format.test.js`.

---

## BUG-010 — Batch uploads triggered `NS_BINDING_ABORTED` cascade

**Date:** 2026-05-22
**Commit:** `7e68cd1`

**Symptom:**
Uploading many small files produced a flood of `NS_BINDING_ABORTED` errors in the browser console. The listing occasionally showed incorrect or incomplete results after a batch.

**Root cause:**
Each file completion called `onUploadsComplete`, which incremented `browserKey` and re-mounted the `Browser` component. Each re-mount issued a new `ListObjectsV2` request, aborting any in-flight listing or its `OPTIONS` preflight. With many files completing in rapid succession, this created a cascade of aborted requests.

**Fix:**
Debounce the `browserKey` increment by 1500ms so that rapid completions coalesce into a single Browser re-mount after the burst settles.

**Why it wasn't caught earlier:**
Single-file uploads worked correctly. The cascade only appeared with batches of many small files completing faster than the listing could complete.

**Test case:**
Simulate N rapid calls to `onUploadsComplete` within a short window. Assert that `browserKey` is incremented only once (or at most twice) rather than N times.

**Coverage:** None — the debounce timer is internal to `App.jsx` component state. Requires mounting Preact components in jsdom. No automated test exists; verified by manual batch upload testing.

---

## BUG-011 — Listing refreshed per-file during batch, causing flickering

**Date:** 2026-05-22
**Commit:** `3d5c70e`

**Symptom:**
The file listing visually flickered and re-fetched multiple times during a batch upload, once per completed file.

**Root cause:**
`onUploadsComplete` was wired to fire on every transition of the `items` array, not just when the queue fully drained. Any state change (including a single file completing mid-batch) triggered a full Browser re-mount.

**Fix:**
Track a `hadActiveRef` boolean. Fire `onUploadsComplete` only when transitioning from "had active uploads" to "no active uploads" — i.e., when the queue fully drains.

**Why it wasn't caught earlier:**
Single-file uploads behaved identically under both implementations. The difference was only observable with concurrent multi-file batches.

**Test case:**
Simulate a queue of three files completing sequentially. Assert `onUploadsComplete` is called exactly once — after the third file, not after each one.

**Coverage:** None — `hadActiveRef` drain detection is internal to the `UploadQueue` component. Requires mounting Preact components in jsdom. No automated test exists; verified by manual batch upload testing.

---

## BUG-012 — `DELETE` missing from CORS `AllowedMethods`; delete operations failed on B2

**Date:** 2026-05-21
**Commit:** `938c3d3`

**Symptom:**
Delete operations failed on Backblaze B2 with a CORS preflight `403`. The delete button appeared to do nothing, and the browser console showed a CORS error on the `OPTIONS` request.

**Root cause:**
The CORS configuration template in `SetupGuide.jsx` included `GET`, `PUT`, `HEAD`, and `POST` in `AllowedMethods` but not `DELETE`. B2's CORS enforcement rejected the `OPTIONS` preflight for delete requests because the method wasn't whitelisted.

**Fix:**
Add `DELETE` to the `AllowedMethods` array in the CORS template.

**Why it wasn't caught earlier:**
Delete was implemented after the initial CORS guide was written. The guide wasn't updated to reflect the new operation's requirements. The symptom looked like a general CORS misconfiguration rather than a missing method.

**Test case:**
Assert that the CORS JSON generated by `corsJson()` in `SetupGuide.jsx` includes `'DELETE'` in `AllowedMethods`.

**Coverage:** `test/cors-config.test.js` — "corsJson — AllowedMethods (BUG-012)" suite. `corsJson()` has been extracted to `src/lib/cors-config.js`.

---

## BUG-013 — Shared URL params leaked connection details to server via query string

**Date:** 2026-05-22
**Commit:** `cb95ae1`

**Symptom:**
Endpoint URL, bucket name, provider, and current prefix appeared in the server's HTTP access logs when a shareable link was opened. Anyone with access to the server logs could observe connection configuration.

**Root cause:**
Shareable link parameters and the prefix navigation state were encoded in the URL query string (`?endpoint=...&bucket=...`). Browsers include the query string in the HTTP request path, which is logged by web servers. The hash fragment (`#`) is never sent to the server.

**Fix:**
Move all URL params (endpoint, bucket, provider, region, prefix) to the hash fragment.

**Why it wasn't caught earlier:**
Privacy implication of query string vs hash fragment is easy to overlook when focused on functionality. The behavior worked correctly from the user's perspective; the leak was only visible in server logs.

**Test case:**
Assert that `buildShareUrl()` returns a URL where all parameters appear after `#`, not in the `?` query string. Assert that no parameter key appears before the `#`.

**Coverage:** `test/url-params.test.js` — "buildShareUrl" suite, first test: "all params appear in the hash fragment, never the query string (BUG-013)".

---

## BUG-014 — Missing `useRef` import caused blank screen after refactor

**Date:** 2026-05-28
**Commit:** `f82352b`

**Symptom:**
App rendered a completely blank page after a refactor to `App.jsx`. No visible error in the UI; browser console showed `ReferenceError: useRef is not defined`.

**Root cause:**
`useRef` was added to `App.jsx` during a refactor but not added to the import statement from `preact/hooks`. Named imports must be explicitly listed.

**Fix:**
Add `useRef` to the import: `import { useState, useEffect, useCallback, useRef } from 'preact/hooks';`

**Why it wasn't caught earlier:**
No static analysis or linting configured to catch missing imports. The blank screen is a total failure but gives no actionable UI feedback.

**Test case:**
This class of bug is best caught by a linter (ESLint with `no-undef` or TypeScript). As a test: a smoke test that mounts `<App />` in a jsdom environment and asserts it renders without throwing would catch this immediately. Alternatively, assert at the source level that all hooks used in App.jsx are present in the preact/hooks import statement.

**Coverage:** `test/source-invariants.test.js` — "App.jsx — required hooks imported from preact/hooks (BUG-014)". Reads App.jsx source and asserts that `useState`, `useEffect`, `useCallback`, and `useRef` are all present in the import.

---

## BUG-015 — B2 multipart session expiry incorrectly assumed to match R2

**Date:** 2026-05-21
**Commit:** `2791f8a`

**Symptom:**
B2 users saw an "upload session may be approaching expiry" warning banner for long-running uploads, even though B2 sessions don't expire automatically.

**Root cause:**
A single `UPLOAD_EXPIRY_WARNING_MS` constant (7 days) was applied to all providers. R2 auto-expires incomplete multipart sessions after 7 days (documented). B2 does not expire them automatically — they persist until explicitly aborted or a lifecycle rule triggers. The warning was factually incorrect for B2.

**Fix:**
Replace the constant with a provider-aware function `uploadExpiryWarningMs(provider)` that returns `null` for B2 (no warning) and 7 days for R2 and others.

**Why it wasn't caught earlier:**
Provider-specific behavior was not confirmed before implementation. The assumption that B2 matched R2 was wrong and only surfaced when researching Q1 explicitly.

**Test case:**
Assert `uploadExpiryWarningMs('b2') === null`. Assert `uploadExpiryWarningMs('r2') === 7 * 24 * 60 * 60 * 1000`. Assert `uploadExpiryWarningMs('generic')` returns the same 7-day value as R2.

**Coverage:** `test/indexeddb-pure.test.js` — "uploadExpiryWarningMs" suite.

---

## BUG-016 — Corrupted `s3b_provider` promoted into profile name; credential pipeline had no write-boundary enforcement

**Date:** 2026-06-03
**Commit:** (v1.13.1)

**Symptom:**
After upgrading to v1.13.0, the profile picker on the connect screen displayed a garbled profile name containing credential text (key ID, secret key value, and instructional prose including "Use the above credentials to login. Navigate to Week 7.") instead of a normal connection name like "B2 — anwar-al-tafsir-storage".

**Root cause:**
`s3b_provider` in localStorage contained the string `"b2Key ID: <key-id>Secret Key: [REDACTED]Use the above credentials to login. Navigate to Week 7."` — credentials text that had been concatenated onto the provider identifier at some prior point (most likely a paste accident from a B2 dashboard credentials page, or residue from an older version of the app).

This corruption had three compounding effects:

1. **Perpetuation.** Every app load read the corrupted value via `loadCredentials()` with no validation, passed it through `handleConnect()`, and wrote it straight back via `saveCredentials()`. The corruption was self-reinforcing — it could never be auto-corrected.

2. **URL propagation.** `buildShareUrl()` included `credentials.provider` in the hash fragment verbatim. Any share link generated while the corruption was present would have embedded the credentials text in the URL.

3. **Migration amplification.** The v1.13.0 `migrateProfilesFromLegacy()` read `s3b_provider`, called `.toUpperCase()` on it to produce the `providerLabel`, and concatenated it into the profile `name` field: `"B2KEY ID: <KEY-ID>SECRET KEY: [REDACTED]USE THE ABOVE CREDENTIALS TO LOGIN. NAVIGATE TO WEEK 7. — anwar-al-tafsir-storage"`. The profile `provider` field was also stored verbatim. What had been a hidden corruption became a prominently displayed one.

The `provider` field is purely an internal enum (`'b2'`, `'r2'`, `'aws'`, `'wasabi'`, `'do_spaces'`, `'minio'`, `'generic'`). It has only seven valid states. No code anywhere in the pipeline enforced this.

**Fix (five layers):**

1. `repairStorageInvariants()` — retroactive cleanup: clears `s3b_provider` if it contains whitespace or exceeds 20 chars; repairs stored profiles with a corrupted `provider` field by setting `provider: null` and regenerating the name from bucket. Runs on every mount; idempotent no-op once data is clean.

2. `loadCredentials()` — sanitize on read: validates `provider` against `isValidProvider()`; returns `null` for any value that fails so corrupted data is never placed into app state.

3. `saveCredentials()` — sanitize on write: validates `provider` before writing; writes `''` if the value is invalid so the corruption cannot be re-persisted.

4. `readUrlParams()` — validates `provider` from the URL hash before accepting it; ignores any value containing whitespace or exceeding 20 chars, closing the URL propagation vector.

5. `CredentialForm` — inline validation errors shown as the user types: blocks submit if key ID, secret key, or bucket contain whitespace; warns if bucket exceeds 63 characters. Machine-generated S3 credentials never contain spaces; a space in any of these fields is unambiguous evidence of a paste error.

**Why it wasn't caught earlier:**
The `provider` field is set by a `<select>` dropdown in the UI, so it was implicitly assumed to always be one of the known enum values. This assumption did not account for: URL hash params (which accept free text), older app versions (which may have stored things differently), or direct localStorage access. No invariant was enforced at any layer — not at the read boundary, not at the write boundary, and not in the migration. The app treated localStorage as a trusted store rather than as external, potentially-corrupted input.

The broader principle: any data read from localStorage, URL params, or user input must be validated at the boundary where it enters the system. Trusting stored values because the code that wrote them was "our code" is a form of confused deputy — the store outlives any individual code version.

**Test cases:**
- `repairStorageInvariants` clears a corrupted `s3b_provider` value
- `repairStorageInvariants` fixes a profile whose `provider` field contains spaces
- `loadCredentials` returns `null` for provider when stored value fails the identifier check
- `saveCredentials` writes `''` for provider when passed an invalid value; round-trip returns `null`
- `readUrlParams` ignores a `provider` hash param that contains spaces or exceeds 20 chars
- CredentialForm `credentialErrors` returns an error for key ID containing a space
- CredentialForm `credentialErrors` returns an error for bucket containing a space or exceeding 63 chars

**Coverage:** `test/storage.test.js` — "repairStorageInvariants", "saveCredentials — provider write-boundary validation", "loadCredentials — provider read-boundary validation", "migrateProfilesFromLegacy" suites. `test/url-params.test.js` — "readUrlParams" suite (provider with spaces ignored, provider > 20 chars ignored). `test/credential-form-validation.test.js` — full `credentialErrors` coverage for bucket, keyId, secretKey, regionOverride.

---

## BUG-017 — Saved profile did not pre-fill credential form after disconnect

**Date:** 2026-06-03
**Commit:** (v1.13.2)

**Symptom:**
After disconnecting and returning to the connect screen, the profile picker correctly highlighted the last-used profile (shown in blue), but clicking it did not populate any form fields — all inputs remained blank. The user had to type all credentials manually despite having saved them.

**Root cause:**
In `App.jsx`, `credentials` was declared as the second `useState` call and `selectedProfileId` as the sixteenth. JavaScript executes `useState` initializers in declaration order. The `credentials` initializer called `loadCredentials()`, which returns empty strings after `clearCredentials()` runs on disconnect. Because `selectedProfileId` hadn't been initialized yet at that point, the initializer had no way to look up and seed the form from the saved profile.

When the user clicked the already-selected profile, `handleSelectProfile` called `setCredentials({...profile})` and `setSelectedProfileId(id)` with the same ID. Since the key on `<CredentialForm>` is `selectedProfileId`, and the ID didn't change, Preact did not remount the form — so its internal `useState` (seeded from `initial` only on mount) remained empty.

**Fix:**
Move `selectedProfileId` declaration before `credentials`. Update the credentials initializer to call `loadLastProfileId()`, find the matching profile in `loadProfiles()`, and use it as the base if found. Update the mount `useEffect` to use the same lookup order for the auto-connect check.

**Why it wasn't caught earlier:**
The state initialization ordering issue only manifests after a disconnect (which calls `clearCredentials()`). In a fresh session where credentials are still in localStorage, `loadCredentials()` returns the full credential set and the form populates normally. The multi-profile feature was new in v1.13.0 and this specific post-disconnect path was not exercised during testing.

**Test case:**
A source-level assertion: `selectedProfileId` must appear before `credentials` in the `useState` declarations in App.jsx. If the order is ever reversed, the credentials initializer silently loses access to the saved profile and the form loads empty.

**Coverage:** `test/source-invariants.test.js` — "App.jsx — selectedProfileId declared before credentials (BUG-017)". Reads App.jsx source, finds the character offset of both state declarations, and asserts the profile ID declaration comes first.

---

## BUG-018 — "Save as profile…" button stayed disabled even with all fields filled

**Date:** 2026-06-03
**Commit:** v1.13.7

**Symptom:**
The "Save as profile…" button remained disabled no matter what values were typed into the credential form, preventing profile creation without first connecting.

**Root cause:**
`canSaveProfile` in `ProfilePicker` was called with `currentFormData={credentials}`, where `credentials` is App-level state that only updates when the user submits the form via Connect. While the user was typing, `CredentialForm` held all values in its own local `useState` and never propagated them to App. `ProfilePicker` always saw the stale pre-connection (often empty) credentials, so `canSaveProfile` always returned `false`.

**Fix:**
Add an `onFormChange` prop to `CredentialForm` that fires on every field input with the current form values. In `App.jsx`, introduce `liveFormData` state (initialized from `credentials`) updated by `onFormChange`. Pass `liveFormData` to `ProfilePicker` instead of `credentials`. Also sync `liveFormData` in `handleSelectProfile` so selecting a profile immediately enables the button.

**Why it wasn't caught earlier:**
The profile save button was added alongside `canSaveProfile` in the same commit (v1.13.4). The validation logic was correct but the data source was wrong — testing against a live browser would have revealed it immediately, but the issue was not caught in code review because `credentials` being stale before Connect was not an obvious invariant to check.

**Test case:**
A DOM-level integration test would be needed to fully cover this (render the form, type into fields, assert button enables). Not currently practical without a test renderer. The fix is covered by code inspection: `ProfilePicker` must receive `liveFormData`, not `credentials`.

**Coverage:** No automated test (DOM-dependent). Fix is structural — `currentFormData` prop on `ProfilePicker` is now always `liveFormData` in App.jsx.

---

## BUG-019 — Wasabi bare endpoint `s3.wasabisys.com` not auto-detected as us-east-1

**Date:** 2026-06-03
**Commit:** v1.13.6

**Symptom:**
Entering `https://s3.wasabisys.com` as the endpoint (Wasabi's legacy default endpoint) showed "Cannot be auto-detected for this endpoint" and displayed an empty region input, forcing the user to type the region manually.

**Root cause:**
`extractRegion` for Wasabi matched only the pattern `^s3\.([^.]+)\.wasabisys\.com$` (region embedded in subdomain, e.g. `s3.us-east-1.wasabisys.com`). The bare legacy hostname `s3.wasabisys.com` has no region segment, so the regex returned `null`. Wasabi's official documentation lists `s3.wasabisys.com` as the primary endpoint for US East 1 (Virginia), equivalent to `s3.us-east-1.wasabisys.com`.

**Fix:**
Add a special case before the regex: if the host is exactly `s3.wasabisys.com`, return `'us-east-1'`. Source: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions

**Why it wasn't caught earlier:**
The existing Wasabi test only exercised the region-in-subdomain form (`s3.us-east-1.wasabisys.com`). The bare legacy endpoint was not in the test suite and was only discovered when a user tried it in practice.

**Test case:**
`extractRegion('https://s3.wasabisys.com', PROVIDERS.WASABI)` must return `'us-east-1'`.

**Coverage:** `test/provider.test.js` — "Wasabi: bare s3.wasabisys.com resolves to us-east-1 (legacy default endpoint)".

---

## BUG-020 — Saving a profile before connecting stored empty values and cleared the form

**Date:** 2026-06-03
**Commit:** v1.13.9

**Symptom:**
Filling in the credential form and clicking "Save as profile…" appeared to work (a profile was created with the chosen name), but the saved profile contained no data. Immediately after saving, all form fields cleared, as if the form had been reset.

**Root cause:**
`handleSaveProfile` in `App.jsx` built the profile object from `credentials` state, not `liveFormData`. Since `credentials` only updates when the user connects, it was empty for a user who hadn't connected yet. The profile was saved with blank endpoint, bucket, and key ID.

The form clearing was a second consequence of the same bug: saving the profile called `setSelectedProfileId(profile.id)`, changing the `key` prop on `<CredentialForm key={selectedProfileId}>`. Preact treated this as a new component instance and remounted it with `initial={credentials}` — which was still empty — wiping everything the user had typed.

**Fix:**
`handleSaveProfile` now reads from `liveFormData` to build the profile (mapping `providerOverride` → `provider` and applying the same trim/trailing-slash cleanup as `handleSubmit`). After saving, `credentials` and `liveFormData` are both synced to the saved profile data (plus secretKey from `liveFormData`) so the remount that follows the key change initializes with the correct values.

**Why it wasn't caught earlier:**
The profile save flow was only tested in the connected state in earlier development (where `credentials` is already populated). The pre-connect save path — added in v1.13.4 when the save button was gated on `canSaveProfile` — was not exercised before shipping.

**Test case:**
A DOM-level integration test would be needed (fill form, save profile, assert profile contains correct values and form is not cleared). Not currently practical without a test renderer.

**Coverage:** No automated test (DOM-dependent). Fix verified by manual testing.

---

## BUG-021 — Page completely frozen: Firefox terminated Preact VDOM diff of 15 000+ UploadLog rows

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
After a large upload session (15 521 files in upload history), the entire page became unresponsive. Buttons did not respond. Dragging files caused the browser to try to open them instead of uploading. The tab appeared fully loaded (no spinner). Firefox DevTools console showed: `Script terminated by timeout` with a stack trace rooted in Preact's VDOM diff functions (`diffElementNodes`, `diffChildren`, `diff`) repeating dozens of frames deep, entered from the `UploadQueue` task runner (`_drain`).

**Root cause:**
`UploadQueue._drain()` dispatches upload tasks as microtasks. Each task completion called `updateItem` → `setItems` → Preact state flush. Preact flushes synchronously from within a microtask, running a full VDOM diff of the entire component tree before yielding. With 15 521 `<tr>` rows × 7 cells = 108 647 virtual nodes, each diff took several seconds of wall-clock time. Firefox's script timeout (not CPU-based, fires after ~10 s of wall-clock JS execution) fired during the diff and terminated the script. Because Preact's event delegation was in a crashed state, all subsequent clicks and drags were silently lost at the DOM level.

Compounding factor: `UploadLog` used `key={i}` (array index). When a new entry was prepended, all keys shifted by 1, forcing Preact to patch every row instead of inserting one node.

**Fix:**
- Cap `UploadLog` to render at most `MAX_DISPLAY = 200` rows (newest first). Summary stats (total bytes, error count) still computed from all loaded entries.
- Changed row key from `key={i}` (array index) to `key={e.completedAt != null ? \`${e.completedAt}_${i}\` : i}` so Preact can add/remove a single node per new entry instead of re-keying the entire list.
- Added truncation notice: "Showing most recent 200 of N uploads. Clear the log to reset."

**Why it wasn't caught earlier:**
The freeze only manifests at scale (thousands of entries). Normal testing involved small upload batches. The symptom (frozen page, browser opens files on drag) did not point to a Preact rendering issue — it looked like an event-handling or queue bug. The stack trace was the key diagnostic.

**Test case:**
Render performance regressions of this kind are not mechanically testable in the current unit suite. The cap itself is an implicit safeguard: the rendered node count is now bounded at `MAX_DISPLAY × 7` regardless of history size.

**Coverage:** No automated test. Mitigated by `MAX_DISPLAY` cap. Stable key fix is a correctness improvement that also helps.

---

## BUG-022 — UploadLog panel popped in and out during active uploads

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
While uploads were in progress, the Upload History section repeatedly disappeared and reappeared, causing the page to jump. Each time a new upload completed, the panel would flash out then back in.

**Root cause:**
`UploadLog` had a `loading` boolean state initialised to `true`. Every time `refreshKey` incremented (triggered by each upload completion via `onLogEntry`), the `useEffect` set `loading = true` before fetching from IndexedDB. The render guard `if (loading || entries.length === 0) return null` caused the component to unmount on every refresh cycle, even though entries already existed. The panel disappeared for the round-trip to IndexedDB and reappeared once data loaded.

**Fix:**
Replaced `loading` with `initialLoadDone` (starts `false`, set to `true` once on first load, never reset). The render guard became `if (!initialLoadDone || entries.length === 0) return null`. Subsequent refreshes update `entries` in place; the component stays mounted and its contents update without any unmount/remount.

**Why it wasn't caught earlier:**
Observed only when upload history was large enough to be visible while uploads were still in progress. In early testing, uploads finished before the log section rendered.

**Test case:**
A DOM-level integration test: render `UploadLog` with an initial `refreshKey`, simulate two increments in quick succession, assert the component never returns `null` between increments if entries are already present.

**Coverage:** No automated test (DOM-dependent). Fix verified by manual testing.

---

## BUG-023 — Re-dragging a cancelled folder showed all files as "Paused"

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
After cancelling an in-progress folder upload and dragging the same folder into the upload zone again, every file immediately appeared with status "Paused — resume record found" rather than starting fresh. The user had to manually click Restart on each file.

**Root cause:**
`handleCancelBatch` aborted in-flight multipart sessions via `AbortMultipartUploadCommand` but did not call `deleteResumeRecord`. The IndexedDB resume records from the original (now-cancelled) upload survived. On the re-drag, `enqueueUpload` found those stale records for each file and set status to `paused` to prompt the user for a Resume/Restart choice — the correct behaviour for a genuine interrupted session, but wrong when the session was intentionally cancelled.

**Fix:**
Added `deleteResumeRecord(...)` calls inside `handleCancelBatch` alongside the existing `AbortMultipartUploadCommand` calls — one per item that had an active or paused multipart session. Both calls are fire-and-forget (`.catch(() => {})`); failure to delete a record is non-fatal and the user can still Restart.

**Why it wasn't caught earlier:**
The cancel path was tested for single-file cancels (`handleCancel`) which always called `deleteResumeRecord`. The batch-cancel path (`handleCancelBatch`) was added later and the resume-record cleanup was not carried over.

**Test case:**
Unit test for `handleCancelBatch`: mock an item with a `resumeRecord`, call cancel, assert `deleteResumeRecord` was called. Not currently in the suite.

**Coverage:** No automated test. Fix verified by manual testing.

---

## BUG-024 — Cancel during `loadResumeRecord` async gap overwrote "aborted" status with "paused"

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
Cancelling a batch immediately after dropping files could leave some items stuck in "Paused" status even though the cancel appeared to have fired. Affected items were those where `enqueueUpload` was suspended awaiting `loadResumeRecord` at the moment `handleCancelBatch` ran.

**Root cause:**
`enqueueUpload` calls `await loadResumeRecord(...)` before checking `cancelledBatchesRef`. The function is suspended at this `await`. If `handleCancelBatch` fires during this gap — adding `batchId` to `cancelledBatchesRef` and setting in-queue items to `aborted` — the items are correctly marked. But when `loadResumeRecord` resolves, the continuation of `enqueueUpload` ran past the cancellation check (which only existed further down, inside `queueRef.current.enqueue`), reached `if (existingRecord) { updateItem(..., { status: 'paused' }) }`, and overwrote the `aborted` status set by the cancel.

**Fix:**
Added a guard immediately after the `await loadResumeRecord(...)` line:
```js
if (cancelledBatchesRef.current.has(item.batchId)) return;
```
This mirrors the guard already present inside the queued task and covers the async gap before it.

**Why it wasn't caught earlier:**
The race window is narrow (only items that happen to be suspended in the `await` at the exact moment of cancel). Reproducing it required cancelling very quickly after drop, before the IndexedDB lookup resolved.

**Test case:**
Unit test: call `enqueueUpload` with a mock `loadResumeRecord` that delays, fire `handleCancelBatch` during the delay, assert the item remains `aborted` after the delay resolves. Not currently in the suite.

**Coverage:** No automated test. Fix verified by manual testing.

---

## BUG-025 — Upload silently fails with cryptic network error when blocked by a browser extension

**Date:** 2026-06-03
**Commit:** v1.14.0

**Symptom:**
Uploading a file whose destination path matched an ad-block filter rule (e.g., `server/analytics/analytics.js`) failed immediately with status 0, time 0, and no response headers. The error displayed in Bucketer was a raw `TypeError` ("NetworkError when attempting to fetch resource.") with no indication of the cause. The user had uBlock Origin active in Firefox.

Note: this is not a bug in Bucketer's logic — the request was legitimate and correctly formed. The failure is external. It is recorded here because the UX consequence (opaque error, no recovery path surfaced) was indistinguishable from a genuine network failure.

**Root cause:**
Browser content-blocking extensions (uBlock Origin, AdBlock Plus, etc.) intercept `fetch()` calls at the browser `webRequest` API level, before the request reaches the network. The interception is silent: no CORS preflight fires, no HTTP response is returned, and the browser raises a `TypeError` with a browser-specific message. In Firefox this is "NetworkError when attempting to fetch resource."; Chrome produces "Failed to fetch"; Safari produces "Load failed". The AWS SDK receives this as an unclassified network error and rethrows it. Bucketer's error display showed the raw JSON-serialised error with no context.

The filter match that triggered this was the filename `analytics.js` in the upload path, which is a common target in EasyPrivacy and similar filter lists.

**Fix:**
Added `isBlockedByExtension(err)` to `src/lib/format.js`. It returns `true` when: the error is a `TypeError`, it has no `$metadata.httpStatusCode` (ruling out genuine HTTP responses), and its message matches one of the three browser-specific strings. When the check passes, `UploadItem` renders a yellow warning banner above the technical error detail explaining that a browser extension may have blocked the request and offering two concrete remedies: disable the extension for the page, or add the destination domain to its allowlist.

**Why it wasn't caught earlier:**
Requires both a content blocker and a file whose upload URL matches a filter rule — a combination unlikely to appear in normal development testing. The failure mode is also easy to misread as a network or CORS issue.

**Test case:**
`isBlockedByExtension` has unit tests in `format.test.js` covering the Firefox, Chrome, and Safari error strings, a TypeError with an HTTP metadata response (must not trigger), a non-TypeError with the same message (must not trigger), a real S3 error (must not trigger), and null/undefined inputs.

**Coverage:** `isBlockedByExtension` fully covered by unit tests. The banner render is DOM-dependent and verified by manual testing.

---

## BUG-026 — Profile load resets region inference: changing endpoint leaves region stale

**Date:** 2026-06-07
**Commit:** v1.15.6

**Symptom:**
After loading a saved profile (e.g. B2 `us-west-004`), changing the Endpoint URL to a different B2 region (e.g. `eu-central-003`) left the Region field stuck at the old value (`us-west-004`). The "Auto-filled from endpoint URL" hint also disappeared on load. The stale region would then be sent to the S3 client on connect, causing an authentication failure against the new endpoint.

**Root cause:**
`CredentialForm.jsx` computes `_initExtractedRegion` (what the endpoint would give for a region) only when `initial.regionOverride` is absent:

```js
const _initExtractedRegion = (() => {
  if (initial.regionOverride || !initial.endpoint) return null;  // ← bailed early
  ...
})();
```

Because `_initExtractedRegion` was always `null` when a profile stored a region, the `userEditedRef` comparison `initial.regionOverride !== _initExtractedRegion` was always `true`, marking the region as user-edited regardless of whether the stored value matched extraction. With `ue.region = true`, the `applyChange` endpoint→region inference branch was skipped on every subsequent keypress.

The comment above `userEditedRef` correctly described the *intent* ("a stored value that matches auto-extraction is treated as inferred") but the code never reached the comparison to check this.

**Fix:**
Remove `initial.regionOverride ||` from the `_initExtractedRegion` bail condition so extraction always runs when an endpoint is present. The existing comparison then correctly evaluates to `false` when the stored region matches extraction, setting `ue.region = false` and restoring inference. Also updated `_infRegion` to `true` in the matching case so the "Auto-filled from endpoint URL" hint is shown.

```js
// Before:
if (initial.regionOverride || !initial.endpoint) return null;
// After:
if (!initial.endpoint) return null;
```

```js
// Before:
_infRegion: !!(_initExtractedRegion && !initial.regionOverride),
// After:
_infRegion: !!(_initExtractedRegion &&
               (!initial.regionOverride || initial.regionOverride === _initExtractedRegion)),
```

**Why it wasn't caught earlier:**
The bug only manifests when a profile is loaded from storage (not when filling the form fresh). The inference tests in `provider.test.js` cover `extractRegion` in isolation. No test exercised the CredentialForm's `userEditedRef` initialization path with a pre-populated `regionOverride`.

**Test case:**
Structural: assert in `source-invariants.test.js` that `_initExtractedRegion` in `CredentialForm.jsx` does not include `initial.regionOverride` in its bail condition. Or integration: mount CredentialForm with `initial = { endpoint: B2_ENDPOINT, regionOverride: B2_REGION }`, simulate an endpoint change to a different B2 region, and assert the region field updates.

**Coverage:** No automated test. Fix verified by runtime observation: loading the "B2 Test" profile, changing endpoint from `us-west-004` to `eu-central-003`, confirmed region field updated to `eu-central-003` with "Auto-filled from endpoint URL" hint.

---

## BUG-027 — Post-disconnect: form is blank despite profile still highlighted

**Date:** 2026-06-07
**Commit:** v1.15.6

**Symptom:**
After disconnecting, the credential form went blank (all fields empty) even though the last-used profile remained highlighted in the profile list. Clicking the highlighted profile row had no effect — the form stayed empty. To recover, the user had to select a different profile and back, or reload the page.

**Root cause:**
`handleDisconnect` reset `credentials` state to all-empty but did not update `selectedProfileId` (intentional — the user's last profile stays selected across sessions) or `liveFormData`. The splash `CredentialForm` then mounted with `initial={empty credentials}`, showing blank fields.

The highlighted profile row was unclickable because `handleSelectProfile(id)` called `setSelectedProfileId(id)` with the same value already in state — React bails out on same-value state updates, the key (`selectedProfileId ?? 'manual'`) didn't change, and the CredentialForm wasn't remounted. `initial` prop changes don't re-initialize a component's `useState`.

**Fix:**
In `handleDisconnect`, repopulate `credentials` and `liveFormData` from the selected profile (minus secret key) instead of clearing to empty. The CredentialForm then mounts with the profile's endpoint/bucket/keyId visible; the user only needs to enter the secret key to reconnect. No behavior change for users with no saved profiles — those still see an empty form.

**Why it wasn't caught earlier:**
The bug is only observable in a live session after connecting and disconnecting. The unit and structural tests have no coverage of App-level state transitions. The pattern of "same-value setState is a no-op" is easy to miss when the component tree has just remounted (connected → disconnected transitions swap the entire layout).

**Test case:**
Integration: simulate `handleDisconnect` with a selected profile in state, assert `credentials` equals the profile data (minus secret key) and `liveFormData` matches. Or structural: assert `handleDisconnect` calls `setLiveFormData` and that `setCredentials` is not called with all-empty values when a profile is selected.

**Coverage:** No automated test. Fix verified by code review and runtime analysis.
