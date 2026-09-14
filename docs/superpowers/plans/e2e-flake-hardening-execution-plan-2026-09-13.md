# Autonomous run — E2E flake hardening (execution plan, 2026-09-13)

Operator-directed follow-up to the v1.60.0 dead-code arc: eliminate the chronic
mobile-lane e2e flakiness that reddened pipeline #308 (and prior releases) so CI
is consistent going forward. Two fixes, their own effort, their own version bump.

**Repo fit:** bucketer ships a committed static bundle (Forge serves it); there is
**no per-MR preview** and no ephemeral deploy. Safety net = the pre-push hook
(build + full suite incl. e2e) + CI stale-dist/invariant guards + the new blocking
`deadcode` job. Batch is small (2 tightly-scoped, behaviour-preserving items), so
the thinner net is fine. A draft MR to `main` gives CI-on-branch + a review record
before merge; merge stays operator-gated.

## 1. Scope

The flakes are all one antipattern: **absolute-time waits under variable CI CPU
load.** Evidence gathered this session: webkit-mobile sort (`descending name order`,
5000 ms hand-rolled poll blown at ~7 s) in pipeline #308; firefox-mobile batch-delete
in the prior release v1.59.3 (85a56a6, no code changes) — a *different* test each run,
i.e. lane-level not code-level. Two currently-unmitigated amplifiers, both confirmed:
no CI job retry on the e2e lanes, and no per-lane timeout scaling (slowest lane runs
on the same thresholds as fastest).

- **Item A (#1) — CI job retry.** Add `retry` to the two browser-e2e job templates so
  a single flaked lane auto-heals instead of reddening the pipeline (what I retried by
  hand 3× this session).
- **Item B (#2) — per-lane timeout scaling.** Give slower lanes (webkit, mobile device
  profiles) proportionally more time via one lane factor, applied to Playwright's
  default timeout **and** the harness's shared deadline helpers **and** the known
  inline poll deadlines that flaked. Converts "flaky" → "slow but correct."

Dependency order: A and B are independent; ship both in one branch. Neither changes
product behaviour — test-infra + CI only.

## 2. Execution mode

- Integration branch `feature/e2e-flake-hardening` off `origin/main`, in a private
  worktree under `.claude-scratch/`. Never switch the shared checkout's branch.
- **Fast-forward merge to `main`, no MR** (operator choice 2026-09-13, "use fast forward
  like last time" — matches the dead-code arc). The feature branch stays local; only `main`
  is pushed, once, at the end. No preview stack exists — expected here.
- Per-item commits. Full suite locally before the final push; never `--no-verify`.
- The push to `main` is gated on the version-bump confirmation (§4) — that checkpoint is the
  final gate, as it was last time. Carve-outs: none.

## 3. Per-item loop and gates

1. Post a one-line status note (issue number + title + plain effect, if an issue is filed).
2. Implement to spec, surgically, matching existing harness style.
3. **Full unit+component+e2e locally before every push.** Container e2e per-engine
   (serialized desktop lanes — full 3×3 OOMs this host), same image as CI.
4. Deterministic proof for each item (see §3a) — the flake itself is nondeterministic,
   so the artifacts are the pure-function tests + the config guard + a green matrix,
   not a fail-before/pass-after of the flake.
5. Optional qa-verify persona review of the diff before merge (read-only). Likely
   solo — this is small.

### 3a. Verifiable artifacts (E2E Evidence Rules — adapted for test-infra)

- **Item A:** a source-invariant test (`test/source-invariants.test.js`) asserting the
  `e2e-browser` and `e2e-browser-webkit` jobs in `.gitlab-ci.yml` declare `retry` with
  `max: 2`. Fails before (no retry key), passes after — locks the config against silent
  regression. The auto-heal *behaviour* is GitLab-runtime and not unit-testable; the
  guard is the durable artifact.
- **Item B:** a pure unit test for `laneTimeoutFactor()` / `scaleTimeout()` — asserts the
  factor per (engine, device) combination and that `scaleTimeout` scales accordingly.
  Fails before (functions don't exist), passes after.
- **Both:** the full container e2e matrix green (serialized per-engine) after the change,
  proving scaled timeouts didn't break any spec. Record the image tag
  (`mcr.microsoft.com/playwright:v1.60.0-noble`) + that lanes ran serialized.
- **Harness fidelity note (commit msg):** the retry auto-heal cannot be represented in
  the local harness ("no e2e coverage: harness cannot represent GitLab job retry"); the
  config guard test is the substitute.

## 4. Design decisions (session choices — operator left them open)

- **A1 (session choice):** `retry: { max: 2, when: [script_failure, stuck_or_timeout_failure, runner_system_failure] }`
  on `e2e-browser` and `e2e-browser-webkit` only. Deterministic jobs (`test`, `deadcode`,
  `e2e-node`, `reproducibility`) get **no** retry — a real failure there is real. Trade-off:
  a genuine deterministic e2e regression now runs up to 3× before failing (costs CI time,
  still fails). Accepted: healing the flakes requires retrying `script_failure`, and 3×
  time on a true break is cheaper than chronic red pipelines + manual retries.
- **B1 (session choice):** lane factor = `(engine === 'webkit' ? 2 : 1) × (deviceProfile ? 1.5 : 1)`
  → chromium/firefox desktop 1.0, webkit desktop 2.0, chromium/firefox mobile 1.5,
  webkit mobile 3.0. Derived from the empirically-slow lanes (webkit-mobile is where the
  flakes concentrate).
- **B2 (session choice):** apply the factor in three places so it actually reaches the
  observed flakes: (i) `page.setDefaultTimeout(scaleTimeout(BASE))` in the harness page
  factory — covers every Playwright-native wait that passes no explicit timeout (e.g. the
  batch-move 30 s click); (ii) the shared `waitForKeys`/`waitForCount`/`waitForHttp`
  default deadlines wrapped in `scaleTimeout`; (iii) the one inline poll deadline that
  flaked — the sort spec's `5000` → `scaleTimeout(5000)`. This is *scaling*, not rewriting
  assertions — the per-spec web-first-assertion rewrite (#3) stays out of scope.
- **B3 (session choice):** do **not** blanket-scale every explicit `timeout:` literal in
  every spec (that's #3's audit). Scale only the shared helpers + the proven offender.
  Rationale: surgical; avoids touching ~26 spec files for a hardening pass.
- **Version (session choice → confirm with operator per versioning rule):** patch bump
  **v1.60.0 → v1.60.1** — test-infra + CI, backwards-compatible, no user-facing behaviour.
  CHANGELOG entry + rebuilt `dist/index.html` + `src/lib/changelog.js` in the bump commit
  (stale-dist guard). I will present the change summary and confirm the bump level before
  bumping.

## 5. Resumability

Read: this runbook → the draft MR + its pipeline → the branch state → re-enter §3 on the
unfinished item. Both items are single-file-ish; per-item commits checkpoint them.

## 6. Envelope

See `.claude-scratch/run-envelope.md` (written alongside this plan, unconfirmed until the
operator hands off).

## 7. Debrief (last step)

File `docs/superpowers/plans/e2e-flake-hardening-debrief-2026-09-13.md`; append a run-log
row + any lessons to `milestone-orchestration-mode.md` in the knowledge repo (Tier 2, per
its AGENTS.md); then send the operator the MR URL + title, the "no preview (static bundle)"
note, and the debrief path.
