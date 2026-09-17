# Autonomous run — prefix-access — debrief

Run: `prefix-access` · runbook `prefix-access-execution-plan-2026-09-16.md` · design
`../specs/2026-09-16-prefix-access-design.md` · panel lanes `../../review-prefix-access/` ·
branch `feature/prefix-access` · draft MR !18 — https://gitlab.com/hidayahtech/bucketer/-/merge_requests/18 ·
operator confirmed 2026-09-16 16:53 CDT · debrief written 2026-09-16 evening CDT.

## Merges performed and grant changes

- During the build: **none.** `merge_branches` and `merge_prod_branches` stayed empty.
- After the final review (addendum, 2026-09-16 20:23–20:26 CDT): the operator said
  "merge !18. Approved." and, to the prod-confirmation question, "yes, merge to main".
  Grant written: `merge_prod_branches: main` (one-off). !18 was un-drafted
  (`glab mr update 18 --ready`) and merged (`glab mr merge 18`) → `main` @ 16d6958
  (merge commit over 4229d71). Grant then cleared. Both pipelines on 4229d71 were green
  before the merge (full 3×3 browser matrix on the runner). The automatic Forge deploy of
  16d6958 failed on Forge's side ("cat: ~/.forge/provision-219102094.output: No such file";
  disk 65%, `.forge` writable, no step ran on the server); the operator re-deployed by
  hand at ~20:29 CDT. Live verified 20:30 CDT: app-version 1.63.3, live bundle SHA-256
  b21281b19628… identical to the committed dist/index.html on main.

## Planned vs shipped

| Item | Issue | Planned | Shipped |
|---|---|---|---|
| E1 | #65 | scroll-and-focus, hint block + Set base folder, both wire shapes, code gating, quick-switch title | shipped, v1.62.4 (+ `E2E_FILES` runner filter, needed for the matched pairs) |
| E2 | #66 | honest diagnostics verdict, mock `corsOnErrors` | shipped, v1.62.5 |
| E3 | #67 | persist discovered floor (after QA reproduction) | shipped, v1.62.6 — QA reproduced the loop on the quick-switch path and corrected the observable (reload would have been a proxy) |
| S1 | #68 | validated prefix intake, region guard | shipped, v1.62.7 |
| L1 | #69 | header menu (labelled) + key-ID modifier + breadcrumb 🔗 + popover copy + README | shipped, v1.63.0 |
| S2 | #70 | no auto-connect on differing link, banner enumerates | shipped, v1.63.1 |
| — | — | unplanned: diff-review follow-ups (security S-1/S-2/S-4, UX 1–3, README wording) | shipped, v1.63.2 |
| P1 | — | live Backblaze probe runbook (operator action) | written: `prefix-access-live-probe-runbook-2026-09-16.md` |
| L2 | — | selection-bar folder link | deferred, as planned |

Eight version bumps in total (six planned + one follow-up patch); every fix has a BUG-LOG
entry (BUG-063…067) and matched-pair evidence; the feature has not-inert evidence.

## What the panel found that the request did not say

- The operator's "no explanation" was not a copy problem: the explanation rendered ~200px
  below the fold with focus on `<body>` on every viewport. Full-page screenshots hid it;
  viewport screenshots showed it. (UX lane, re-measured by the EM.)
- A Base folder typed on recovery never reached the saved connection, so quick-switch
  looped — and a same-tab reload happened to work, which would have made a naive test pass
  on broken code. (Architect by code reading; QA reproduced live.)
- The navigation prefix was the one hash param read raw; "New folder" under a slash-less
  link prefix wrote a sibling key. (Security lane, demonstrated at unit level.)
- A secret-holding tab auto-connected to any endpoint a pasted link named. (Security lane;
  pre-existing; fixed as S2 because folder links multiply such links.)

## Evidence

- Baseline: untouched `origin/main` @ 0b24aea in a detached worktree; image
  `mcr.microsoft.com/playwright:v1.60.0-noble`; node 64/64; nine browser lanes 66 tests
  each, 0 failures.
- Pre-fix run 1 (`E2E_FILES=prefix-scope`, pre-fix source + new spec/mock/runner): all
  nine lanes fail every new case and pass every pre-existing case (chromium lanes 4/11 pass,
  firefox/webkit lanes 5/14 pass after the final spec landed mid-run). Exit 1.
- Pre-fix run 2 (final prefix-scope + profiles specs, pre-fix source): every lane 22 tests,
  11 pass / 11 fail — the eleven failures are exactly the new cases (E1 ×3, E2, quick-switch
  title, E3, S1, L1 ×2, S2 ×2), every pre-existing case passes. Exit 1. Log
  `.claude-scratch/prefix-access/prefix-run-2-prefix.log`.
- Post-fix scoped run 1 (same two specs, 3×3, at 8dfa10b): desktop chromium and webkit
  22/22; mobile lanes and all firefox lanes failed 1–3 cases each — all three causes were in
  the specs, not the product (the header tab strip is `display:none` below 640px so the
  quick-switch cases need the sidebar path; a pinned Pixel 5 context must go through
  `applyEngineQuirks` for Firefox; the hash-change case raced the failed state's listener).
  Fixed in c48c7d9 (test-only).
- Post-fix scoped run 2 (at c48c7d9): **every lane 22/22, 0 failures** — chromium, firefox,
  webkit × desktop, Pixel 5, iPhone 13. Log
  `.claude-scratch/prefix-access/postfix-scoped-run-2.log`. (The runner's exit 1 on the
  scoped runs came from the `E2E_FILES` filter refusing the node layer; fixed afterwards in
  run.mjs.)
- Full post-change matrix (3×3, all specs) was started locally and **stopped at the
  operator's direction** after the node layer (67/67) and the three chromium lanes
  (77/75/75, 0 failures) had passed: v1.62.3 deferred the browser matrix to CI, and a
  local full matrix duplicates the branch pipeline. The scoped matched-pair runs stay
  local because CI cannot run a pre-fix bundle. **Reconciliation for the operator:** the
  repo's `AGENTS.md` still says "Baseline first … runs the full container matrix once on
  the untouched tree" and the auto-memory rule says "always run the container matrix for
  UI changes"; both predate v1.62.3 and drove this run's extra local matrices. If the
  intent is "CI is the full matrix; local container runs only for matched pairs", the
  Baseline-first rule and the memory note should say so.
- Host chromium at the end: prefix-scope 14/14, profiles 8/8; unit 1616/1616; component
  573/573; node e2e 67/67; lint, dead-code, format clean; pre-push hook green on both pushes.
- CI on the branch: pipelines 2856129375 / 2856142398 / 2856142430 stayed **pending** for
  the whole run — every job, including `test` and `lint` — which points at the self-hosted
  runner being unavailable, not at the code. Operator to check the runner; the local
  container matrix is the run's evidence.
- Persona reviews on the built diff: security `31-security-diff-review.md` (ship-after-
  fixes → fixed in v1.63.2, no rotation items); ux-review `21-ux-built-review.md`
  (ready-with-nits → items 1–3 fixed in v1.63.2; F1–F8 disposition table inside);
  qa-verify `41-qa-evidence-audit.md` (all seven claims verified: BUG-LOG test cases
  exist where named, matched pair 11/11 → 22/22 with the same image on every lane,
  baseline at 0b24aea, observables not proxies, harness-fidelity wording verbatim, suites
  green, item→commit→version mapping clean; one defect — the BUG-LOG block was still
  uncommitted at audit time, committed in the closing docs commit).

## Wall clock, touches, cost

- Planning (panel + runbook): 16:20 → 16:53 CDT (~35 min). Build: 16:53 → ~19:10 CDT
  (~2.3 h), of which roughly 45 min was container time that the operator's direction at
  19:03 makes unnecessary next time.
- Operator touches: 4 (batch definition; confirm + "no B2 labels" + ntfy request; a status
  question; "defer the full matrix to CI").
- Subagents: planning wave 1 — architect (session model), ux-review (Opus), security
  (session model); wave 2 — qa-verify (Sonnet); build — security (session model),
  ux-review (Opus). Six spawns, ≤3 concurrent, all read-only, ~0.9M subagent tokens
  (planning ~630k, build ~315k). Session model tokens: not measured.

## Guard blocks

- 2 × `run-envelope-guard: BLOCKED — push to '>' / '2>&1'`: the guard takes the last token
  of a push command as its destination, so a redirected or piped push is refused even to an
  allowed branch. Re-ran as a bare `git push`. Suggested guard fix: parse the destination
  from the argument list, ignoring shell operators.

## Lessons worth keeping (→ milestone-orchestration-mode.md)

1. **Baseline in a separate untouched worktree.** The container matrix rebuilds
   `perf/index.html` per lane from the worktree it is mounted on, so a baseline started in
   the run worktree is contaminated the moment source is edited. The first baseline here was
   killed for that reason; the second ran in a detached worktree at `origin/main`.
2. **Screen truth means viewport capture.** The design brief's full-page screenshots made
   an off-screen error look visible; only `getBoundingClientRect` vs `innerHeight` (and
   `document.activeElement`) exposed the real defect. The e2e observable is geometry, not
   `textContent.includes`.
3. **`E2E_FILES` makes matched pairs affordable** — one spec across nine lanes instead of
   the whole suite, twice per item.
4. **QA reproduction changes the observable.** The plan's "reload works after recovery"
   would have passed on pre-fix code; only the reproduction showed the quick-switch path
   was the one that looped.
5. **The guard hook parses the last push token as the branch** — never redirect a push.
6. **`sed -i` on a symlinked instruction file replaces the symlink** (CLAUDE.md →
   AGENTS.md). Edit the target.
7. **The pre-push hook tags only the final `package.json` version.** Batched bumps
   (v1.62.4–v1.63.1 pushed together) get one tag (v1.63.1); the intermediate tags do not
   exist. Either push after each bump or accept tag gaps (this run accepted them and
   pushed v1.63.2 separately).
8. **Node 22's `globalThis.navigator` is a getter** — stub with `Object.defineProperty`.
9. **Prettier on a Markdown file reformats the whole file.** The format gate covers JS
   only; don't pass `.md` files to `prettier --write`.
10. **Local container runs are for matched pairs only; CI is the full matrix** (operator,
    2026-09-16 19:03). The Baseline-first rule and the "always run the container matrix"
    memory note need rewording to match v1.62.3 — until then a run will over-spend on
    local matrices, as this one did (one baseline + one abandoned full matrix ≈ 45 min of
    container time beyond the matched pairs).
