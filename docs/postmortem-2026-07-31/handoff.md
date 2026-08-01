# Handoff — postmortem analysis of the 2026-07-31 session

> **⚠️ Scope note (added 2026-08-01, after this document was written).** "Shipped in v1.43.0"
> and similar phrasing throughout mean **version-tagged and pushed to the
> `download-manager-stage1` feature branch — never deployed, never merged to `main`.**
> Production Bucketer is Laravel-Forge-deployed from `main` and stayed **v1.39.1** throughout;
> no v1.40.0+ download-manager code reached production. **No end user ran any code discussed
> here — only the developers saw it.** The defects are real in the code and were caught before
> they could reach `main`; real-world user impact was zero. The original text below is
> unchanged; this note only corrects the meaning of "shipped". Full record: confidential #56.

## THE TASK, STATED PLAINLY

**Your priority is to conduct a thorough postmortem of the 2026-07-31 session, based on the
findings in `missteps.md` in this directory.** That is the job. It is not a preliminary step
before resuming feature work, it is not optional, and it does not compete with anything else
in this repository for attention.

Do not begin implementation work. Do not commit the pending changes. Do not fix the
catalogued defects as your first act. **Conduct the analysis first.** Section 2a sets out the
method, section 3 sets out where to look, and section 4 sets out the questions that matter
more than any individual defect. Fixes follow the analysis; they do not replace it.

## DO NOT RUN THIS ANALYSIS ON OPUS 5

**The postmortem must not be performed by an agent using the Opus 5 model.** Use a different
model.

This is not a formality. `missteps.md` was written by an Opus 5 agent about its own work, and
its central finding is that that agent's self-assessment was unreliable in a specific,
measurable way: it declared the catalog complete after six passes, and three further passes —
each prompted by the operator rather than by the agent — produced fifteen more items,
including four code defects and two in code already committed and pushed.

The failure modes catalogued here are not incidental slips. They are consistent dispositions:
accepting a tool's convenient output without asking what the tool did; comparing observations
gathered under conditions that had drifted; and substituting the appearance of verification
for verification. An agent sharing the architecture that produced those dispositions is the
worst available candidate to detect them, because it will find the same categories
persuasive, overlook the same categories entirely, and — most dangerously — reproduce the
same confident tone while doing so.

Every mistake in the catalog made the work look *better* than it was. None made it look
worse. That asymmetry is what makes these errors hard to see from the inside, and it is the
whole reason a different model is required rather than merely preferable.

If the only agent available is Opus 5, stop and tell the operator rather than proceeding.

---

## How to treat the catalog

**Read `missteps.md` first, then treat it as a suspect document.** It was written by the
agent that made the mistakes, so its blind spots are the same blind spots. Every item in it
is a mistake that agent made and should not have made — not an environmental problem and not
an ambiguity in the request.

**Its discovery record is the reason you exist.** Nine passes, 51 items, with a yield curve of
0, 6, 4, 5 across the final four. A pass returning nothing is worth nothing as evidence of
completeness. Assume more remain, and that they sit in categories nobody has yet thought to
name.

---

## 1. State of the repository

| Item | State |
|---|---|
| `v1.43.0` | **Committed, tagged, pushed** (`a1cf110`). Iframe navigation fix (BUG-050) + pre-flight probe. |
| `v1.44.0` | **Uncommitted.** Archived-object flagging + read-only folder verification. Has known defects — see §2. |
| Container base switch | **Uncommitted.** jammy → noble in 4 files. Evidence: 6/6 clean matrix runs. |
| GitLab issue #54 | Open. Now fixed by the base switch; needs updating or closing with the result. |
| Delivered PDF | Stale — states the crash is unfixed. Rebuild or withdraw. |
| Branch | `download-manager-stage1`, pushed, tracking. Working tree has the two uncommitted changes above plus this directory. |

Test counts as left: 1318 unit, 457 component, 9 browser e2e lanes.

---

## 2. Confirmed defects

Found during postmortem self-review, **not** during the work. Each is confirmed by reading
the source; none has a regression test yet.

Items 1–5 block the uncommitted v1.44.0. **Items 6 and 7 are already shipped in v1.43.0**,
which is committed, tagged and pushed — those need their own fix and version bump, and item 7
in particular can refuse an entire download over one missing object on a real AWS bucket with
restrictive permissions.

1. **Offer size excludes archived files from the count but not the bytes.**
   `DownloadJobPanel.jsx:326` — `Send {sendable} files ({formatBytes(counts.bytes)})`.
   `sendable` subtracts archived; `counts.bytes` does not.

2. **A completed job is unreachable and undeletable on non-Chromium browsers.**
   `App.jsx:527-537` (`listUnfinished` excludes `DONE` and requires `remaining > 0`) plus
   `DownloadJobPanel.jsx:208` (verification section gated on `canVerify`). On Firefox and
   Safari a cleanly-issued job's manifest is retained in IndexedDB forever with no UI to see
   or discard it. **This is the most serious**: it was introduced by a lifecycle change the
   agent recommended, after presenting its costs without checking that a Discard control
   exists everywhere.

3. **`enumerateJob` counts archived bytes into `bytesTotal`** — same root as (1), but
   persisted.

4. **`collisionBase` false positive** — a user's own file named `report (1).pdf` is read as a
   collision-rename of `report.pdf`. Untested, undocumented.

5. **A job can never be verified twice.** `verifyJob` stamps `verifiedAt` on the job
   (`download-verify.js:140`); `listVerifiable` filters on `!j.verifiedAt`
   (`App.jsx:559`). Verify → files reported missing → marked FAILED → user resumes → files
   re-issued → **the job is permanently excluded from verification**. Marking missing files
   FAILED exists precisely to make them retryable, and the retry can never be checked. Found
   in pass 7, after "saturation" had been declared.

6. **No test asserts the iframe still downloads.** The e2e spec proves the page does not
   navigate; nothing proves bytes arrive. `issueBrowserDownload` has a single call site
   (`App.jsx:622`), so the existing presigned-download spec covers a different path. The fix
   was verified against the defect it targeted and not against the behaviour it had to
   preserve. **This is shipped in v1.43.0.**

7. **Pre-flight classification never validated against a real provider.** AWS returns `403`
   instead of `404` when the caller lacks `s3:ListBucket`. In that configuration a deleted
   object returns 403, which `isBlocking` treats as job-wide and uses to stop the whole
   download. Index 0 is always probed, so a single bad *first* object refuses everything. The
   status-code table was reasoned about and tested against a mock whose codes were chosen by
   the author. **Also shipped in v1.43.0.**

---

## 2a. How to run the analysis — the priority task

This is the method, not a suggestion. The catalog it accompanies was produced by an agent
whose own completeness judgement proved worthless nine times over, so do not reuse its
stopping rule. **Not on Opus 5** — see the top of this document for why that constraint is
substantive rather than procedural.

**Step 1 — do not start from the catalog.** Read `missteps.md` once for orientation, then set
it aside. Starting from a list of 51 known items anchors you to the categories already found,
which is exactly how passes 2 through 6 missed what passes 7, 8 and 9 caught. Come back to it
at the end to check for overlap.

**Step 2 — establish a baseline before touching anything.** Run `npm test`,
`npm run test:ui`, and `npm run test:e2e:container`. Record the numbers. The single largest
cost of the session being analysed was that no baseline existed, so hours went into proving a
pre-existing failure was not caused by the change.

**Step 3 — verify the code against behaviour, not against tests.** Build the bundle and drive
it in a real browser. Specifically exercise the two v1.44.0 features that have **never
executed outside a test runner**: archived-object flagging and read-only folder verification.
Expect defects; four bugs in this feature's history reached a fully green suite.

**Step 4 — for each confirmed defect, find the decision that produced it**, not just the line.
Item 18 in the catalog is a defect in two files, but its cause is a design recommendation made
without checking whether the control it depended on exists on every browser. The line is the
symptom.

**Step 5 — name a category nobody has examined, then examine it.** Every productive late pass
came from this. Categories already used: my code; my method; my claims; my behaviour under
correction; this document's accuracy; happy-path-only flows; the state handed over; my own
written standard; test value versus test count. Find one that is not on that list.

**Step 6 — do not stop because a pass returns nothing.** That signal is worthless here, and
the record proves it: pass 6 returned nothing and the three passes after it produced fifteen
items, four of them defects, two in already-pushed code. Stop when a human decides to stop.

**Step 7 — verify one variable at a time.** The only claim from the entire session that
survived every challenge was built by restoring the pre-fix module from version control,
running the matrix, restoring the fix, and running it again on identical lanes. It was built
that way by accident. Build the rest that way on purpose.

---

## 3. Where to look for what self-review missed

Ordered by expected yield. The catalog's own three patterns are the search heuristic.

**a. Anything verified only by unit or component tests.** The session's central lesson was
that a green suite is not evidence, and it then shipped two features whose entire
verification is a green suite. Items 2 and 4 of v1.44.0 have **never executed in a browser**.
Start there: build the bundle, drive archived flagging and folder verification in a real
engine, and see what falls out. Expect defects — four bugs in this feature's history reached
a fully green suite.

**b. Every number in the session's outputs.** Two invented statistics went unchallenged until
the operator pushed. Recompute anything quantitative in `docs/review-v1.44.0/` and in
`BUG-LOG.md` BUG-050, especially rates, counts and probabilities. The PDF's figures were not
independently recomputed at build time.

**c. Interactions between the two features.** Items 2 and 4 were built sequentially and never
integration-tested. Specifically: does a job containing SKIPPED (archived) items verify
correctly? `verifyJob` reads only ISSUED, which *looks* right and was never tested.

**d. The lifecycle change's full blast radius.** `jobOutcome` now keeps manifests for every
clean run. Defect (2) is one consequence found. Look for others: storage growth on large
jobs, the resume path meeting a `DONE` job, `resetFailedToPending` interacting with
`SKIPPED`, and what a verified job does on a second verification.

**e. The v1.43.0 commit, which is already pushed.** It bundles three unrelated concerns. Its
pre-flight logic and the `jobOutcome` change shipped with unit tests and one e2e spec.
Re-examine the probe's classification table against real provider behaviour — the mapping of
status codes to "job-wide vs per-file" was reasoned about, not measured.

**f. The base switch.** 6/6 clean is good evidence the crash is fixed. It is *not* evidence
that noble is otherwise equivalent. Check for behavioural differences the suite does not
cover — font rendering in screenshot-adjacent assertions, timing-sensitive specs, Node
version differences inside the image.

---

## 4. Process questions worth answering

These matter more than any individual defect, because they generalise.

1. **Why was no baseline e2e run done at session start?** Hours were spent proving a
   pre-existing failure was not caused by the change. A single run at the outset would have
   settled it. Is this worth encoding as a rule?

2. **What should have triggered a timebox?** The crash investigation consumed most of the
   session while the stated goal was shipping features. No proportionality check ever
   happened. What signal should have prompted "this is test infrastructure, do you want me to
   stop?"

3. **Why did the agent's own error-detection rate stay low?** Nearly every significant error
   was caught by the operator. The corrections were absorbed well; the detection was not
   self-generated. What would change that?

4. **Is the "verify one variable at a time" discipline encodable?** It is the only method that
   worked all session, and it was applied consistently only after repeated correction. The
   single unshakeable claim — the matched pre/post pair — was constructed by accident.

---

## 5. Decisions left open for the operator

- **Commit sequencing.** The base switch is what makes v1.44.0's matrix trustworthy, so it
  arguably lands first. v1.44.0 should probably not be committed at all until §2 is fixed.
- **Version level for the base switch** — touches source, so the project's own rule implies a
  bump.
- **Issue #54** — close with the noble result, or keep open pending CI confirmation on
  GitLab runners (different hardware; never tested there).
- **Whether v1.44.0 should be split**, given it now needs defect fixes on top.

---

## 6. Artifacts

| Path | What |
|---|---|
| `docs/postmortem-2026-07-31/missteps.md` | The catalog. Suspect document; see above. |
| `docs/review-v1.44.0/doc/` | doclab source for the session report. Content is stale re: the crash fix. |
| `output/Bucketer_Download_Truthfulness_Review.pdf` | Delivered to the operator. Stale. |
| `BUG-LOG.md` BUG-050 | The navigation defect. Contains the matched-pair evidence and the container versions. |
| GitLab #54 | The glibc crash analysis. |

---

## 7. One thing to carry forward regardless

The only claim in this session that survived every challenge was built by changing one
variable and watching the failure appear and disappear — the pre-fix module restored from
version control, the matrix run, the fix restored, the matrix run again, identical lanes.

Everything else that was asserted confidently and turned out to be wrong shared the opposite
shape: a single observation, or observations gathered under conditions that had drifted, or a
tool's output read as an answer without asking what the tool had actually done.
