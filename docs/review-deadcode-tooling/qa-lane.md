# QA Lane — Gate Policy and Proof for Dead-Code Tooling

Scope: policy only (blocking vs advisory, baseline strategy, acceptance proof). Tool
selection is another lane's call; this lane treats it as "the tool" and states the
capabilities the policy below assumes it has.

## 1. Recommendation

**Blocking in both pre-push and CI, using a ratchet baseline — not advisory anywhere.**
This repo's culture has already answered the blocking-vs-advisory question by precedent:
the pre-push hook blocks on build+unit+component+e2e, and the operator has explicitly
rejected "let CI gate it" as a way to defer enforcement for exactly this kind of change
(`feedback-always-container-e2e`). An advisory dead-code check would be the first gate in
this repo that is *allowed* to be red, which both breaks the pattern and predicts its own
neglect — an advisory finding is a finding nobody is on the hook to act on. The reason
this doesn't force a "clean to zero first" slog is the ratchet: the gate fails only on
findings **not already in a committed, reviewed baseline file**. That makes the gate
blocking and green on day one simultaneously — the ~40 test-only exports, the dormant
vault module, and the genuinely-dead CSS classes all get baselined once, deliberately,
with a reason each; anything found afterward that isn't in that file fails the push/pipeline.
Pre-push runs it because it's static analysis (no browser, seconds not minutes) and catches
the mistake before it leaves the laptop; CI re-runs it as the non-bypassable backstop per
this repo's own Verification Gate framing ("the hook is client-side and bypassable by
design; build invariants are the backstop").

## 2. Baseline mechanism

A single committed JSON file, e.g. `deadcode-baseline.json` at repo root (sibling to
`package.json`, alongside other config), holding one entry per accepted finding:

```json
{
  "file": "src/lib/vault.js",
  "identifier": "unlockVault",
  "kind": "export",
  "reason": "dormant-feature",
  "note": "Login-vault Phase 2, gated off — see project-login-vault memory / #52",
  "added": "2026-09-13"
}
```

- **`reason` is a closed enum** (`dormant-feature`, `test-only`, `todo-remove`) with a
  required `note`. A structural test (see §4) rejects any entry missing either field —
  this is what stops the baseline from becoming an unreviewable dumping ground.
- **Reviewed by construction, not by process**: because the baseline is a tracked file, any
  MR that *adds* an entry shows it in the diff like a suppression comment — a reviewer sees
  "adding N unused-export exceptions" and can ask why, the same way they'd question a new
  `eslint-disable`. No separate review ritual is needed beyond normal code review.
- **Prevented from rotting via a shrink check, not just a grow check**: the gate script
  diffs the tool's current findings against the baseline in both directions. New findings
  not in the baseline → fail (the ratchet's teeth). Baseline entries that no longer appear
  in current findings (because someone fixed or removed the code) → **also fail**, with a
  message telling the contributor to delete the stale entry. This is the piece that stops
  the baseline from silently growing over time into a place dead code goes to hide forever:
  it can only shrink or turn over, never coast. It is exactly the friction the repo already
  accepts elsewhere (BUG-LOG entries get closed, not left stale) — see `#4` open risk below
  for the cost of this choice.
- **Periodic review trigger, not calendar-based**: the two entries that are load-bearing
  reasons rather than permanent design (`dormant-feature` for vault, and any `todo-remove`
  entry) should be linked to the tracking issue that will resolve them (vault: whatever
  issue gates it on; per `project-login-vault` memory it currently has no CHANGELOG entry
  and blocks the branch merge — that issue is the natural place to also close the baseline
  entry). `test-only` entries don't need a tracking issue; they're a standing category, not
  a to-do.

## 3. Acceptance procedure

This cannot be marked verified by this lane alone — no dead-code tool is installed in
`package.json` yet (checked: `devDependencies` currently has only `esbuild`,
`fake-indexeddb`, `jsdom`, `playwright`), so the steps below are the **procedure the
integrating lane must run and paste output from**, not a result already obtained.

Seed / verify, in order, on the actual chosen tool:

1. **True positive (fails-before/passes-after pair).**
   - Add one throwaway unused export to a real source file not touched by any other
     change, e.g. `export function __deadcodeProbe() { return 1; }` appended to
     `src/lib/format.js`, referenced from nowhere (not even a test).
   - RED: run the gate script with the current baseline. Expect nonzero exit, and the
     tool's own output naming `format.js:__deadcodeProbe` as a new (non-baselined) finding.
   - Remove the probe export.
   - GREEN: re-run the gate script. Expect zero exit, no diff against baseline.
   - This is the matched pair the repo's own discipline requires (mirrors the BUG-LOG
     fails-before/passes-after convention) and is the only step that actually proves the
     tool detects real dead code rather than always passing.

2. **False positives must be zero-finding via tool config, never via baseline.** This is a
   distinction the baseline mechanism above does not enforce by itself, so state it here
   explicitly: a false positive means the tool is *wrong*, and the fix is telling the tool
   the truth (an entry-point glob, an ignore pattern, a dynamic-usage annotation) — not
   adding a baseline row. Baselining a false positive would hide it as if it were accepted
   debt, and a later change that made the code *actually* dead (e.g. the worker build step
   removed) would never be caught because the baseline entry already excuses it forever.
   Verify both known cases produce **no finding at all**, not a baselined finding:
   - `src/worker/zip-assembler.worker.js` — referenced only as a string `entryPoints` value
     in `build.mjs` (line 131), never `import`ed. Confirm the chosen tool has a mechanism
     for declaring extra entry points (most import-graph tools need this — e.g. an
     `entry`/`include` config key) and that pointing it at this file makes the finding
     disappear. If the tool has no such mechanism, that is a real gap in the tool's fit for
     this codebase, not something to paper over with a baseline entry — report it as a
     defect in tool choice, not accepted debt.
   - Dynamic CSS classes composed as `toast-${type}` resolving to `.toast-error` /
     `.toast-success` (and any other template-literal-composed class name in the codebase —
     worth a quick grep before signing off, not just trusting the one example named in the
     brief). Confirm the tool's CSS-usage config (safelist / dynamic-class pattern) makes
     these zero-finding, not baselined.

3. **Gray case — test-only exports.** Pick one named, real example (the integrating lane
   should name the specific file:export when doing this; this lane didn't run the tool so
   can't name one from real output). Decide and prove one of two configurations:
   - (a) the tool is configured to treat `test/**/*.test.js` and `test/components/**` as
     usage sources, in which case a genuinely test-only export should show **zero
     findings** — verify by running the gate with that config and confirming the named
     export is absent from output; or
   - (b) test files are excluded from the usage graph on purpose (stricter — "used only by
     tests" is itself the debt being surfaced), in which case the export must appear as a
     finding and be baselined with `reason: "test-only"` — verify it's present in output
     and present in the baseline, and that removing the baseline entry while leaving the
     export in place produces RED.
   Whichever configuration is chosen, "no test-only export baselined AND flagged as if it
   were unowned" is the failure mode to check for — it would mean the ~40 exports are both
   generating gate noise and never getting a decision made about them.

4. **Gray case — dormant vault.** Confirmed by this lane (not by the tool, since none is
   installed): `src/lib/vault.js` is imported by `VaultUnlock.jsx`, `App.jsx`,
   `secret-cache.js`, `storage.js`, and `connections.js` — it is not an unreferenced file,
   so a whole-file "unused file" check should already report zero findings for it with no
   baseline entry needed. The gray area is narrower than "the file is dead": it's whichever
   *individual exports inside* vault.js are reachable only from the gated-off code path.
   The integrating lane must run the tool, look at what it actually flags inside
   `vault.js`, and baseline only those specific exports (reason `dormant-feature`, note
   citing the gating issue) — not the module as a whole, since baselining the whole file
   would mask a genuinely dead export added to it later.

## 4. `source-invariants.test.js` tie-in

**The detection logic does not belong there.** That file's idiom is cheap, stable,
point-in-time regex assertions guarding a specific bug-shaped omission (a missing `type=`
attribute, a bailed-early condition) — each test is small enough to read and know it's
right. Whole-program reachability analysis (what a dead-code tool does) is exactly the kind
of thing that idiom exists to avoid hand-rolling; reimplementing it as regex over source
would produce a worse, unmaintained copy of the tool and rot faster than the tool itself.
The gate belongs in its own script (`npm run deadcode` or similar) invoked from the pre-push
hook and CI, same tier as `npm test` / `npm run test:ui`, not folded into the existing
structural-test file.

**One thing does belong in that idiom**: a schema guard on the baseline file itself —
`test/source-invariants.test.js` (or a new sibling, e.g. `deadcode-baseline.test.js`,
per the "check `test/` before adding a new file" rule in this repo's CLAUDE.md) asserting
every entry in `deadcode-baseline.json` has a non-empty `file`, `identifier`, `note`, and a
`reason` drawn from the closed enum. This is a structural assertion in the same spirit as
"package-lock tracks package.json version" — cheap, stable, and it's the thing that
actually prevents the baseline from becoming an unreviewable dumping ground, which is more
load-bearing than it looks.

**BUG-LOG tie-in**: if a real bug is ever traced to dead-code-adjacent causes — e.g. a
stale export that looked unused but was actually reached via a dynamic string reference the
tool couldn't see, and someone deleted it — that gets a normal BUG-LOG entry, and per this
repo's own convention the regression test for it is a targeted `source-invariants.test.js`
assertion for that specific pattern (mirroring BUG-026's "assert the bail condition doesn't
include X"), separate from the general dead-code gate. The gate's own false-positive list
(worker entry point, dynamic toast classes) is effectively pre-empting exactly this failure
mode before it happens.

## 5. Open risks / unverified

- **Nothing in §3 has actually been run.** No dead-code tool exists in this repo's
  `package.json` yet; every RED/GREEN step above is a procedure to execute once a tool is
  chosen, not a result this lane observed. Treat §3 as the acceptance test plan, not as
  evidence.
- **CSS dead-code and JS/export dead-code are typically different tool families** (e.g. a
  PurgeCSS-style scanner vs. an import-graph tool like knip/ts-prune/depcheck). This
  policy writes as if "the tool" is one thing with one baseline and one exit code; if the
  chosen solution is actually two tools, the baseline file and gate script need to either
  merge their outputs into one baseline schema or run as two independently-gated steps —
  worth resolving before implementation, not after.
- **Shrink-enforcement (failing on a stale baseline entry) is a real friction cost**: a
  contributor who fixes one piece of dead code but isn't the one asked to clean the
  baseline will now see their unrelated push fail until they also edit
  `deadcode-baseline.json`. This is a deliberate tradeoff recommended above to stop rot, but
  it's a team-workflow decision, not a purely technical one — flagging it explicitly so it's
  chosen consciously rather than discovered the first time it blocks someone.
- **Whether the eventual tool supports the two config hooks this plan depends on —
  extra entry points for `entryPoints`-only files, and dynamic/template-literal usage
  patterns for CSS classes — is unverified.** This lane did not evaluate specific tools
  (out of scope) and did not fetch any tool's documentation to confirm these capabilities;
  don't treat "the tool has an ignore/entry mechanism" as settled until whichever lane picks
  the tool cites its docs for it.
- **The vault.js gray-area findings in §3.4 are a guess about tool behavior**, not an
  observed result — this lane confirmed only that the *file* has live imports (via
  `grep`), not which individual exports a real dead-code tool would flag inside it.
- I did not search beyond the one named `toast-${type}` example for other
  template-literal-composed class names in the codebase; the acceptance procedure says to
  grep for more before signing off, but that grep hasn't been run by this lane.
