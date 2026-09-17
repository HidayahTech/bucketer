# Autonomous run — prefix access (folder share links + prefix-restricted-key connect failure)

Batch: bucketer **prefix-access** — six code items from the synthesized design
`docs/superpowers/specs/2026-09-16-prefix-access-design.md` (panel lanes in
`docs/review-prefix-access/`). Written from `/autonomous-run` Branch 1 on 2026-09-16.
Envelope: `.claude-scratch/runs/prefix-access/run-envelope.md`.

**Repo fit:** bucketer is a static-bundle repo. It has **CI** (GitLab branch pipelines + the
containerised 3×3 e2e matrix on the self-hosted runner `rummaan`) but **no per-MR preview** —
Forge serves the committed `main` bundle, so `main` *is* production. Per the template's
repo-fit note the safety net is thinner, so the batch is six small, independently shippable
items rather than one feature branch of everything, and the operator's final review happens
on the draft MR's diff and the run's screenshots, not a preview. Ships the way the previous
bucketer runs did: feature branch → full local suite → draft MR to `main` (CI on every push)
→ operator merges (or grants the merge in words).

## 1. Scope

Issues filed at kickoff (2026-09-16 16:58 CDT): **E1 = #65**, **E2 = #66**, **E3 = #67**,
**S1 = #68**, **L1 = #69**, **S2 = #70** — https://gitlab.com/hidayahtech/bucketer/-/issues/NN.
Milestone: %5 *Maintenance & Bug Triage* for E1–E3/S1/S2, none for L1 *(session choice —
no milestone fits a small sharing feature; say if you want one created)*.

| Item | Title (issue) | Labels | Bump |
|---|---|---|---|
| **E1** | Failed connect: scroll-and-focus the error, first-class "Set base folder" action, honest copy on both wire shapes | kind::bug, area::ui-ux, effort::M, priority::high | patch **v1.62.4** |
| **E2** | Diagnostics verdict must not blame CORS when a prefix-restricted key is equally likely; mock `corsOnErrors` knob | kind::bug, area::ui-ux, effort::S, priority::medium | patch **v1.62.5** |
| **E3** | A Base folder set on recovery never reaches the saved connection (quick-switch loops) | kind::bug, area::ui-ux, effort::S, priority::medium | patch **v1.62.6** — *loop reproduced live by QA on 2026-09-16 via the quick-switch path; spec measures that path, not a reload* |
| **S1** | Validate and normalize the `prefix` hash param at one read site; guard `region` | kind::security, area::sharing, effort::S, priority::medium | patch **v1.62.7** |
| **L1** | Share a link to the current folder: labelled header menu items, key-ID modifier, breadcrumb copy-link button, file-popover copy | kind::feature, area::sharing, area::ui-ux, effort::M, priority::high | minor **v1.63.0** |
| **S2** | Do not auto-connect a secret-holding tab to a link that changes the connection; banner names Base folder | kind::security, area::privacy, effort::S, priority::medium | patch **v1.63.1** — *session choice: included because the security verdict requires either the fix or an explicit separate-tracking decision; operator may drop it to its own issue* |
| P1 | Live Backblaze B2 probe runbook (operator action; `docs/` one-pager) | kind::docs | none |

- Dependency order: **E1 → E2 → E3 → S1 → L1 → S2.** E2 builds on E1's block; E3 depends on
  QA's reproduction; S1 (the validated reader) lands before L1 (the writer) so every folder
  link ever emitted is read through the validated path; S2 last because it changes an
  auto-connect behaviour and benefits from the L1 e2e cases as regression anchors.
- Suggested versions assume nothing else ships in between; each bump is confirmed with the
  operator at bump time per the versioning rule *(session choice: the run proposes; the
  bump level per item above is the proposal)*.

## 2. Execution mode

- Integration branch `feature/prefix-access` off `origin/main`, in the run's private
  worktree `.claude-scratch/runs/prefix-access/wt`. Never switch the shared checkout's branch.
- **Draft MR to `main` on day one** for continuous CI and diff review; stays draft until the
  operator un-drafts. No preview exists; the branch pipeline is the continuous check.
- Per-item commits referencing the issue (`Addresses #N`, never `Closes`), each followed by
  its version-bump commit (`npm version <x.y.z> --no-git-tag-version`, `npm run build`,
  commit rebuilt `dist/index.html` + `src/lib/changelog.js` + `CHANGELOG.md` together —
  stale-dist guard). Push bump commits with `-c push.followTags=false` (tag race lesson).
- Merge `origin/main` into the branch as soon as anything else lands there; re-run the suite.
- One container e2e matrix run at a time (memory pressure on this host); per-engine split if
  the host OOMs (lesson from the e2e-robustness run).
- Run `npm run format:check` before every push (the blocking format gate is CI-only).
- Carve-outs: none. Every item is small enough to ride the one branch; the operator can
  cherry-pick E1 alone if wanted (it is the highest-value single commit).

## 3. Per-item loop and gates

**E2E Evidence Rules apply in full** (`CLAUDE.md` § Tests): one observable per item (the
design's Items table names it), absence only beside presence, matched-pair on all three
engines for every fix, not-inert evidence for the feature, harness-fidelity statement in
every commit whose behaviour depends on the provider's wire shape.

0. **Baseline first (required):** `npm run test:e2e:container` on the untouched tree once;
   record image tag + browser versions + pass counts in the QA checklist.
1. File the item's issue (title/labels above), assign basilgohar, post a one-line status note.
2. Implement to the design, surgically, matching existing style (Prettier-formatted).
   E1 first because it is the single biggest fix: the two viewport measurements
   (`.claude-scratch/prefix-access/verify-offscreen.mjs`) are the fails-before evidence.
3. **Full local suite before every push** (`npm test`, `npm run test:ui`,
   `npm run test:e2e:node`, `npm run format:check`); never `--no-verify`.
4. Fails-before / passes-after: produce the pre-fix bundle per QA's procedure
   (`docs/review-prefix-access/40-qa-plan.md`), run the item's new spec → FAIL; run on the
   fix → PASS; all three engines in the container. Both runs go in the BUG-LOG entry.
5. Persona reviews alongside the build, read-only, diff attached, findings recorded in the
   QA checklist: **security** on S1, S2 and L1's link builder (its own must-fix list is the
   acceptance bar); **ux-review** on E1 and L1 (screen-truth: viewport screenshots desktop +
   Pixel 5, chromium). qa-verify verifies each item's claims after it lands. One revision
   round; a second failure escalates to the operator, not another lap.
6. Append the item's checks to the **QA checklist as it lands**
   (`docs/superpowers/plans/prefix-access-qa-checklist-2026-09-16.md`).
7. Version bump (propose the level above, confirm with the operator at bump time if the run
   is attended; if walk-away, bump at the proposed level and say so in the debrief), rebuild,
   commit, push, watch CI. Don't merge a red pipeline.
8. BUG-LOG entry for every fix item (durable-log format; PRFT in the item's status note).

## 4. Checkpoints (only these)

- **Design must-stop already passed:** the panel's design is this plan's input; the operator
  confirms it by confirming the envelope.
- **E3 gate:** passed at planning — QA reproduced the quick-switch loop on the current
  bundle (`docs/review-prefix-access/40-qa-plan.md`). The matched pair uses that path.
- **Final review:** the operator reviews the draft MR (diff + CI + the QA checklist's
  viewport screenshots), un-drafts, merges — or grants `merge_prod_branches: main` in words.
- Never autonomous unless granted in the envelope: merging. Never autonomous at all:
  closing issues, prod deploys (a merge to `main` deploys via Forge — that is why the merge
  is the operator's), env, secrets, the GitHub mirror.

## 5. Resumability (a cold session picks up here)

Read: this runbook → the design spec → the issues filed (search the project for the item
titles) → the draft MR and its pipeline → the QA checklist → re-enter §3 on the next item
not yet marked landed. The lane files and `00-facts.md` hold the why.

## 6. Envelope

See `.claude-scratch/runs/prefix-access/run-envelope.md` (drafted without `confirmed:`; the
operator's clear yes arms it).

## 7. Kickoff prompt

`/autonomous-run` in a fresh session inside `~/dev/bucketer` → Branch 0 → resume
`prefix-access`; the skill bootstraps from this runbook.

## 8. Debrief

Filed as `docs/superpowers/plans/prefix-access-debrief-<date>.md` per the template §8; the
run's last step before pinging the operator. Includes the spawn audit (this planning phase:
3 read-only reviewers in wave 1 — architect and security on the session model, ux-review on
Opus — and 1 qa-verify on Sonnet in wave 2; all read-only, each with one lane file as write
territory).
