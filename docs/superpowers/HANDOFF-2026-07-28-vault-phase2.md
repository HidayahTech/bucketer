# Handoff — Vault Phase 2, paused mid-execution

**Written:** 2026-07-28
**Branch:** `vault-phase2` (12 commits ahead of `main`, **nothing pushed**)
**`main`:** `029d530`, pushed, deployed. v1.39.1 is live.

---

## Read these first, in order

1. `.superpowers/sdd/2026-07-27-vault-phase2/progress.md` — the full SDD ledger.
   Every task, every finding, every ruling and why. This is the authoritative record.
2. `docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md` — **DRAFT**
   redesign of the piece that failed review. Two decisions locked, rest unapproved.
3. `docs/superpowers/specs/2026-07-26-login-vault-design.md` — the parent spec,
   including its "Phase 1 as-built" reconciliation section.
4. `docs/superpowers/plans/2026-07-27-vault-phase2.md` — the 7-task plan being executed.

The ledger survives compaction; this document does not replace it.

---

## What shipped (done, live, no action needed)

**v1.39.0 + v1.39.1** — Phase 1, the connection model. `main` is deployed via
Laravel Forge on push, so it is in production now.

- Flat `s3b_profiles` replaced by `s3b_credentials` + `s3b_connections`.
- Capability state moved off the global key onto each connection.
- `BUG-045` (deleted connection resurrected by a derived migration sentinel) and
  `BUG-046` (form blanked when a storage write silently failed) logged and fixed.
- `BUG-047` (share links did nothing when Bucketer was already open — fragment-only
  navigation never reloads) fixed in v1.39.1.
- CI expanded: component tests, a stale-`dist` guard, reproducibility on every
  pipeline. Issue #53 filed and later fixed on this branch.

---

## Where Phase 2 stands

| Task | State |
|---|---|
| 1 — collect superseded credential (#53) | ✅ complete, 1 fix round |
| 2 — vault crypto core | ✅ complete, 1 Important overruled with evidence |
| 3 — vault record + cascade | ✅ complete, 1 fix round |
| 4 — unlock lifecycle + session key | ✅ complete, clean first pass |
| 5 — VaultUnlock component | ✅ complete, 2 fix rounds |
| 6 — wire into App.jsx | ⚠️ **committed but NOT accepted** — see below |
| 7 — inspector, manual QA, release v1.40.0 | ⛔ not started |

Suites at last run: 1104 unit, 405 component. `npm test` and `npm run test:ui` both
pass on the branch — **the failing parts are design defects, not red tests.**

### Task 6 is the blocker

Commit `78b5e40` is on the branch and its review found **2 Critical + 5 Important**,
all in the post-connect offer's accept flow — the one piece the plan never specified.
The specified work (the `locked` session state, ordering discipline, the source
invariant, auto-connect fallback, re-wrap on save, `CredentialForm` `name`
attributes) was approved and is sound.

**Do not ship Task 6 as it stands.** The operator chose to redesign the accept flow
rather than patch it. `78b5e40` stays on the branch; the redesign replaces that flow.

The two Criticals, in one line each:

- **C1** — a passphrase typo at setup locks the user out of the whole app. The lock
  screen replaces the connect form and reset is offered only for `corrupt`.
- **C2** — accepting after rotating a key wraps the secret under a credential the
  connection does not point at. Auto-connect then never fires and an unreachable
  orphan is left behind.

---

## Resume here

The brainstorming session was interrupted **after** two decisions were locked and
**after** the design was presented, but **before** approval.

1. **Re-present the draft design** (`2026-07-28-vault-creation-flow-design.md`)
   section by section for approval. The two locked decisions do not need revisiting:
   *offer scope = only remember, never create*, and *placement = inline banner plus a
   permanent home in Storage & Privacy*. The escape hatch and confirmation field are
   also operator-chosen.
2. On approval → `superpowers:writing-plans` for a **revised Task 6**.
3. Then resume `superpowers:subagent-driven-development` against the existing ledger.
   Tasks 1-5 are complete — **do not re-dispatch them.** Task 6 restarts; Task 7 follows.
4. Task 7 ends at a **manual password-manager matrix** (Chrome, Firefox, KeePassXC,
   Vaultwarden). It cannot be automated and it gates the release. That is the next
   point where the operator is needed.

---

## Things that will bite if forgotten

- **Pushing `main` deploys to production immediately** via a Forge webhook,
  independent of CI. The pre-push hook (build + unit + component + e2e-node) is the
  real gate. `dist/index.html` is tracked and *is* what ships.
- **Task 6 forgot to rebuild `dist`.** Fixed in `4b917e2`. The CI stale-dist guard
  would have failed the branch. Rebuild after any source change.
- **`npm run serve` overwrites `dist/index.html` with a dev build.** Always
  `npm run build` afterwards and check `git status`.
- **The plan's own code has a defect rate.** Phase 1's plan dictated implementations
  and seven of its blocks carried defects, all transcribed faithfully into commits.
  Phase 2's plan gives verbatim *tests* + exact interfaces and lets implementers
  derive the code — and every finding since has been in the specification rather
  than the implementation. Keep that format.
- **Implementers catching the plan out is the system working.** This run: one
  correctly exceeded an insufficient instruction, one found a parse error in the
  plan's test code, one flagged two brief gaps pre-review, one found a *vacuous test
  that review had already approved*. Ask for that explicitly in dispatches.
- **Verify reviewer claims before acting.** One Important was overruled after
  container-testing `node:18.0.0` — `globalThis.crypto.getRandomValues` is present at
  the declared floor, so the claimed crash did not exist. Recorded, not discarded.

---

## Open items not on the critical path

- Deferred minors are listed in the ledger, each with a ruling. The whole-branch
  review at the end of Phase 2 should triage them.
- GitLab **#53** is fixed on this branch but the issue is still open — close it when
  Phase 2 merges.
- Pipeline **#197** (tag `v1.39.0`) failed on a flaky `webkit × iPhone 13` batch-move
  spec, which skipped the release job — so **v1.39.0 has no published artifact**.
  v1.39.1 published fine. A missing manifest reads as `no-manifest`, not a tamper
  warning, so exposure is closed, but the flake will eat another release eventually.
- Untracked planning docs from earlier sessions still sit in the working tree.
