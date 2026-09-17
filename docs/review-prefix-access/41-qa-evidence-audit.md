# QA Evidence Audit — prefix-access run

**Date:** 2026-09-16 · **Auditor:** QA/verification (read-only) · **Scope:** claims 1–7 as
assigned.

**Process note (blocking context for every claim below).** The worktree was specified as
`feature/prefix-access` at `c48c7d9`. It was **not stationary during this audit**: a
concurrent process advanced it twice while I was working —

```
966804d v1.63.3 — E2E spec lane fixes for the prefix-access batch
bc4ac52 e2e: E2E_FILES no longer fails the node layer when it names browser-only specs
c48c7d9 e2e: make the prefix-access specs lane-correct on mobile profiles and Firefox   ← starting HEAD
```

I first observed this as an uncommitted diff to `test/e2e/run.mjs` (`git status`), then on a
later `git status` the diff was gone and `git log` showed it had landed as `bc4ac52` +
version bump `966804d`. All findings below are reported against **current HEAD `966804d`**,
with the drift called out wherever it changes an answer. I did not run anything forbidden
(no `node build.mjs --mode=perf`, no browser e2e, no `test:e2e:*`) — only `npm test`,
`npm run test:ui`, `git`, `grep`/`Read`, and reads of the `.claude-scratch/prefix-access/*.log`
files that a prior session already produced.

---

## Claim 1 — BUG-LOG.md entries BUG-063…067 are complete and their named tests exist

**Verification performed.** Read `BUG-LOG.md` in full (top 5 entries). Grepped each named
test-case string against the file it's attributed to:

```
grep -n "connecting WITHOUT a Base folder" test/e2e/browser/prefix-scope.test.mjs        → line 144
grep -n "a slash-less deep-link prefix" test/e2e/browser/prefix-scope.test.mjs           → line 454
grep -n "CORS-masked denial with no Base" test/e2e/browser/prefix-scope.test.mjs         → line 207
grep -n "Base folder set on recovery is saved" test/e2e/browser/prefix-scope.test.mjs    → line 322
grep -n "switching to a saved bucket the key cannot list" test/e2e/browser/prefix-scope.test.mjs → line 271
grep -n "#70" test/e2e/browser/profiles.test.mjs                                          → line 87/93
grep -n "sanitizeNavPrefix" test/base-prefix.test.js                                      → lines 11, 95–112
grep -n "readHashPrefix|urlChangesConnection" test/url-params.test.js                     → lines 23–24, 300–356
grep -n "cors-blocked-or-scoped|basePrefixUnset" test/connection-diagnostics.test.js       → lines 160–196
grep -n "slash-less|traversal" test/components/browser-base-prefix.test.jsx               → lines 107, 120
```
`error-block.test.jsx` carries 13 `#65:`-tagged cases (lines 132–212) covering the scope
hint, the two negative codes (bad-credential and diff-review S-4 non-scope codes), the
set-but-denied variant, and `focusOnMount`.

Each entry (BUG-063 err-focus, BUG-064 CORS-masked verdict, BUG-065 recovery persistence,
BUG-066 raw-prefix sanitization, BUG-067 link auto-connect) has symptom / root cause / fix /
why-not-caught-earlier / test case — all five fields present in all five entries.

**Defect found — the durable log is not committed.** `BUG-LOG.md`'s working-tree content
differs from `HEAD:BUG-LOG.md` by the entire +189-line block (BUG-063…067):

```
$ git diff --stat -- BUG-LOG.md
 BUG-LOG.md | 189 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 189 insertions(+)
$ git show HEAD:BUG-LOG.md | grep -n "^## BUG-0" | head -3
7:## BUG-062 — Renaming a file whose key has a non-Latin-1 character fails ("Headers constructor")
50:## BUG-061 — ...
90:## BUG-060 — ...
```
This holds at current HEAD `966804d`, i.e. the whole prefix-access batch through the v1.63.3
version bump has landed with a durable-log entry for none of BUG-063…067. Per the global
Bug Tracking rule ("log it in `BUG-LOG.md` before closing out the work"), this batch is not
closed out. The content itself is accurate (verified above); it just isn't in the repo's
history yet — a single commit away, but currently one `git checkout -- BUG-LOG.md` from
disappearing.

**Verdict: partial** — content correct and its test-case claims verified true, but the
entries are uncommitted working-tree state, not a durable log entry, at the point this batch
otherwise finished shipping (v1.63.3).

---

## Claim 2 — Matched-pair evidence (prefix-run-2-prefix.log / postfix-scoped-run-2.log)

**Verification performed.**

Image tag, all three logs:
```
$ grep -n "containerized e2e:" baseline-matrix.log prefix-run-2-prefix.log postfix-scoped-run-2.log
postfix-scoped-run-2.log:5:── containerized e2e: podman + mcr.microsoft.com/playwright:v1.60.0-noble (volume bucketer-e2e-node_modules) ──
prefix-run-2-prefix.log:5:── containerized e2e: podman + mcr.microsoft.com/playwright:v1.60.0-noble (volume bucketer-e2e-node_modules) ──
baseline-matrix.log:5:── containerized e2e: podman + mcr.microsoft.com/playwright:v1.60.0-noble (volume bucketer-e2e-node_modules) ──
```
Same image, all three. Confirmed.

Per-lane totals, pre-fix (`prefix-run-2-prefix.log`):
```
$ grep -n "^ℹ tests\|^ℹ pass\|^ℹ fail" prefix-run-2-prefix.log
65:ℹ tests 22   67:ℹ pass 11   68:ℹ fail 11
281:ℹ tests 22  283:ℹ pass 11  284:ℹ fail 11
500:ℹ tests 22  502:ℹ pass 11  503:ℹ fail 11
709:ℹ tests 22  711:ℹ pass 11  712:ℹ fail 11
924:ℹ tests 22  926:ℹ pass 11  927:ℹ fail 11
1142:ℹ tests 22 1144:ℹ pass 11 1145:ℹ fail 11
1360:ℹ tests 22 1362:ℹ pass 11 1363:ℹ fail 11
1576:ℹ tests 22 1578:ℹ pass 11 1579:ℹ fail 11
1795:ℹ tests 22 1797:ℹ pass 11 1798:ℹ fail 11
```
9 lanes, each 22/11/11 — exactly matches BUG-LOG's claim.

`✖` names, lane 1 (chromium × desktop), quoted from `prefix-run-2-prefix.log` lines 23–52:
```
✖ connecting WITHOUT a Base folder: the denial is seen, focused, and Set base folder lands in the field
✖ … and on a Pixel 5 viewport, where the field is a full screen above the error
✖ a SignatureDoesNotMatch denial gets no Base folder hint
✖ a CORS-masked denial with no Base folder still offers Set base folder, and diagnostics name both causes
✖ switching to a saved bucket the key cannot list titles the error with that bucket
✖ a Base folder set on recovery is saved to the connection, so quick-switch no longer loops
✖ a slash-less deep-link prefix is normalized, so New folder creates a child, not a sibling
✖ the breadcrumb button copies a link that opens the recipient inside the folder
✖ the header menu offers the same folder link, and the top item omits the folder
✖ a differing endpoint/bucket in the hash lands on the form; the other endpoint sees nothing
✖ a hash change to a different endpoint on the failed screen clears the secret from the form
```
That's 11, and it maps 1:1 onto BUG-LOG's tally "E1 ×3 incl. the bad-credential negative, E2,
quick-switch title, E3 loop, S1, L1 ×2, S2 ×2" (3+1+1+1+1+2+2 = 11). Every other test in the
same lane (`✔ connect with a Base folder…`, the three shared-link-screen cases, `no breadcrumb
link button at the floor`, `BUG-047…`, `a link that repeats the stored connection…`,
`BUG-018/020/027/026`) passed — i.e. the failure set is exactly the 11 new cases, and no
pre-existing case failed. Confirmed for lane 1; the aggregate 11/11 count on the remaining 8
lanes is consistent with the same partition (not individually re-diffed name-by-name for all
9 lanes — see Coverage gaps).

Post-fix (`postfix-scoped-run-2.log`):
```
$ grep -n "^ℹ tests\|^ℹ pass\|^ℹ fail" postfix-scoped-run-2.log
(9 blocks, each) ℹ tests 22 / ℹ pass 22 / ℹ fail 0
```
All nine lanes 22/22/0. Confirmed.

**Coverage gap noted, not a defect:** both matched-pair runs report the *matrix's* node layer
as failed (`✗ node layer`, "N of 10 lanes FAILED") because at the time these two runs were
taken, `E2E_FILES` naming two browser-only specs made the pre-`bc4ac52` `run.mjs` `exit(1)`
in the node layer ("names 2 spec(s) but 0 matched"). That bug is now fixed (`bc4ac52`,
verified by direct behavioral read of the diff — see Claim 7), but the two log artifacts
being cited as evidence still show `10 of 10 lanes FAILED` / `1 of 10 lanes FAILED` at their
top-line summary, which — read out of context — looks like a red run. The 9 browser lanes
inside each log are the actual evidence and are exactly as strong as claimed; nobody should
re-run these two specific logs to get a clean top-line summary, since the fix landed after
they were captured.

**Verdict: verified** for the per-lane pass/fail claim and the image-tag-parity claim; the
node-layer noise is a process footnote, not a defect in the evidence.

---

## Claim 3 — Baseline (baseline-matrix.log)

**Verification performed.**
```
$ git -C .claude-scratch/prefix-access/baseline-wt log -1 --oneline
0b24aea docs: update pre-push hook description in AGENTS.md (browser e2e → CI) [skip ci]
$ git -C .claude-scratch/prefix-access/baseline-wt symbolic-ref -q HEAD ; echo $?
1
```
`0b24aea` matches `origin/main`'s tip named in the task; exit code 1 on `symbolic-ref`
confirms **detached HEAD** (not on a branch).

Node layer (lines 129–132 of `baseline-matrix.log`):
```
ℹ tests 64
ℹ pass 64
ℹ fail 0
```
First browser lane (lines 298–304):
```
ℹ tests 66
ℹ suites 42
ℹ pass 65
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```
Matrix summary (tail of the log):
```
══ e2e matrix summary ══
  ✓ node layer
  ✓ chromium × desktop
  ✓ chromium × Pixel 5
  ✓ chromium × iPhone 13
  ✓ firefox × desktop
  ✓ firefox × Pixel 5
  ✓ firefox × iPhone 13
  ✓ webkit × desktop
  ✓ webkit × Pixel 5
  ✓ webkit × iPhone 13
```
All nine lanes green, node layer green, matching the BUG-LOG's "node layer 64/64; nine
browser lanes 66 tests each, 0 failures (skips 1–4 per lane, device-gated)".

I also confirmed the baseline worktree was clean *at the time of that run*: its current
`git status` shows five modified files (`scripts/e2e-container.mjs`,
`test/e2e/browser/prefix-scope.test.mjs`, `test/e2e/browser/profiles.test.mjs`,
`test/e2e/mock-s3/server.mjs`, `test/e2e/run.mjs`) — but their mtime (17:44) postdates the
baseline log's mtime (17:19), so those are the later overlay used to produce the pre-fix
matched-pair run (claim 2), reusing the same worktree — not contamination of the baseline
run itself.

**Verdict: verified.**

---

## Claim 4 — Observables vs. proxies in the new spec cases

**Verification performed.** Read all 11 new cases in `prefix-scope.test.mjs` (lines 76–612)
and both new cases in `profiles.test.mjs` (lines 93–166) in full.

Per case, the primary assertion(s):

| Case | Primary assertion |
|---|---|
| `connecting WITHOUT a Base folder…` (+ Pixel 5) | `getBoundingClientRect()` inside `innerHeight`, `document.activeElement === el`; after click, target field's rect + `activeElement` |
| `a SignatureDoesNotMatch denial…` | `textContent` for message content + `button:has-text(...)` **count === 0** (absence of a control, not just text) + `rootLists().length >= 1` (mock request-log presence) |
| `a CORS-masked denial…` | `textContent` gating + mock-log presence (`rootLists().length >= 1`) |
| `switching to a saved bucket…` (quick-switch title) | `.error-title` exact-text equality + mock-log presence |
| `a Base folder set on recovery…` | `localStorage` record's `basePrefix` field read directly (not UI text) + `rootLists().length === 0` post-recovery (absence) + `.error-block` count 0 |
| `a slash-less deep-link prefix…` | `mock.requestLog` — asserts the **exact** `listPrefix` used, and the **negative** (bare string never requested); PUT path in the log for the New-folder key |
| `the breadcrumb button copies a link…` | `navigator.clipboard.writeText` stubbed, then **the actual copied string** parsed as `URLSearchParams` (`prefix`, `basePrefix`, `keyId` fields) — then a **second** context replays that exact URL and asserts the mock's request log |
| `the header menu offers the same folder link…` | same clipboard-content parsing for two separate copy actions |
| `no breadcrumb link button at the floor` | element **count** (DOM-attachment proxy) — see below |
| `a differing endpoint/bucket in the hash…` (#70) | form field values + mock request-log length on the **other, unrelated mock instance** (`other.mock.requestLog.list().length === 0`) — a real cross-origin absence, not a proxy |
| `a hash change to a different endpoint on the failed screen…` (#70) | same pattern, fragment-only navigation |

**One case is proxy-only, correctly:** `no breadcrumb link button at the floor` asserts
`locator(...).count() === 0` — a DOM-attachment check. This is legitimate here (not a
misuse): the claim under test is "the button does not exist", so DOM-attachment absence *is*
the observable, not a proxy standing in for one. Contrast with an assertion that a button
existing means a feature works (a proxy) — that's not what's happening here.

No case relies on `textContent.includes(...)` as its *sole* evidence of user-visible success;
every case that uses `textContent` for wording (SignatureDoesNotMatch's message, the
CORS-masked block's two-cause text) pairs it with a geometry/focus/request-log assertion
establishing the state actually changed, consistent with the E2E Evidence Rules'
presence-next-to-absence requirement.

**Verdict: verified** — the new cases assert observables (geometry, focus, clipboard
content, mock request-log presence/absence), not proxies. No defects found here.

---

## Claim 5 — Harness-fidelity wording (E2, #66)

**Verification performed.**
```
$ git show -s --format='%B' 5a8457a
```
```
Harness fidelity: the mock's corsOnErrors:false models the hypothesis that a provider omits
CORS headers on error responses; it does not establish that Backblaze B2 does. No e2e
coverage: harness cannot represent B2's real denial/CORS behaviour.
```
This is a verbatim, word-for-word match (aside from the design doc's initial-cap "The" vs.
the commit's lower-case "the", which the design text itself renders lower-case when quoted
in context) of the design's mandated wording. The identical sentence is also present, in the
BUG-LOG entry (line 139-140) and inline in the spec's comment (`prefix-scope.test.mjs` lines
201-203).

**Verdict: verified.**

---

## Claim 6 — Unit/component suites at HEAD

**Verification performed** (re-run at current HEAD `966804d`, after the mid-audit advance):
```
$ npm test
...
# tests 1616
# suites 398
# pass 1616
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
```
$ npm run test:ui
...
# tests 573
# suites 170
# pass 573
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
Both green, 0 failures, at current HEAD.

**Verdict: verified.**

---

## Claim 7 — Design items table vs. shipped commits

**Verification performed.** Read the items table
(`docs/superpowers/specs/2026-09-16-prefix-access-design.md` lines 263–272) and grepped
`GitLab #`/`Addresses #` out of every commit body from `0b24aea..HEAD`:

| Item | Issue | Impl. commit | Version-bump commit |
|---|---|---|---|
| E1 | #65 | `c0109d9` "Addresses #65 (item E1...)" | `e21d759` v1.62.4 |
| E2 | #66 | `5a8457a` "Addresses #66 (item E2...)" | `012966e` v1.62.5 |
| E3 | #67 | `3ab41a0` "Addresses #67 (item E3...)" | `170a8a2` v1.62.6 |
| S1 | #68 | `534d5e5` "Addresses #68 (item S1...)" | `20c7732` v1.62.7 |
| L1 | #69 | `61690f5` "Addresses #69 (item L1...)" | `4cb6d8d` v1.63.0 |
| S2 | #70 | `8a82b94` "Addresses #70 (item S2...)" | `698c1bb` v1.63.1 |

Every item has exactly one implementation commit referencing its issue and one version-bump
commit referencing the same issue, in ascending semver order matching the table's declared
bump size (patch × 5, minor × 1 for L1). Two further commits sit outside the table by design
(both explicitly cross-reference multiple items rather than inventing a phantom item):
- `8e532be`/`8dfa10b` (v1.63.2) — "Addresses #70 #67 #65 #69" — diff-review follow-ups across
  four items, its own bump.
- `bc4ac52`/`966804d` (v1.63.3) — "Addresses #65 #67 #70" — e2e lane/tooling fixes, its own
  bump. (This pair landed *during* this audit — see the process note at the top.)

P1 (live probe) and L2 (deferred) correctly have no commits — the table marks their bump
column "none" / "deferred".

**Verdict: verified.**

---

## Defects found

1. **BUG-LOG.md's BUG-063…067 entries are uncommitted** at the point the batch otherwise
   finished shipping (v1.63.3, current HEAD). Content is accurate and its test-case
   references check out, but per the global Bug Tracking rule the durable log entry belongs
   in the same close-out as the fix, and right now it is one `git checkout -- BUG-LOG.md`
   away from vanishing. Location: `/home/basilgohar/dev/bucketer/.claude-scratch/runs/prefix-access/wt/BUG-LOG.md`.
   Fix is mechanical: commit the file (ideally folded into or immediately after `966804d`, or
   its own small commit) — no code change needed, since the content is already correct.

2. **Process finding, not a code defect:** the worktree HEAD advanced twice
   (`c48c7d9` → `bc4ac52` → `966804d`) while this audit was in progress, changing the answer
   to "is `run.mjs`'s E2E_FILES bug fixed and committed" mid-audit (it went from "no, dirty
   working tree" to "yes, committed at `bc4ac52`/`966804d`"). Anyone reading a QA report
   against a named commit should confirm that commit is still HEAD before trusting a
   pass/fail claim tied to it — it was not, here.

## Coverage gaps

- Claim 2's ✖-name-list cross-check was done for lane 1 (chromium × desktop) of
  `prefix-run-2-prefix.log` only; the remaining 8 lanes were confirmed by aggregate count
  (22/11/11 each) but not individually diffed by test name. Low risk (`node:test`'s runner
  produces deterministic ordering per file and the aggregate matches exactly), but a
  by-name diff of all 9 lanes would close this out completely.
- The matched-pair log artifacts (`prefix-run-2-prefix.log`, `postfix-scoped-run-2.log`)
  report a false top-line "N of 10 lanes FAILED" because of the now-fixed `run.mjs` bug
  (defect note above). Nobody has regenerated these two specific logs against the fixed
  runner, nor do they need to for the evidence to stand — but a future reader of the raw
  log files without this report's context could reasonably conclude the run was red. Worth
  a one-line annotation in the BUG-LOG's "Container evidence" note (or the debrief doc)
  pointing at this so the artifact is self-explaining.
- `docs/superpowers/plans/prefix-access-debrief-2026-09-16.md` (referenced by BUG-LOG as
  holding "the full post-change matrix") and the `.claude-scratch/prefix-access/full-matrix-post.log`
  it presumably backs were not re-verified line-by-line in this audit beyond confirming the
  image tag and pass counts spot-checked in Claim 2/3; they are additional, not
  contradictory, evidence and were not required by the assigned claims.
