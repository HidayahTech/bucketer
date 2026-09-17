# Prefix-access run — QA checklist (appended as items landed)

Run: `docs/superpowers/plans/prefix-access-execution-plan-2026-09-16.md` · MR !18 —
https://gitlab.com/hidayahtech/bucketer/-/merge_requests/18 · branch `feature/prefix-access`
off `origin/main` @ 0b24aea.

## Baseline (required before any change)

Full container matrix on the untouched tree (detached worktree at `origin/main` @ 0b24aea,
because the run worktree's source was already edited when the first attempt started — that
attempt was killed and discarded). Image `mcr.microsoft.com/playwright:v1.60.0-noble`,
podman. Node layer 64/64. Browser lanes (chromium/firefox/webkit × desktop/Pixel 5/iPhone 13):
66 tests each, 0 failures, skips 1/3/3/3/1/3/3/3/4/4 (device-gated). Log:
`.claude-scratch/prefix-access/baseline-matrix.log`.

## Per item — observable, evidence, sideways

| Item | Observable measured | Host chromium | Unit / component | Container matched pair |
|---|---|---|---|---|
| E1 #65 | error block inside viewport + focused after denial; Set base folder → `#cred-baseprefix` active and in view (desktop + Pixel 5); no hint on SignatureDoesNotMatch; failed switch titled "Couldn't open <bucket>" | prefix-scope 8/8 at the time (14/14 final) | error-block +10 cases (560); unit 1580 | pre-fix: FAIL (see below) · post-fix: pending |
| E2 #66 | masked shape (corsOnErrors:false, MinIO override): opaque error, two-cause block, Set base folder present, verdict "both causes above are still open", no "almost certainly"; root list reached mock | 9/9 | diagnostics +5 (1585); mock self-tests 45/45 | same runs |
| E3 #67 | after recovery the saved record carries the floor; quick-switch renders a floor row with no root list | 10/10 | base-prefix +3 (1588) | same runs |
| S1 #68 | `#prefix=clients/acme/sub` lists `…/sub/` never the bare string; New folder PUTs `…/sub/Reports/` | 11/11 | base-prefix +3, url-params +5 (1596); browser-base-prefix +2 (562) | same runs |
| L1 #69 | breadcrumb 🔗 copies a link with prefix+basePrefix, no keyId; recipient lands inside sub/ (mock lists sub/, never root/floor first); header menu same link, top item no folder; no button at the floor | 14/14 | url-params +3, connection-link 11 (1610); share-link-menu 10, browser-internals +3 (570) | not-inert: pre-feature FAIL (see below) · post: pending |
| S2 #70 | differing link → form with link values, secret cleared, banner "endpoint, bucket", no file-input, second mock's log empty; same-values link still auto-connects | profiles 7/7 | url-params +6 (1615) | same runs |

Local gates on the finished branch: `npm run lint` clean, `npm run deadcode` clean,
`npm run format:check` clean, `npm run test:e2e:node` 67/67, pre-push hook green on push.

## Screen truth (viewport captures, chromium)

- Pre-fix failed screen: `.claude-scratch/prefix-access/verify-offscreen.mjs` → desktop
  `{vh:720, top:914, bottom:1148, focused:false}`, Pixel 5 `{vh:727, top:931, bottom:1260, focused:false}`.
- Post-fix (E1): `.claude-scratch/prefix-access/e1-shots/` → desktop `{top:225, bottom:496,
  focused:true}` then field `{top:344, bottom:376, focused:true}`; Pixel 5 `{top:199,
  bottom:527, focused:true}` then field `{top:347, bottom:379, focused:true}`.
- L1: `.claude-scratch/prefix-access/l1-shots/` — header menu in a subfolder (desktop +
  Pixel 5), breadcrumb 🔗 (32×32 box on both), per-file popover. One defect found and fixed
  before commit: the modifier label inherited the header's white text (invisible on the
  popover); now `color: var(--text)`.

## Persona reviews (read-only, on the built diff)

- security (session model): `docs/review-prefix-access/31-security-diff-review.md` —
  ship-after-fixes (S-1, S-2 blocking; S-3, S-4 should-fix); all four fixed in v1.63.2.
- ux-review (Opus): `docs/review-prefix-access/21-ux-built-review.md` — ready-with-nits;
  findings 1–3 fixed in v1.63.2; F1–F8 disposition table inside.
- qa-verify (Sonnet): `docs/review-prefix-access/41-qa-evidence-audit.md` — all seven
  evidence claims verified against the logs and HEAD; BUG-LOG committed afterwards.

## Container matched pair — to be filled

- Pre-fix run 1 (`E2E_FILES=prefix-scope`, source = origin/main + new spec/mock/runner):
  chromium lanes ran the 11-case spec (4 pass / 7 fail each); firefox and webkit lanes
  picked up the 14-case final spec mid-run (5 pass / 9 fail each) — the extra pass is "no
  breadcrumb link button at the floor", trivially true pre-feature. Log:
  `.claude-scratch/prefix-access/prefix-scope-prefix-run.log`.
- Pre-fix run 2 (final specs prefix-scope + profiles, pre-fix source): nine lanes × 22
  tests, 11 pass / 11 fail each — the eleven new cases fail, every pre-existing case passes.
  Log: `.claude-scratch/prefix-access/prefix-run-2-prefix.log`.
- Post-fix scoped run (both specs, 3×3): run 1 at 8dfa10b exposed three spec-lane defects
  (tab strip hidden on mobile; Firefox rejects a pinned isMobile; hashchange listener race),
  fixed in c48c7d9; run 2 at c48c7d9 **22/22 on every lane**. Logs
  `.claude-scratch/prefix-access/postfix-scoped-run.log` and `…-2.log`.
- Full post-change matrix (3×3, all specs): started locally, stopped at the operator's
  direction after node 67/67 + chromium desktop/Pixel 5/iPhone 13 (77/75/75, 0 failures);
  CI is the full-matrix check per v1.62.3. Log `.claude-scratch/prefix-access/full-matrix-post.log`.
- CI pipelines on the branch: https://gitlab.com/hidayahtech/bucketer/-/pipelines — the
  self-hosted runner was idle for the first hour (every job pending); the pipeline on the
  final commit is the one to read before merging.

## Guard blocks

- 2 × `run-envelope-guard: BLOCKED — push to '>' / '2>&1'`: the guard reads the last
  token of a push command as its destination, so a redirected/piped push is refused even
  for an allowed branch. Re-ran as a bare `git push` (allowed). Lesson for the guard hook.
