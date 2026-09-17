# Prefix access — QA test plan (pre-implementation)

**Date:** 2026-09-16 · **Author:** qa-verify lane · **Status:** test plan for a design not yet
built (nothing under `src/` has changed). Inputs: `docs/superpowers/specs/2026-09-16-prefix-access-design.md`
("the design"), `docs/review-prefix-access/00-facts.md` ("the facts brief"), `CLAUDE.md`,
`test/README.md`, `BUG-LOG.md`. Tree at `main` @ `0b24aea` (v1.62.3).

This plan follows the design's item table (B1, B2, B3, S1, A1, S2; B4 and A2 are out of scope —
B4 is an operator probe with no code, A2 is deferred). For every item: the observable restated
as an exact assertion, which file it lives in, the matched-pair procedure, mock changes,
harness-fidelity wording, sideways checks, and a BUG-LOG skeleton.

**Convention check performed first** (per `test/README.md`'s "the directory is the authoritative
file list" rule): `ls test/ test/components/ test/e2e/browser/` was run before naming any file
below (see the tool-call log this document's author produced). No file already exists for any
"new" case named here; every extension target below is a file that already exists and already
covers the same module.

---

## B3 reproduction (performed now, on today's code, before any fix)

**Method.** Built `perf/index.html` fresh from the current tree (`node build.mjs --mode=perf`,
so the harness is not serving the stale v1.62.2 bundle the facts brief flagged), then ran a
throwaway Playwright script,
`/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/qa/b3-repro.mjs`, against a
scoped mock (`scopePrefix: 'clients/acme/'`). Sequence: save a connection with an empty Base
folder → select it from the sidebar → Connect (expect fail) → set Base folder on the failed
screen → Connect again (expect success) → **Path A**: `page.reload()` in the same tab/session →
**Path B**: click the header's quick-switch `.connection-tab` for the same connection.

**Observed output** (full run, chromium, one pass):

```
Saved connection record (basePrefix should be empty at this point).

── after selecting the saved row (pre-connect) ──
  error-block visible: false
  #cred-baseprefix value: ""
  file-row:report.pdf visible: false
  root ListObjectsV2 (prefix="") since last log reset: 0

── STEP 4: first connect attempt, no Base folder (expect FAIL) ──
  error-block visible: true ("Connection failedAccess DeniedNote: This can mean the credentials are simply wro...")
  #cred-baseprefix value: ""
  file-row:report.pdf visible: false
  root ListObjectsV2 (prefix="") since last log reset: 1

── STEP 5: recovery connect with Base folder set (expect SUCCESS) ──
  error-block visible: false
  #cred-baseprefix value: "clients/acme/"
  file-row:report.pdf visible: true
  root ListObjectsV2 (prefix="") since last log reset: 0

── PATH A: plain reload (same tab) — does auto-connect still work? ──
  error-block visible: false
  #cred-baseprefix value: "clients/acme/"
  file-row:report.pdf visible: true
  root ListObjectsV2 (prefix="") since last log reset: 0

.connection-tab present for quick-switch: true

── PATH B: quick-switch tab click (re-resolves saved record) — does it fail again? ──
  error-block visible: true ("Connection failedAccess DeniedNote: This can mean the credentials are simply wro...")
  #cred-baseprefix value: ""
  file-row:report.pdf visible: false
  root ListObjectsV2 (prefix="") since last log reset: 1
```

**Verdict: B3 reproduces, and the code explains exactly why.** `App.jsx`'s mount effect
(lines ~572-575) prefers `stored` (the flat sessionStorage mirror `saveCredentials` writes on
every `handleConnect`, success or failure) over the resolved connection record whenever
`stored.endpoint` is set — so **Path A (plain reload, same tab)** genuinely works today: the
flat mirror already carries the Base folder from the successful reconnect, no fix needed for
that path, confirming the design's own caution not to mistake it for evidence the bug is fixed.
**Path B (quick-switch)** calls `switchToConnection` → `resolveConnection(id)`, which reads the
**saved connection record** — never persisted, so `basePrefix` is still `''` — and reconnects
with it (using the in-memory cached secret), landing back on the denied screen with the
Base-folder field blanked again. This is the loop the design names ("Quick-switch and the
sidebar re-resolve the record, whose floor is still empty, and fail again").

One thing this run surfaces beyond the design's text: because `handleConnect` calls
`saveCredentials(fullCreds)` **unconditionally, before the try/catch**, the failed quick-switch
in Path B has now overwritten the flat mirror too — a *subsequent* plain reload would fail as
well, until the user recovers again. The design's D4(iv) fix (persist the discovered floor into
the saved record on first success) closes this for good; the flat-mirror path is not a
substitute fix and QA should not accept "reload works" as evidence B3 is fixed — only "quick-switch
after recovery still lists inside the floor with the record itself carrying the Base folder"
counts.

**Script kept for reuse**: `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/qa/b3-repro.mjs`.
It becomes the skeleton for B3's matched-pair e2e spec (below) — same seed, same two paths,
turned into assertions instead of console logs.

---

## B1 — Failed connect: scroll-and-focus, hint block, quick-switch title

**Observable (design table).** After a scoped-mock denial with no Base folder: the error block
is inside the viewport and focused; clicking **Set base folder** makes `#cred-baseprefix` the
active element with its rect inside the viewport — desktop and Pixel 5.

**Assertions (not proxies — direct geometry/focus reads, the pattern already proven in
`.claude-scratch/prefix-access/verify-offscreen.mjs`):**
- `document.querySelector('.error-block').getBoundingClientRect()`: `top < innerHeight && bottom > 0`.
- `document.activeElement === document.querySelector('.error-block')` (the `role="alert"`
  container itself, `tabIndex={-1}`) immediately after the transition to `session='failed'`.
- After clicking **Set base folder**: `document.activeElement === document.querySelector('#cred-baseprefix')`
  and that element's `getBoundingClientRect()` is inside the viewport.
- Quick-switch title: on a failed *switch* (not a failed first connect), the error block's title
  text equals `` `Couldn't open ${bucket} — Access Denied` `` — read via `.error-title textContent`,
  not a substring-only check, since the whole point is it must NOT read like a sign-out.

None of these are proxies (`textContent.includes(...)` alone would be — a proxy check is only
acceptable for the message body text, not for "was it seen").

**Files:**
- **Component** (`test:ui`): extend `test/components/error-block.test.jsx` — a new describe
  block asserting the *scroll-and-focus effect* cannot be tested here (jsdom has no real
  layout/`scrollIntoView` semantics worth asserting geometry against) — component coverage is
  for the **gating change** only: add cases that `showScopeHint` (and the CORS-tail sentence)
  are **suppressed** for `SignatureDoesNotMatch` and `InvalidAccessKeyId` even when
  `basePrefixUnset` is true (today's code gates only on `AccessDenied`/403/401 with no code
  exclusion — this is new negative-space the design adds). Also assert the CORS-masked variant
  drops the generic "if this looks like a CORS error…" tail on the readable-403 shape (UX F7)
  and that the appended prefix sentence is removed from the CORS note now that it has its own
  block (dedupe, D4(ii)).
- **E2E** (browser, real geometry/focus): extend
  `/home/basilgohar/dev/bucketer/test/e2e/browser/prefix-scope.test.mjs` — its existing
  `'connecting WITHOUT a Base folder hits the denial and shows the recovery hint'` case already
  sets up exactly this scenario; add the scroll/focus assertions to it (or a sibling case) rather
  than duplicating the connect flow, and add a Pixel-5 device-profile run alongside desktop
  (`newE2EContext(browser, devices['Pixel 5'])`, following `verify-offscreen.mjs`'s pattern).
  Add a **new** describe block in the same file for the quick-switch title case: two saved
  scoped connections, switch from a connected session to the second one's tab where its key
  is denied, assert the title.
- **Negative case (B1's "no hint on bad credentials")**: needs the mock's new
  `SignatureDoesNotMatch`/`InvalidAccessKeyId` fault codes (see Mock changes) — add as a case in
  `prefix-scope.test.mjs`: connect with a bad secret against the (unscoped or scoped) mock,
  assert the error block does **not** contain "Base folder".

**Matched pair (all three engines, operator policy 2026-09-05):**
1. Build `perf/index.html` from `main` @ `0b24aea` (today's tree — this **is** pre-fix; no
   stash/checkout needed since nothing has been implemented yet). Run the new geometry/focus
   assertions → **expect FAIL** (the facts brief already measured `top ≈ 914px` desktop /
   `≈ 931px` mobile, `activeElement === <body>` — record that exact output as the "before" row,
   reusing `.claude-scratch/prefix-access/verify-offscreen.mjs`'s numbers rather than
   re-deriving them, since it was captured on this exact commit).
2. After the fix lands, rebuild to `perf/` and re-run the same specs on chromium, firefox,
   webkit (`npm run test:e2e:container`) → expect PASS on all three.
3. Record both runs (image tag + browser versions per the container-matrix rule) in the BUG-LOG
   entry.

**Harness-fidelity statement (mandatory, design's exact wording):** "readable-403 shape only."

**Mock changes:** none beyond what B2 adds (B1's negative case reuses B2's new fault codes).

**Sideways checks that must stay green:**
- `prefix-scope.test.mjs` — `'connect with a Base folder lists inside the scope...'` and the two
  shared-link specs (basePrefix pre-fill, in-floor deep link, out-of-floor clamp).
- `error-block.test.jsx` — every existing case (CORS note presence for plain fetch errors,
  "no Base folder hint when already set", "no hint on a non-permission error", diagnostics
  button gating, #51 reset-on-error-change).
- `profiles.test.mjs` — BUG-047 disconnect-survival, BUG-018/020/026/027 — untouched surfaces.

---

## B2 — Honest diagnostics verdict; mock gains `corsOnErrors:false`

**Observable.** With `scopePrefix` + `corsOnErrors:false`, no Base folder: error is CORS-like,
**Set base folder** present, Run diagnostics → verdict names both causes; `mock.requestLog`
shows the root list reached the mock.

**Assertions:**
- The rendered error text matches the CORS-masked variant (design D4(ii)): contains the
  "browser blocked the response" framing, not the readable-403 framing — a **presence** check
  on specific phrasing, not just "CORS" appearing anywhere (the existing generic CORS-note test
  already covers that weaker property; this is additive, not a replacement).
- `document.querySelector('.error-block')` contains a **Set base folder** button (`button`
  element, not just text — click it and assert the same focus/geometry outcome as B1).
- After clicking Run diagnostics: `VERDICT_MESSAGES['cors-blocked-or-scoped']` text is shown —
  assert the **new** verdict key's exact string (unit level) and, at component level, that the
  rendered text names *both* causes (the design's two-cause paragraph) — a substring check for
  "can't tell a CORS block apart from" is acceptable here since the full paragraph is long
  prose; do not accept a bare `text().includes('cors-blocked-or-scoped')` (the code, not the
  user-facing text) as the assertion.
- **Presence, next to the CORS "absence"**: `ctx.mock.requestLog.list()` contains one `isList`
  entry with `listPrefix === ''` — this is the harness's presence pairing for what the earlier
  `error-block` unit tests can't see (CORS-masked failures are, by definition, invisible to the
  page — the request log is the only place the "it really was attempted" proof can come from).

**Files:**
- **Unit**: extend `test/connection-diagnostics.test.js` — new describe block for the
  `cors-blocked-or-scoped` verdict: `runDiagnostics({ ...BASE, basePrefixUnset: true,
  fetchFn: fetchOk })` (all probes pass, `basePrefixUnset: true`, `connected: false`) →
  `verdict === 'cors-blocked-or-scoped'`; a same-shape call with `connected: true` must NOT
  produce it (in-session CORS-like errors keep `cors-blocked-transient` per the design's
  "every other context keeps today's verdicts"); and `VERDICT_MESSAGES['cors-blocked-or-scoped']`
  must never contain "almost certainly" (the design's explicit "must never read... while a free
  untested hypothesis is on screen"). Also extend the `diagnosticsProps` describe block: it must
  now thread `basePrefixUnset` through from its caller.
- **Component**: extend `test/components/error-block.test.jsx` — mount with
  `diagnostics: { ..., basePrefixUnset: true }`, click Run diagnostics, assert the two-cause
  text (mirrors the existing "clicking the button runs diagnostics and shows the verdict" case,
  which currently only exercises the old `cors-blocked` path).
- **E2E** (mock's CORS-omission behaviour is real environment-dependent behaviour, not just a
  unit concern — the observable explicitly requires screen truth + a request-log presence):
  extend `test/e2e/browser/prefix-scope.test.mjs` with a new case in the "normal connect screen"
  describe block: `ctx.mock.configure({ scopePrefix: SCOPE, corsOnErrors: false })`, connect
  without a Base folder, assert the CORS-masked error text, the **Set base folder** button, the
  diagnostics verdict, and `rootLists().length >= 1`.

**Matched pair:** same three-engine procedure as B1. Pre-fix run of the new mock-driven case is
expected to fail two ways worth distinguishing in the BUG-LOG entry: (a) the mock has no
`corsOnErrors` knob yet, so the spec cannot even be written against current code without the
mock change landing first (mock change is infrastructure, not the fix under test — land it in
the same commit as B2 per the design's "one item, one commit" rule, then the "before" run is
against the mock+old ErrorBlock/diagnostics code, and the "after" run is against the mock+fixed
code); (b) once the mock change exists, pre-fix `ErrorBlock`/diagnostics genuinely produce the
*old* `cors-blocked` verdict with "almost certainly" — assert that string is what pre-fix
produces (a real fails-before, not a hypothetical).

**Harness-fidelity statement (mandatory, design's exact wording — reproduce verbatim in the
commit message and the BUG-LOG entry):**

> The mock's `corsOnErrors:false` models the hypothesis that a provider omits CORS headers on
> error responses; it does not establish that Backblaze B2 does. No e2e coverage: harness cannot
> represent B2's real denial/CORS behaviour.

**Mock changes:** `test/e2e/mock-s3/server.mjs` — `configure({ corsOnErrors })`: when `false`,
`sendError` (and the scope-deny path specifically, since that's the only caller this feature
exists for) must omit `Access-Control-Allow-Origin`/`Access-Control-Expose-Headers` from
`corsHeaders(req)`'s output for **error responses only** — success responses keep CORS headers
unconditionally (a totally CORS-blocked mock would make the app unable to connect at all, which
is not the shape being modelled). Also add the mock's `SignatureDoesNotMatch` /
`InvalidAccessKeyId` fault codes (B1's negative case needs them too) — likely as a `faults`
entry or a dedicated `configure({ badCredentials: 'SignatureDoesNotMatch' })` knob on the object
op that fails.

**Self-tests for the mock changes** (new cases in `test/e2e/mock-s3/server.test.mjs` — check
this file's existing structure before adding, since it already self-tests `scopePrefix` and
CORS header emission):
- `corsOnErrors:false` + a scoped denial: response has no `Access-Control-Allow-Origin`.
- `corsOnErrors:false` does not affect a successful (in-scope) request's CORS headers.
- Default (`corsOnErrors` unset/true): unchanged from today — a regression guard, since this is
  the existing behaviour every other e2e spec relies on.
- The new bad-credentials fault codes: connecting with the configured "bad" identity returns the
  configured `<Code>` in the XML body.

**Sideways checks:** every existing `server.test.mjs` CORS case (BUG-028's exposeHeaders
regression, wildcard matching); `prefix-scope.test.mjs`'s existing scoped-connect cases (must
still pass with `corsOnErrors` left at its default).

---

## B3 — Persist a discovered floor into the selected saved connection; toast

**Observable.** After recovery, reload → auto-connect renders a row from inside the floor
(presence) and no root list in `mock.requestLog` (absence) — **QA reproduces the loop on
pre-fix code first** (done above).

**Correction to the observable's literal wording, based on the reproduction above:** a "plain
reload" already renders a row from inside the floor on **pre-fix** code too (via the flat
mirror) — so a spec that reloads in the *same tab* and checks for a row is not a fails-before
test; it would pass even before the fix, which is exactly the kind of proxy this role exists to
catch. The spec must exercise a path that **re-resolves the saved connection record**, not the
flat mirror. Confirmed live in this session: the header quick-switch `.connection-tab` click
(`switchToConnection`) reproduces the loop cleanly and needs no reload at all.

**Assertions:**
- Presence: after quick-switching to the recovered connection (or reload **in a fresh
  browser context that shares localStorage but not sessionStorage** — a new `context.newPage()`
  is same-origin-storage-shared in Playwright only within the same context; a genuinely fresh
  tab needs a new page in the *same* context, not a new context, to share localStorage while
  starting with empty sessionStorage — verified in the repro script's Path B using the
  same-context quick-switch rather than a new page, which is the simpler and equally valid
  re-resolution path), `[data-testid="file-row:report.pdf"]` (or whatever seeded file) is
  visible.
- Absence, paired: `ctx.mock.requestLog.list().filter(r => r.isList && r.listPrefix === '')`
  has length 0 for that quick-switch's request window (reset the log immediately before the
  quick-switch click, exactly as the repro script does).
- The toast: `toastStore.get().at(-1).message === 'Base folder saved to <connection name>'`
  (component-level, since the toast store is plain JS — no browser needed) fires exactly once,
  on the first successful listing after a partial-update `saveConnectionRecord` call, and never
  fires again on a normal already-scoped connect (guard against a toast-every-time regression).
- Never-before-success / never-over-non-empty-floor guards (component/unit level): a listing
  that fails must not call `saveConnectionRecord`; a connection whose record already has a
  non-empty `basePrefix` must not have it overwritten even if the live floor differs (this
  models "editing an existing floor stays with the explicit Save flow" — construct a case where
  `credentials.basePrefix !== conn.basePrefix` and assert `saveConnectionRecord` is not called,
  or is called without a `basePrefix` key).

**Files:**
- **Unit/component**: this is App-level orchestration (a `saveConnectionRecord` call gated on
  "first successful listing + selected connection + record's basePrefix is `''` + live floor is
  set"), so the natural home is `test/components/app.test.jsx`. Look at the existing describe
  block `'App — a freshly saved connection survives the very next reload (Finding A, case 5)'`
  (~line 570) for the pattern of driving a full connect-with-a-stubbed-client cycle in this
  file; add a new describe block, e.g. `'App — a discovered Base folder is persisted to the
  saved connection (B3)'`, that stubs a listing success at a non-root floor, asserts
  `saveConnectionRecord` was called with `{ id, basePrefix }` only (partial update, not the
  connection's other fields — the design's note that partial updates are load-bearing), and the
  never-before-success / never-over-non-empty-floor guard cases above.
- **E2E** (the observable is explicitly cross-request, cross-navigation — this needs the real
  storage/reconnect machinery a component test stubs away): extend
  `test/e2e/browser/prefix-scope.test.mjs` — new describe block `'prefix-scoped keys —
  discovered floor persists across quick-switch (B3)'`, built directly from
  `.claude-scratch/prefix-access/qa/b3-repro.mjs`'s sequence (save with empty floor → select →
  fail → set Base folder → succeed → quick-switch → assert success + absence, per the corrected
  observable above). Keep the toast assertion in this spec too (`.toast` element text, or
  whatever selector the existing toast e2e coverage uses — check `toast-host.test.jsx` /
  any e2e toast assertions before inventing a selector).

**Matched pair (three engines):** pre-fix run of the new e2e case against `main` @ `0b24aea`
(today's tree — already effectively run above via the throwaway script; the real spec must
reproduce the same FAIL) → expect the quick-switch step to land back on `.error-block`. Post-fix:
same spec, same lanes → expect success + absence + toast.

**Harness-fidelity statement:** none required — this item's mechanism (localStorage record
update, in-memory quick-switch) has no environment-dependent piece the mock or browser
misrepresents.

**Mock changes:** none.

**Sideways checks:** `handleSaveProfile`'s same-bucket-different-floor distinctness (explicitly
named in the design's sideways list) — extend/verify existing `app.test.jsx` coverage for that
behaviour is untouched by B3's new partial-update call; the existing quick-switch describe
block `'App — connected sidebar switcher (quick-switch)'` and `'App — header quick-switch
tab-strip'` must keep passing unmodified.

---

## S1 — Validated `prefix` intake at one read site; `region` guard

**Observable.** A link with `#prefix=clients/acme` lands in `clients/acme/` (normalized) and
New folder → `Reports` PUTs `clients/acme/Reports/`; unit table for `\`, `..`, >1024.

**Assertions:**
- Unit table (mirrors `base-prefix.test.js`'s and `url-params.test.js`'s existing tables
  exactly, so reviewers can diff against a known-good shape): for the new one-function reader
  (design calls it "one read function for the navigation `prefix`"), a slash-less value
  normalizes to a folder (`clients/acme` → `clients/acme/`); a value containing `..` segments is
  rejected (falls back to `''` or is dropped, matching `readUrlParams`'s existing `basePrefix`
  rejection pattern — assert the *effective* result, i.e. what Browser actually navigates to,
  not just that the raw string was rejected in isolation); a value containing `\` is rejected;
  a value >1024 chars is rejected; a value that survives is then run through `clampToFloor`
  against the connection's `basePrefix`.
- `region` guard: same whitespace/length shape as the existing `keyId` guard in
  `url-params.test.js` (`readUrlParams` ignores a `region` with whitespace; ignores one beyond
  whatever length cap the design sets — the design says "same guard as keyId", so mirror
  `keyId`'s exact two existing test cases — `128` chars — unless implementation picks a
  different cap, in which case the cap itself needs a cited reason).
- E2E presence: a fresh page opened with `#prefix=clients%2Facme` (no trailing slash, exercising
  the normalize step) lands showing rows from `clients/acme/` — `[data-testid="file-row:...")]`
  — and New Folder named `Reports` results in a `PutObjectCommand`/`isList` or object-PUT log
  entry whose key is exactly `clients/acme/Reports/` (via `ctx.mock.requestLog`, filtering for
  the PUT, or by asserting the object actually exists afterward via `ctx.client`'s own
  `ListObjectsV2` against the mock — prefer the request-log key since that is the literal
  "crafted link" defect path the design names).
- The crafted-link defense specifically: a link with `#prefix=../` or `#prefix=a%5Cb/` must
  **not** reach `clampToFloor`/New-folder composition at all — assert the app lands at root (or
  the floor) rather than composing a malformed key. This is the actual security regression test
  (today: `clampToFloor('clients/acme', '')` passes a slash-less value through, and `../`, `a\b/`
  are undemonstrated-but-plausible per the facts brief's "Uploads are safe" caveat — this closes
  the New-folder composition path specifically).

**Files:**
- **Unit**: extend `test/url-params.test.js` (the new read function likely lives in
  `url-params.js` beside `readUrlParams`/`pushPrefixHistory`, or in a small new function within
  the same module — check the implementation's actual module before assuming a new file is
  warranted; per `test/README.md`'s rule, a new *file* is not justified unless the function
  lives in a genuinely new module). If the validated reader is extracted into `base-prefix.js`
  instead (since it reuses `normalizeBasePrefix`/`clampToFloor` from there), extend
  `test/base-prefix.test.js` instead — whichever module the function is actually defined in.
- **Component**: extend `test/components/browser-base-prefix.test.jsx` (already the home for
  "an initial hash prefix inside the floor is honored," per BUG-058's test-case citation) with
  the malicious-input table at the Browser-mount level, mirroring BUG-058's
  `isFirstMount: true` direct-drive pattern.
- **E2E**: extend `test/e2e/browser/prefix-scope.test.mjs` — the existing "an in-floor deep-link
  prefix lands in that subfolder" and "clamped to the floor" cases are the direct siblings; add
  the normalize case (`#prefix=clients%2Facme` without trailing slash) and the New-folder
  composition case as new cases in the "shared link screen" describe block.

**Matched pair:** three engines. Pre-fix: the crafted-link New-folder composition case is
expected to actually create `clients/acmeReports/` (the facts brief's own worked example) —
this is a genuine, currently-live security defect, so the "before" run should show the bad key
actually landing in the mock's object store, not just an assertion failure — capture that as
the BUG-LOG evidence.

**Harness-fidelity statement:** none required (pure string validation + a real request to the
real mock).

**Mock changes:** none.

**Sideways checks:** `url-params.test.js`'s existing `#prefix=`/`#basePrefix=` coexistence test
("basePrefix and prefix params coexist without clobbering each other") must stay green — S1
must not make `readUrlParams` start consuming `prefix` (the design is explicit: "not consumed
by `readUrlParams`"). All of `prefix-scope.test.mjs`'s existing deep-link/clamp cases.

---

## A1 — Header menu carries the folder; key-ID modifier; breadcrumb 🔗; file-popover separation

**Observable.** Copy the folder item from `clients/acme/sub/`, open the URL in a fresh context,
enter key ID + secret → a `file-row` from inside `sub/` renders and `mock.requestLog` has no
empty-prefix list.

**This is a feature, not a bugfix — "not-inert" evidence per the design's closing paragraph: a
new e2e case must FAIL on pre-feature `main` (today's tree has no folder-link menu item and no
breadcrumb button at all — the case cannot even locate the elements, which is itself the correct
"fails" shape, distinct from a bug's fails-before/passes-after).**

**Assertions (each is a real observable, not a rendered-node proxy):**
- Clicking the header's **Copy link** trigger while `currentPrefix` is `'clients/acme/sub/'` and
  the floor differs shows a first item labelled to include the current folder (design's exact
  wording: `Open in Bucketer — this folder (…/acme/sub/)`) — assert via `findButton`-style
  lookup on the **label text**, following `share-link-menu.test.jsx`'s existing pattern, not on
  a CSS class.
- Clicking it copies a link whose `prefix` param, once parsed with `URLSearchParams`, equals the
  connection's current prefix — assert via the same `navigator.clipboard.writeText` stub pattern
  already installed in `share-link-menu.test.jsx` (module-level `Object.defineProperty`), then
  parse the captured string with `URLSearchParams`, not a substring `includes` check (a
  substring check can't tell `prefix=clients/acme/sub/` from `prefix=clients/acme/subfolder/`
  colliding on a shared prefix).
- At the floor (`currentPrefix === floor` or unscoped root), the folder item is **absent**
  entirely (not disabled) — `findButton(queryAll, 'this folder')` returns `undefined`.
- The key-ID modifier is a checkbox that persists its checked state across the menu closing and
  reopening within the same session (component-level: toggle, close, reopen, assert still
  checked) — and remains disabled with its existing title when `keyId` is empty, exactly as
  today's "Include access key ID" item.
- Toast wording matches the design's two toasts exactly (`'Link copied — opens at clients/acme/sub/'`
  / `'Link copied — opens at the top of test-bucket'`), read from `toastStore.get().at(-1).message`
  — an exact-string assertion, per BUG-057's lesson that loose substring checks hide transposed
  or wrong values.
- Breadcrumb button (D3): `test/components/browser-internals.test.jsx`'s `Breadcrumb` describe
  blocks gain a case that at a non-floor prefix, a `<button type="button" aria-label="Copy a
  link to this folder">` (real button, not the crumbs' own `<span onClick>`) renders, is
  ≥32×32px (`getBoundingClientRect` — jsdom returns 0×0 for unstyled elements, so this
  specific check is a **proxy at the component layer** and must be replaced by a real
  `getBoundingClientRect` check in the e2e layer, not asserted as pixel-accurate in jsdom); at
  the floor, the button is absent.
- File-popover "separating the families" (D1's back-compat/family-separation requirement):
  `test/components/browser-internals.test.jsx`'s `CopyLinkPopover` tests gain a case asserting
  the popover's copy never mentions "folder" and the header menu's copy never offers a
  presigned/no-credentials-needed link — a textual non-overlap check between the two
  components' rendered button/label sets.
- E2E not-inert case: `test/e2e/browser/prefix-scope.test.mjs`, new describe block — from inside
  `clients/acme/sub/`, open the header menu, click the folder item, read the clipboard (Playwright
  clipboard permission grant needed — check how, if anywhere, existing e2e specs read
  `navigator.clipboard` in a real browser context; if none do, this may need
  `context.grantPermissions(['clipboard-read'])` and is worth flagging to the engineer before
  implementation, not discovered mid-review), open that URL in a **fresh context** (new
  `newE2EContext`, empty storage), fill in the secret, connect, assert
  `[data-testid="file-row:...")]` renders from inside `sub/` and `rootLists().length === 0`.

**Files:**
- **Component**: extend `test/components/share-link-menu.test.jsx` (folder item, modifier
  persistence, toast wording, back-compat root/floor case) and
  `test/components/browser-internals.test.jsx` (breadcrumb button, CopyLinkPopover
  family-separation).
- **Unit**: extend `test/url-params.test.js`'s `buildShareUrl` describe block — the design's
  back-compat anchor ("byte-identical to v1.62.3 output" at root/floor) is exactly the kind of
  invariant that belongs as a direct unit assertion: `buildShareUrl(creds, { prefix: '' })` and
  `buildShareUrl(creds, { prefix: floor })` must produce a string with no `prefix` param at all,
  and must equal today's `buildShareUrl(creds)` output byte-for-byte for the same `creds`.
- **E2E**: extend `test/e2e/browser/prefix-scope.test.mjs`.

**Matched pair equivalent (not-inert):** run the new e2e case against `main` @ `0b24aea` →
expect it to fail at the "open the header menu" step (no folder item exists) or the "find the
breadcrumb button" step — record which, since a not-inert claim needs to name where it broke,
not just that it broke. Post-feature: same case, same lanes, on all three engines.

**Harness-fidelity statement:** none required for the core flow (real clipboard, real hash,
real mock). If clipboard-read permission cannot be granted in one of the three engines
(WebKit's clipboard permissions model is more restrictive than Chromium's — verify before
committing to "all three engines" for this specific case; if WebKit cannot grant
`clipboard-read`, fall back to reading the clipboard via the same in-page stub pattern
`share-link-menu.test.jsx` uses, applied through `page.addInitScript`, and say so explicitly in
the commit message rather than silently skipping WebKit).

**Mock changes:** none.

**README privacy note:** `README.md` currently has no "Copy link" / share-link privacy section
to extend in place (searched; the only "privacy" hit is the project's mission statement, not a
feature doc) — this is a **new** subsection, not an edit to an existing one QA can point at by
line number. Verification for this piece is a manual read-through: the note must state that a
folder link honours the credential's floor server-side (never trust the client not to have
tampered with it) and that only the connection-link family carries `prefix`. No automated test
applies to README prose; flag it in the PR description instead (per this repo's
`docs/` conventions — QA cannot assert prose content automatically, and should say so plainly
rather than inventing a check).

**Sideways checks:** every existing `share-link-menu.test.jsx` case (trigger/menu-open, disabled
without keyId, both existing toasts); `url-params.test.js`'s full `buildShareUrl` describe block;
`prefix-scope.test.mjs`'s full existing suite; per-file presigned links (`CopyLinkPopover`)
untouched in behaviour — the design's own sideways list names this explicitly, so a case
asserting the popover's presigned-URL flow is byte-identical (still no `prefix`, still per-file)
belongs here too, not just "we didn't touch that file."

---

## S2 — No auto-connect on differing URL values; banner enumerates link-set fields

**Observable.** A secret-holding tab loaded with a hash naming a different endpoint shows the
pre-filled form and issues **no** request to that endpoint (mock log absence beside the form's
presence).

**Assertions:**
- Presence: the pre-filled form shows the URL-supplied values (endpoint/bucket/keyId/basePrefix)
  — `input[type="url"]`, `input[placeholder="my-bucket"]`, etc. — following the existing
  `app.test.jsx` "App — connection share links" pattern.
- Absence, paired: no request of any kind reaches the mock's endpoint for that tab before the
  user explicitly clicks Connect — `ctx.mock.requestLog.list()` is empty (or contains only
  requests from a *different*, prior connection in the same test, filtered out) at the checkpoint
  right after the hash loads / hashchange fires, before any click.
- The banner enumerates what the link set, including `Base folder: team/` when present — a
  presence/exact-text check on the banner's rendered content when `basePrefix` is part of the
  differing URL, not just "a banner exists."
- The untouched case: "reload my share-link tab" (URL-supplied values equal the stored
  connection's) still auto-connects — this is the sideways guard, and it is the exact inverse of
  the new gate, so it belongs in the same describe block as a contrasting pair, not a separate
  file.

**Files:**
- **Unit/component**: extend `test/components/app.test.jsx`'s `'App — connection share links'`
  describe block (~line 866) — this already drives the mount-time hash/credentials interplay;
  add the new comparison-gate cases directly beside the existing BUG-047 hashchange cases (they
  share the exact same effect). A stubbed S3 client that would reveal whether `handleConnect`
  fired is needed — check how the existing describe block at line 570 ("survives the very next
  reload") stubs connect-success, and reuse that stub rather than inventing a new one.
- **E2E**: extend `test/e2e/browser/profiles.test.mjs` (its whole file is "credential/profile
  screen regressions," and this is exactly that shape) — new describe block: connect to
  connection A in a real tab (so a secret is cached/held), then navigate the same tab's hash to
  a link naming connection B's endpoint (differing value), assert the pre-filled form for B and
  `ctx.mock.requestLog` shows no request to B's mock before an explicit click. This needs a
  **second** mock instance or a second scoped endpoint on the same mock to have something
  concrete to assert "no request reached" against — reuse the pattern
  `prefix-scope.test.mjs` already uses for two distinct scopes (`clients/acme/` vs
  `clients/other/`) rather than standing up a second `startMock()`.

**Matched pair (three engines):** pre-fix run of the new e2e case against today's tree is
expected to show the auto-connect actually firing against the *second* connection's endpoint —
i.e., a request DOES appear in that endpoint's log pre-fix (this is the literal defect: "auto-
connect only when the URL-supplied values… equal the stored connection's; otherwise fall through"
is not what today's code does per security finding F1/F3). Capture that request as the "before"
evidence, then confirm its absence post-fix.

**Harness-fidelity statement:** none required.

**Mock changes:** none (reuse the existing two-scope pattern; no new mock feature needed).

**Sideways checks:** `profiles.test.mjs`'s existing BUG-047 case ("a share link survives
disconnect") must stay green — S2 must not break the disconnect-restore path, only the
mount-time same-tab-differing-hash path. `app.test.jsx`'s existing "shared-link pre-fill
banner" describe block. The design's own "Reload-auto-reconnect of a share-link tab with
matching values still works (S2)" sideways bullet — write it as a same-file contrasting case,
not a separate assumption.

---

## BUG-LOG entry skeletons

Each is filled from this plan's test-case field; the actual root cause and fix description are
the implementer's to complete (PRFT is written at fix time), but the **test case** — the part
this role owns — is fixed now so the fix cannot quietly satisfy a weaker one.

### BUG-0XX (B1) — Failed-connect explanation exists but is never seen

**Symptom.** (from the facts brief) After a denied first listing, the error block renders
below the fold with no scroll/focus change; the operator's "no explanation" report traces to
this on the readable-403 shape.
**Root cause.** No scroll-into-view/focus effect on the `session='failed'` transition;
`role="alert"` alone does not move focus.
**Fix.** (implementer's to state) — scroll+focus effect, ranked hint block, CORS-tail dedupe.
**Why it wasn't caught earlier.** The 2026-08-13 design declined a focus-jump ("reconsider if
users miss it") and no e2e ever asserted geometry/focus — only text presence
(`error-block`'s existing tests are all `textContent.includes`).
**Test case.** `test/e2e/browser/prefix-scope.test.mjs` — geometry/focus assertions on the
existing "no Base folder" case, desktop + Pixel 5, plus the quick-switch title case; matched
pair on all three engines (before: `top ≈ 914px`/`931px`, `activeElement === body`; after:
element in-viewport and focused). Harness-fidelity: readable-403 shape only.

### BUG-0XX (B2) — Diagnostics gives a confidently wrong verdict on a CORS-masked denial

**Symptom.** On a CORS-masked shape, "Run diagnostics" returns all-green and blames CORS in
bold, while a prefix-restriction is equally live and untested.
**Root cause.** `runDiagnostics`'s all-pass branch had only one verdict (`cors-blocked`) for
the no-floor connect screen; it did not know a Base folder was unset.
**Fix.** New `cors-blocked-or-scoped` verdict, gated on `basePrefixUnset && !connected`; mock
gains `corsOnErrors:false` to make the shape testable at all.
**Why it wasn't caught earlier.** The mock always attached CORS headers to every response,
including errors — the one shape that hides the real cause could never be constructed in the
harness before this change.
**Test case.** `test/connection-diagnostics.test.js` new verdict case;
`test/components/error-block.test.jsx` two-cause rendering;
`test/e2e/browser/prefix-scope.test.mjs` CORS-masked connect + diagnostics case backed by the
new mock knob; `test/e2e/mock-s3/server.test.mjs` self-tests for `corsOnErrors`. Harness-fidelity
statement mandatory (quoted above verbatim).

### BUG-0XX (B3) — A recovered Base folder never reaches the saved connection

**Symptom.** Reproduced live in this session (see the reproduction section above): after typing
the Base folder on the failed screen and connecting successfully, clicking the same connection's
quick-switch tab reconnects with the saved record's still-empty floor and fails again, with the
Base-folder field visibly reverting to blank.
**Root cause.** `saveConnectionRecord` is called only from the explicit Save action (and the
gated-off vault-offer path) — never from a successful listing — so the record's `basePrefix`
stays `''` forever unless the user re-saves manually.
**Fix.** After the first successful listing at the floor, if the selected connection's record
has `basePrefix === ''` and the live floor is non-empty, write that one field
(`saveConnectionRecord({ id, basePrefix })`, a partial update) and toast.
**Why it wasn't caught earlier.** Every existing prefix-scoped-key e2e spec either connects
successfully from the start (Base folder already typed) or reconnects in the same tab
immediately (which the flat sessionStorage mirror papers over) — nothing exercised the
sidebar/quick-switch re-resolution path after a recovery.
**Test case.** `test/components/app.test.jsx` new describe block for the partial-update gating
(never-before-success, never-over-non-empty-floor); `test/e2e/browser/prefix-scope.test.mjs`
new describe block reproducing the exact save→select→fail→recover→quick-switch sequence,
matched pair on all three engines (before: quick-switch fails, root list denied, field blanks;
after: quick-switch succeeds, no root list, toast fires once).

### BUG-0XX (S1) — Unvalidated navigation `prefix` reaches New-folder key composition

**Symptom.** A crafted `#prefix=clients/acme` (no trailing slash) link makes a subsequent "New
folder → Reports" compose `clients/acmeReports/` instead of `clients/acme/Reports/` — demonstrated
at unit level by the security lane; a `..`/`\`/oversized value is undemonstrated-but-plausible
through the same path.
**Root cause.** Three Browser read sites read the hash `prefix` raw via
`new URLSearchParams(...).get('prefix')`, clamped with `startsWith` only — no normalization, no
rejection of `..`/`\`/length.
**Fix.** One validated read function (cap 1024, reject `\`/`..`, `normalizeBasePrefix`, then
`clampToFloor`) used at all three sites.
**Why it wasn't caught earlier.** Existing tests exercised well-formed `prefix` values only
(BUG-058's own regression test uses `photos/2024/`, already trailing-slashed and clean); nothing
fed the same hash param a hostile or malformed string, unlike `basePrefix`/`bucket`/`endpoint`,
which already had T2-4-style rejection tables.
**Test case.** Unit table (module TBD by implementation — `url-params.test.js` or
`base-prefix.test.js`) for `\`, `..`, >1024, and the no-trailing-slash normalize case;
`test/components/browser-base-prefix.test.jsx` Browser-mount-level malicious-input table;
`test/e2e/browser/prefix-scope.test.mjs` New-folder composition case showing the bad key
actually lands in the mock pre-fix and does not post-fix.

### BUG-0XX (S2) — A share link that changes the connection auto-connects with the held secret

**Symptom.** A tab already holding a live secret, when navigated to a hash naming a different
endpoint/bucket/keyId/basePrefix, silently auto-connects to that new target using the held
secret, rather than asking for confirmation.
**Root cause.** The mount effect's auto-connect check does not compare URL-supplied connection
values against the currently stored/selected connection's values before calling `handleConnect`.
**Fix.** Auto-connect only when URL-supplied endpoint/bucket/keyId/basePrefix/region equal the
stored connection's; otherwise fall through to the pre-filled form, banner enumerating what the
link set.
**Why it wasn't caught earlier.** Pre-existing and adjacent to the original share-link feature;
flagged by the security lane as Medium/plausible-unverified — no test had ever tried "a live tab,
then a hash naming different connection values."
**Test case.** `test/components/app.test.jsx` new comparison-gate cases in the existing
"connection share links" describe block, contrasted directly against the untouched
matching-values case; `test/e2e/browser/profiles.test.mjs` new describe block: live tab + a
differing hash → pre-filled form + absent request to the new endpoint, matched pair on all
three engines.

---

## Coverage gaps and open questions for the implementer (not covered above)

- **B4's live probe** has no test at all by design — it is an operator action recording answers
  in the design doc, not code. QA has nothing to verify here; flagging only so it is not
  mistaken for a missed item.
- **A2 (selection-bar folder link)** is deferred scope — no test plan needed until it is
  un-deferred.
- **A1's clipboard-read permission on WebKit** is an open harness question (noted inline above)
  that should be resolved *before* the e2e case is written, not discovered as a flaky skip later.
- **B3's toast selector**: this plan assumes `toastStore.get().at(-1).message` for the
  component layer and an unspecified DOM selector for the e2e layer — check
  `test/components/toast-host.test.jsx` and any existing e2e toast assertions before inventing
  one.
- **S1's module home** (`url-params.js` vs `base-prefix.js`) is left open pending the actual
  implementation — this plan names both candidate test files so whichever is chosen already has
  its extension point identified.
- **BUG-LOG numbering**: this plan uses `BUG-0XX` placeholders since these are not yet
  discovered-in-production bugs but design-panel findings being fixed pre-emptively; the
  implementer should confirm with the operator whether panel-sourced fixes still warrant
  BUG-LOG entries (this plan assumes yes, per the global rule "when a real bug is fixed, log it,"
  and B1/B2/B3/S1/S2 are all real, demonstrated-or-reproduced defects, not speculative
  hardening).
