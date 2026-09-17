# Prefix access — architect's plan

**Lane:** architect · **Date:** 2026-09-16 · **Input contract:** `00-facts.md` (read in full;
every claim below that rests on code was re-read at `main` @ `0b24aea`, v1.62.3) ·
**Tier:** T-tool (`CLAUDE.md` § Verification Gate) · **Consumer:** the EM synthesis into
`docs/superpowers/specs/2026-09-16-prefix-access-design.md`.

The four questions in `00-facts.md` are answered in § Positions (Q1–Q4). Items are in
§ Items, in implementation order; § Hand-off assigns them.

---

## 1. Change and motivation, in system terms

Bucketer has **two link families** that must never be confused, and one **floor
mechanism** that both depend on:

| Family | Builder → reader | The link is… | Recipient must… |
|---|---|---|---|
| Connection-share (`#endpoint&bucket&provider&region[&basePrefix][&keyId]`) | `buildShareUrl` (`src/lib/url-params.js:75-87`) → `readUrlParams` (`:21-63`) | a *pointer* to a bucket | authenticate with their own secret |
| Presigned (`#dl=<base64url>`) | `buildShareLink` (`src/lib/share-url.js:38-43`) → `readShareLink` (`:45-55`), routed in `src/main.jsx:17-18` before `App` ever mounts | a *credential* for one object | nothing |

A third hash param, `prefix`, is **navigation state**: written by `pushPrefixHistory`
(`url-params.js:94-106`), read on the first Browser mount and clamped to the floor
(`src/components/Browser.jsx:67-83`). No builder includes it today, so the header
"Copy link" from inside a subfolder produces a link that opens at the floor.

**Problem A** is therefore a *missing field in an existing contract*, not a new
mechanism: the connection-share link should carry `prefix`, whose reader already exists.

**Problem B** is a *guidance failure at the connect boundary*: `handleConnect`
(`src/components/App.jsx:311-364`) does not probe; the first `fetchPage`
(`Browser.jsx:351-412`) at the floor fails and `onInitialListFailed` (`App.jsx:1810-1813`)
flips to the failed splash, where `ErrorBlock` (`src/components/ErrorBlock.jsx:21-106`)
shows the Base-folder hint as one red paragraph among three — and, on the CORS-masked
wire shape, the diagnostics verdict `cors-blocked` (`src/lib/connection-diagnostics.js:27`)
confidently blames CORS. The 2026-07-26 diagnostics design's stated rationale
("if CORS were configured correctly, even bad credentials would surface as a readable
403") is only sound if the provider attaches CORS headers to error responses, which for
B2 is unverified (flagged as unresolved in the 2026-08-13 record).

While tracing the quick-switch path I found a third, unreported gap that turns Problem B
into a **loop** for saved connections (§ 2.3). It is in scope because "fully solves"
means the fix survives a reload.

---

## 2. System impact map

Single repo, single static bundle, no backend, no service boundary crossed. Every touched
part is inside `bucketer`; the "instances" are the deployed bundle at
`https://bucketer.hidayahtech.net/` and every copy of an old share link in the wild.

### 2.1 Problem A — folder links

| Part | How touched |
|---|---|
| `src/lib/url-params.js` `buildShareUrl` | gains an option to include `prefix` (contract change, § 3) |
| `src/components/ShareLinkMenu.jsx` | receives the current folder; passes it to both variants; caption names the landing folder |
| `src/components/App.jsx:1542` | passes `currentPrefix` (state at `:194`, kept current by `Browser.jsx:230-232` on every prefix change) to the menu |
| `src/components/Browser.jsx:67-83` | **unchanged** — the reader; already clamps and announces |
| `src/main.jsx` | **unchanged** — `dl` routing precedence is already exclusive |
| `test/url-params.test.js`, `test/components/share-link-menu.test.jsx`, `test/e2e/browser/prefix-scope.test.mjs` | consumers; extended, not rewritten |
| Old links in the wild | unaffected (additive param; § 3 migration) |
| Folder rows (`Browser.jsx:1370-1470`), `CopyLinkPopover`, `share-url.js` | **untouched** (decision Q1) |

### 2.2 Problem B — connect failure explanation

| Part | How touched |
|---|---|
| `src/components/ErrorBlock.jsx` | scope hint becomes first-class (own block, before the CORS note), gains a two-state form (floor unset / floor set-but-denied) and an optional action callback |
| `src/components/App.jsx:1627-1636` (failed splash) | passes the action (focus + scroll `#cred-baseprefix`, `CredentialForm.jsx:263-278`) and the current floor |
| `src/lib/connection-diagnostics.js` | `diagnosticsProps` carries `basePrefixUnset`; `runDiagnostics` selects a new verdict variant for the connect screen (same pattern as `connected` → `cors-blocked-transient`, #52) |
| `src/components/Browser.jsx:858-869` (`!canList` in-session block) | unchanged (guidance string already names Base folder; in-session, not the connect boundary) |
| `test/e2e/mock-s3/server.mjs` `sendXml`/`corsHeaders` (`:190-252`) | test-infra knob to omit CORS headers on error responses (models the masked shape; § Q4 fidelity) |
| `test/components/error-block.test.jsx`, `test/connection-diagnostics.test.js`, `test/e2e/browser/prefix-scope.test.mjs`, `test/e2e/mock-s3/server.test.mjs` | consumers; extended |

### 2.3 The quick-switch loop (found while tracing; verified by code reading, not yet reproduced)

`switchToConnection` (`App.jsx:1306-1324`) resolves the record, connects; the initial
list fails; the failed splash shows the form pre-filled from the record. The user sets
Base folder and connects: `handleConnect` calls `saveCredentials(fullCreds)` (flat
mirror, `storage.js:98-104`) and `setCredentials`, but **never writes the selected
connection record** — the only `saveConnectionRecord` calls are `handleSaveProfile`
(`App.jsx:1326-1369`, the explicit Save button) and the vault-offer accept path
(`App.jsx:429-448`, gated off). On the next reload the credentials initializer
(`App.jsx:181-184`) spreads `...conn` from the record, whose `basePrefix` is still `''`,
so the auto-connect fails identically and the same "explanation" reappears. The user
reads that as "it didn't save". `saveConnectionRecord` supports partial updates
(`connections.js:160-170`: undefined-filtered spread), so the fix is a one-field write.

---

## 3. Contract changes

### 3.1 The hash contract (the only interface that changes)

Consumers of the fragment, exhaustively: `readUrlParams`/`hasUrlParams`
(`url-params.js`), `pushPrefixHistory`, `Browser.jsx:67-83` first-mount restore,
`App.jsx:521-532` hashchange effect (non-connected states only, BUG-047),
`main.jsx:17` `dl` route, and the specs `test/url-params.test.js`,
`test/e2e/browser/prefix-scope.test.mjs`, `test/e2e/browser/profiles.test.mjs`
(BUG-047 case), `test/components/share-link-menu.test.jsx`. Plus every share link ever
copied.

**Contract after this batch** (params, owner, precedence):

| Param | Owner | Written by | Read by | Rule |
|---|---|---|---|---|
| `dl` | presigned route | `buildShareLink` | `main.jsx` | **Exclusive.** Presence routes to `DownloadPage`; every other param is ignored. No builder ever combines `dl` with the others (structural: `buildShareUrl` has no `dl` path; `buildShareLink` writes only `dl`). |
| `endpoint`, `bucket`, `provider`, `region`, `keyId`, `basePrefix` | connection | `buildShareUrl` | `readUrlParams`, `hasUrlParams` | unchanged (2026-07-10, 2026-08-13 records) |
| `prefix` | navigation | `pushPrefixHistory` (today) **+ `buildShareUrl` (new)** | `Browser.jsx` first mount only | `basePrefix` outranks it: `clampToFloor(prefix, floor)` + visible notice. **Not** consumed by `readUrlParams` and **not** in `hasUrlParams` — a bare `#prefix=` (a locally-connected user's address bar) must never trigger the "pre-filled from URL" banner (`App.jsx:1610-1618`). Both invariants are already asserted (`url-params.test.js:237-241`, `:274`); keep them. |

**Emission rule for `buildShareUrl`:** include `prefix` only when it is non-empty **and
differs from the connection's floor** (`credentials.basePrefix || ''`). Consequence — the
back-compat anchor: a link copied at the root of an unscoped connection, or at the floor
of a scoped one, is **byte-identical to v1.62.3 output** (extends invariant 4 of the
2026-08-13 record). Ordering of params is not part of the contract; consumers parse.

**Migration order:** none required. The reader shipped first (v1.14.4, repaired in
v1.50.0 / BUG-058); the writer is being added second. Old links lack `prefix` → behave
exactly as today. New links opened by a stale cached bundle ≥ v1.50.0 land in the
folder; by a bundle older than that, at the floor — never broken, never a 403 (the clamp
is client-side). No consumer is ever mid-deploy-broken because there is only one deploy
unit and it ships reader-before-writer already.

### 3.2 Internal component contracts (not interfaces with the outside; listed for the implementers)

- `buildShareUrl(credentials, { includeKeyId, prefix })` — additive option; default call
  byte-identical.
- `ShareLinkMenu({ credentials, prefix })` — additive prop.
- `ErrorBlock` — additive props: the current floor (so the hint can show the
  set-but-denied variant) and an optional action callback for the "Set Base folder"
  button. `basePrefixUnset` may be derived from the floor prop; the implementer decides
  whether to keep both (its consumer is the failed splash only; `Browser.jsx:861` does
  not pass it).
- `diagnosticsProps(credentials, connected)` — gains `basePrefixUnset` in the returned
  object; `runDiagnostics` reads it. The failed splash (`App.jsx:1633`) is the only
  caller with `connected=false`; the four Browser callers (`Browser.jsx:865, 1312, 1321,
  1687`) all pass `true` and are unaffected because the new variant is selected only
  when `!connected && basePrefixUnset`.
- Mock: `configure({ corsOnErrors: false })` (name at the implementer's discretion) —
  `corsHeaders` omitted on `sendXml` calls with status ≥ 400. `reset()` restores the
  default. Test infrastructure, not product.

Nothing else changes shape. No new dependency, no new module, no backend.

---

## Positions on the four questions

### Q1 — the user-facing model for "a link to this folder"

**Position: a folder link is a connection-share link that lands in a folder. It belongs
to the header "Copy link" menu and to no other surface.** The recipient authenticates,
exactly as with today's connection link; the only difference is where they land.

Reasoning:

- A folder cannot be presigned. A "link that IS the credential" for a folder would need
  either a listing credential in the URL (never — REQ-5 and the secret-key exclusion are
  structural) or N presigned URLs (that is the existing batch "Copy links", a file
  operation). So there is only one honest family for folders, and it is the
  authenticate-to-open one.
- The two families must stay distinguishable *by placement*, not by wording. Today the
  per-row `⎘` (`Browser.jsx:1620-1635`), the preview "Copy link" (`:1110-1130`) and the
  batch "Copy links" (`:1235-1250`) all mean "credential-bearing, time-limited, works
  for anyone". The header "Copy link" means "pointer, sign-in required". A folder-row
  button beside `⎘` that yields a sign-in-required link would put two meanings of "copy
  link" in the same column one row apart. That is the confusion the brief forbids, and
  the operator's own hedge ("this may differ from how files are copied") points the
  same way.
- Recipient floor differs — every case is already handled by existing code, which is
  why this is the boring option:

  | Sender | Link carries | Recipient's stored floor | Result |
  |---|---|---|---|
  | unscoped, in `p` | `prefix=p` | none | lands `p` |
  | unscoped, in `p` | `prefix=p` | `G` (their own record keeps it; `readUrlParams` has no `basePrefix` to override it) | `p` under `G` → lands `p`; else clamped to `G` + notice (`Browser.jsx:76-83`) |
  | unscoped, in `p` | `prefix=p` | scoped key, no Base folder set | lists `p` directly; works if `p` is under their key's prefix (B2 permits a more-restrictive prefix, doc cited in `00-facts.md`); root crumb then 403s in-session → existing `!canList` guidance |
  | scoped `F`, in `p` | `basePrefix=F&prefix=p` | unscoped | form pre-fills `F` (editable, per 2026-08-13); floors at `F`, lands `p` |
  | scoped `F`, in `p` | `basePrefix=F&prefix=p` | scoped key with floor `G ≠ F` | link's `F` **overrides** their `G` (`App.jsx:184` spreads `fromUrl` last) → first list at `F` is denied → failed splash **with the floor set**, so today's hint is gated off (`ErrorBlock.jsx:39`). This is the case that motivates the set-but-denied hint variant in item B1. |

**Losing options, named:**

- *Folder-row copy-link action (operator's first instinct).* Rejected for this batch:
  placement confusion (above), a new per-row control on mobile (the row-actions cell
  wraps via flex, `src/styles/main.css:1217-1219`, so it would not overflow, but it is
  the #49/BUG-042 class and each folder row grows), and it would need the two-variant
  menu per row (the key-ID choice, 2026-07-10 decision 1) or silently pick one. If the
  ux-review lane judges "navigate into the folder, then Copy link" too costly, the
  constraint for any row action is: it opens the **same** `ShareLinkMenu` component
  parameterised by that folder, it is labelled as sign-in-required, and it never uses
  the `⎘` glyph. Recorded as item A2 (deferred).
- *Breadcrumb crumb action.* Same objections, less discoverable. Rejected.

### Q2 — which variants carry the folder, automatic or labelled

**Position: both variants ("Connection only" and "Include access key ID") carry the
current folder automatically whenever the user is not at the floor; the open menu shows
a one-line caption naming the landing folder ("Opens at `clients/acme/sub/`") and the
existing toast strings are unchanged.**

Reasoning: the folder is not secret — it is already in the sender's address bar and in
the same "operationally necessary" category the 2026-08-13 record used to include
`basePrefix` unconditionally. A link that lands where the sender was standing is strictly
more informative and costs the recipient one breadcrumb click if they wanted the root.
The 2026-07-10 record's pattern ("no sender-side confirmation; the menu label and a
distinct toast make the behaviour explicit") is followed by putting the fact in the menu
caption. Keeping the toast strings unchanged avoids churning
`share-link-menu.test.jsx:66-95`, which assert them exactly.

**Losing options:** a third/fourth menu item or a checkbox "Open at this folder" (doubles
the menu or adds a control for a choice the breadcrumb already gives the recipient);
carrying the folder only in the key-ID variant (no principled reason to split).

### Q3 — explaining a prefix-restricted key on the failed-connect screen

**Position: three coordinated moves, all extensions of what exists — (i) make the scope
hint a first-class block with a "Set Base folder" action that focuses and scrolls the
field into view, rendered *before* the CORS note and shown on both wire shapes; (ii) make
the diagnostics verdict honest on the connect screen when no floor is set, via a context
variant exactly as #52 did for `connected`; (iii) persist a corrected floor into the
selected saved connection so the quick-switch path does not loop.**

(i) supersedes the 2026-08-13 declined-scope item "Focus-jump button in ErrorBlock"
under its own reopen clause ("Reconsider if users miss it" — the operator has). It also
extends that record's "Error recovery" section with the set-but-denied state (Q1's last
row): when a floor *is* set and the first list is still denied, the hint says the floor
is `F` and that a key limited to a different folder needs it corrected. The two states
are one block with two texts, not two blocks.

On the masked shape, the hint must not be the appended sentence of the CORS paragraph
(`ErrorBlock.jsx:56-57`, which is what was missed); it is its own block, above, and the
appended sentence is removed (dedupe). Ordering the scope hint first is correct because
on the connect screen with no floor, the two causes are a priori equally likely and the
scope one is the cheaper to test (type a folder, reconnect) — but the copy must present
them as alternatives with the discriminating question ("Is your key limited to a
folder? B2 calls this a Name Prefix"), never assert the scope cause. Exact wording,
visual weight and the button's placement belong to ux-review/frontend; the constraints
are: reachable without scrolling on mobile (the button is in the error, the field is
~400 px up — the action scrolls), keyboard-focusable, and the CORS path for a user whose
CORS really is broken still leads to Run diagnostics.

(ii) The `cors-blocked` verdict's rationale (2026-07-26 design, "Rationale for check 6")
holds only when the provider sends CORS headers on error responses. For the connect
screen with no floor, the verdict becomes a variant that says the browser blocked the
response and that **two causes look identical from here** — missing CORS on the bucket,
or a key limited to a folder with no Base folder set — and points at each remedy. It is
selected by `!connected && basePrefixUnset`; every other combination keeps today's
verdicts. This is correct **under either outcome of the live probe**: if B2 does send
CORS headers on 403, a masked error on B2 really is CORS, but the variant is still true
in general (IAM/other providers) and still names CORS first-class; if B2 omits them, the
variant is the only honest one.

(iii) See § 2.3. Constraint: write the floor to the record **only after** the listing at
that floor succeeded (never persist a floor that was itself denied), and only when the
record's floor was empty (the recovery case — "a floor being discovered"). Editing an
already-set floor stays with the explicit Save flow (`handleSaveProfile`), because
`basePrefix` is part of a connection's identity there (`App.jsx:1350-1353` treats
same-bucket-different-floor as a distinct connection). A short toast ("Base folder saved
to *<connection name>*") makes the write visible; silent persistence of a credential
property would be a surprise.

**Is there a pre-list probe that distinguishes "wrong credentials" from
"prefix-restricted" without knowing the prefix?** Honestly: **no probe, but a
discriminator already in hand.**

- Any authenticated request outside the (unknown) prefix is denied for both causes;
  `HeadBucket`/`ListBuckets` are not reliably granted to scoped keys; a `no-cors` probe
  returns an opaque response with no status. So no request Bucketer can issue separates
  the two when the response is masked.
- When the response is **readable**, the S3 error *code* does separate them:
  `SignatureDoesNotMatch` / `InvalidAccessKeyId` mean the credential itself is bad;
  `AccessDenied` means the credential is valid but not permitted for this request, of
  which a prefix restriction is the common cause. `parseS3Error` already surfaces the
  code (`format.js:43-50`). Item B1 uses it to *sharpen*, not gate: on a bad-credential
  code, the scope hint is not shown (the "credentials are simply wrong" sentence is the
  message); on `AccessDenied`/403/401-without-code, the scope hint shows. **Hedge:** the
  bad-credential codes are AWS S3 convention; B2's actual codes for a bad secret/key ID
  are unverified — the live probe (item B4) records them. Until then the gate stays
  inclusive (any 403/401/AccessDenied shows the hint, as today) and the sharpening is
  applied only for the two named codes.

**Losing options, named:**

- *A real pre-connect probe in `handleConnect`.* Cannot distinguish the causes (above),
  adds a request per connect (B2 bills per list call — README), and the stale
  "ListObjectsV2 probe in flight" comment at `App.jsx:7-10` shows the fleet already
  moved away from it. Rejected.
- *Provider-gated wording (only for `provider === 'b2'`).* IAM `s3:prefix` keys have the
  same failure; keep provider-agnostic, name B2's term in the copy. Rejected.
- *Auto-detecting the prefix.* Declined in the 2026-08-13 record (CORS-blocked at
  `api.backblazeb2.com`, would need a proxy). Not reopened.
- *Moving the error above the form.* Fixes desktop discoverability but not the
  mobile distance and does not give an action. The focus-jump does both. Rejected as
  the sole fix; ux-review may still recommend it in addition.

### Q4 — smallest change set and its verification

Six items, four with code (three patch, one minor), sequenced so each is independently
shippable and each has one observable. See § Items for observables, specs, fidelity
statements and bump class. The whole batch touches `url-params.js`, `ShareLinkMenu.jsx`,
`ErrorBlock.jsx`, `connection-diagnostics.js`, two small regions of `App.jsx`, and the
mock — nothing in `Browser.jsx`, `CopyLinkPopover.jsx`, `share-url.js`, `main.jsx`.

**What only a live B2 probe can settle** (item B4; the EM has no restricted key, the
operator does):

1. The HTTP status and `<Code>` B2 returns for a ListObjectsV2 whose `Prefix` is outside
   the key's Name Prefix (the doc cited in `00-facts.md` states the rule, not the wire
   response).
2. Whether that response carries `Access-Control-Allow-Origin` for the page origin —
   i.e. whether shape (a) in `00-facts.md` is real. This decides whether B2 users see
   "Access Denied" (readable) or "Failed to fetch" (masked) and therefore which of the
   two B1 paths they hit.
3. B2's codes for a wrong secret and a wrong key ID (the Q3 sharpening hedge).
4. Whether a non-folder Name Prefix (`photos-2024`) is accepted with the normalised
   `Prefix=photos-2024/` (the doc says a more-restrictive prefix is allowed; confirm).

**Designed to be correct either way:** the hint shows on both shapes (B1); the verdict
names both causes on the masked shape (B2); the readable-shape path is exercised in the
harness as today, and the masked shape is exercised via the mock knob, whose fidelity
statement must say it models the *hypothesis* that a provider omits CORS headers on
errors, not that B2 does.

---

## Items (implementation order)

Each item is one GitLab issue and one commit (plus its version bump commit per the repo's
package model). Bump classes follow `CLAUDE.md` / global versioning: patch for fixes,
minor for features. Suggested versions assume nothing else ships in between.

### B1 — First-class Base-folder hint with "Set Base folder" action  · patch (v1.62.4) · BUG-LOG entry

- **Change:** `ErrorBlock` renders the scope hint as its own block directly under the
  message, before any CORS note, on both wire shapes (`basePrefixUnset && (deniedLike ||
  corsLike)`), with a button that focuses `#cred-baseprefix` and scrolls it into view;
  second text variant when a floor is set but denied; CORS note loses its appended
  sentence; bad-credential codes (`SignatureDoesNotMatch`, `InvalidAccessKeyId`)
  suppress the scope hint. Failed splash (`App.jsx:1627-1636`) wires the action and the
  floor.
- **Observable (QA measures this one thing):** on the failed-connect screen after a
  scoped-mock denial with no Base folder, clicking **Set Base folder** makes
  `document.activeElement` the `#cred-baseprefix` input **and** the input's bounding
  rect is inside the viewport — on desktop and on the Pixel 5 profile.
- **Specs:** `test/components/error-block.test.jsx` (hint order, two variants, code
  sharpening, action callback); e2e `prefix-scope.test.mjs` new case (the observable);
  existing "recovery hint" case stays green.
- **Matched pair:** pre-fix bundle has no button → the new spec fails; post-fix passes.
  All three engines (operator policy 2026-09-05).
- **Sideways verification** (`CLAUDE.md` § Bug tracking): the CORS note still renders
  for CORS-like errors without a floor context (`error-block.test.jsx:120`), the
  in-session `!canList` block (`Browser.jsx:858`) is unchanged, and Run diagnostics still
  appears on CORS-like errors.
- **Harness fidelity statement:** "readable-403 shape only; B2's real denial/CORS shape
  is not represented — see B2 for the masked shape."
- **BUG-LOG:** symptom = operator connected a B2 Name-Prefix key and saw no usable
  explanation; root cause = hint rendered as the third paragraph / appended sentence,
  no action, field off-screen on mobile; why not caught = the e2e assertion checks
  `textContent.includes('Base folder')`, which passes for buried text — a proxy, not an
  observable (postmortem class).

### B2 — Honest diagnostics verdict on the connect screen · patch (v1.62.5) · BUG-LOG entry

- **Change:** `diagnosticsProps` carries `basePrefixUnset`; `runDiagnostics` returns a
  new verdict (e.g. `cors-blocked-or-scoped`) when `!connected && basePrefixUnset` and all
  probes pass; `VERDICT_MESSAGES` gains its text (both causes, both remedies). Mock gains
  the `corsOnErrors:false` knob (+ self-test in `server.test.mjs`).
- **Observable:** with the mock configured `scopePrefix` + `corsOnErrors:false`, no Base
  folder, connect → the error is CORS-like → click **Run diagnostics** → the verdict
  text names both a folder-limited key and CORS, and the B1 **Set Base folder** button
  is present on this (masked) shape too. Presence beside it: `mock.requestLog` shows the
  root list reached the mock.
- **Specs:** `test/connection-diagnostics.test.js` (variant selection; every other
  verdict unchanged); e2e `prefix-scope.test.mjs` masked-shape case; `server.test.mjs`
  knob self-test.
- **Matched pair:** pre-fix verdict says "almost certainly missing or incorrect CORS" →
  fails; post-fix passes. Three engines.
- **Harness fidelity statement (mandatory wording):** "The mock's `corsOnErrors:false`
  models the hypothesis that a provider omits CORS headers on error responses; it does
  not establish that Backblaze B2 does. No e2e coverage: harness cannot represent B2's
  real denial/CORS behaviour."
- **Sideways:** `cors-blocked` and `cors-blocked-transient` unchanged for their
  contexts (all four Browser callers pass `connected=true`; the connect screen with a
  floor set still gets `cors-blocked`).

### B3 — Persist a discovered floor into the selected saved connection · patch (v1.62.6) · BUG-LOG entry (after reproduction)

- **Pre-step for QA:** reproduce § 2.3 in the harness (saved connection with empty
  floor → quick-switch or auto-connect fails → set Base folder → connect succeeds →
  reload → auto-connect fails again). If it does not reproduce, drop the item and record
  why.
- **Change:** after the first successful listing at the floor, if a connection is
  selected and its record's `basePrefix` is `''` while `credentials.basePrefix` is set,
  `saveConnectionRecord({ id, basePrefix })` and refresh `connections`; toast names the
  connection. Where to hook (the `list → permitted` capability transition, or the
  `session==='connected'` effect at `App.jsx:203-205` combined with the listing result)
  is the implementer's call; the constraint is *after success, never before*.
- **Observable:** the reload after recovery auto-connects and renders a row from inside
  the floor (presence) with no root list in `mock.requestLog` (absence).
- **Specs:** e2e `profiles.test.mjs` (saved-connection territory) new case; unit for the
  guard (empty-floor-only, success-only).
- **Matched pair:** three engines. **Fidelity:** readable shape; no B2-specific claim.
- **Sideways:** `handleSaveProfile`'s same-bucket-different-floor distinctness
  (`App.jsx:1350-1353`) is unaffected because the write is limited to empty-floor
  records; capabilities on the record are not touched (partial update).

### B4 — Live B2 probe · no bump · operator action, one-page runbook in `docs/`

With a real Name-Prefix key: connect without Base folder in Chromium with DevTools
open; record for the ListObjectsV2 the status, `<Code>`, `Access-Control-Allow-Origin`
presence; repeat with a wrong secret and a wrong key ID; connect with a non-folder
Name Prefix and its normalised Base folder. Record the four answers in the synthesized
spec's "Research findings" and in the 2026-08-13 record's "Unresolved" bullet. If B2's
codes differ from the S3 convention, a follow-up patch adjusts the Q3 sharpening list.
Can run any time after B1/B2 ship (they are correct either way) — it is not a blocker.

### A1 — Header "Copy link" carries the current folder · minor (v1.63.0)

- **Change:** per § 3.1 emission rule; `ShareLinkMenu` gets `prefix`, passes it to both
  variants, shows the "Opens at …" caption when the folder differs from the floor;
  `App.jsx:1542` passes `currentPrefix`.
- **Observable:** copy "Connection only" from inside `clients/acme/sub/`, open the
  copied URL in a fresh context, enter key ID + secret, connect → a `file-row` from
  inside `sub/` renders (presence) and `mock.requestLog` contains no ListObjectsV2 with
  an empty prefix (absence, beside it).
- **Specs:** `url-params.test.js` (round-trip; byte-identity at root and at floor;
  `prefix` still not consumed by `readUrlParams`/`hasUrlParams`);
  `share-link-menu.test.jsx` (both variants carry `prefix`; caption; toasts unchanged);
  e2e `prefix-scope.test.mjs` new case (observable) — note the existing in-floor
  deep-link case already proves the reader; the new case proves the writer.
- **Not-inert evidence** (feature analogue of matched pair, per the 2026-08-13 record):
  the new e2e case run against pre-feature main fails (link lands at root), then passes.
- **Fidelity:** fully representable; no statement needed beyond "clipboard read via
  the harness's existing stub".
- **Sideways:** existing share-link e2e cases (`prefix-scope.test.mjs` shared-link
  screen, `profiles.test.mjs` BUG-047) unchanged and green; `#dl=` route untouched.

### A2 — Folder-row link action · deferred (not in this batch)

Record as a declined-scope bullet in the synthesized spec with the Q1 reasoning and the
constraints for reopening. Reopen only on a ux-review finding against the navigate-then-
copy path, and then as its own minor item.

---

## Operational story

- **Deploy:** one static bundle. Each item is a version-bump commit that includes the
  rebuilt `dist/index.html` and `src/lib/changelog.js` (`CLAUDE.md` § Workflow; the
  stale-dist CI guard is the backstop); Forge serves the committed bundle; live-verify
  by reading the `app-version` meta from the deployed origin. Pre-push hook runs unit,
  component and node e2e; the browser 3×3 runs in CI — do not merge a red pipeline.
- **Failure modes and their containment:**
  - A1 emits a `prefix` a recipient's key cannot list → the clamp (floor-set case) or
    the in-session `!canList` block (floor-unset case) — never an unexplained dead end,
    and B1 covers the floor-set-but-denied connect case.
  - A folder link pasted into an already-connected tab does nothing (same-document
    navigation; the hashchange effect is deliberately scoped to non-connected states,
    BUG-047). Known, accepted, unchanged by this batch; the recipient's fix is the same
    as for every share link today (disconnect first). Not worth a new mechanism.
  - A link pasted into a tab that has connected once and then disconnected: the
    `firstBrowserMountRef` gate (`App.jsx:202-205`) has retired, so `prefix` is ignored
    on that connect and the user lands at the floor. Pre-existing edge, same class as
    the above; noted for the frontend implementer to confirm and for the record, not a
    requirement of this batch.
  - B1's focus-jump targets an element by id that lives in `CredentialForm`; if the form
    is ever re-keyed mid-click the focus is lost harmlessly (no exception path).
  - B2's variant is text-only; a wrong variant misleads but cannot break a connection.
  - B3 writes one field to localStorage after a successful listing; a wrong write is
    self-healing (the user edits the field and connects; the empty-floor guard means it
    is never overwritten again silently).
- **Rollback:** revert the item's commit and the bump; old links keep working in both
  directions (§ 3.1). No data migration exists to undo; B3's written field is read by
  every version since v1.50.0 as an ordinary `basePrefix`.
- **Observation:** none at runtime (client-only, no telemetry — a product pillar). The
  observables above, the CI matrix on the deploy commit, and the live-verify are the
  observation. The B4 probe result is the only piece of operational knowledge this batch
  cannot generate for itself.
- **Cost:** zero runtime cost; no new dependency; bundle growth is a few hundred bytes of
  copy. B1 adds no request; the decision against a pre-connect probe keeps B2's per-call
  list billing unchanged.

---

## Decision records relied on or contradicted

- `docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md` — **relied on**
  throughout: floor/clamp model, `basePrefix` in links as operationally necessary,
  `prefix` vs `basePrefix` naming and coexistence, harness-fidelity wording, the
  "unresolved" CORS-on-403 bullet (which B4 closes). **Superseded, explicitly:** its
  declined-scope item "Focus-jump button in ErrorBlock", under that item's own reopen
  clause. **Extended:** its "Error recovery" section with the floor-set-but-denied state
  and the code-based sharpening.
- `docs/superpowers/specs/2026-07-10-copy-link-with-key-id-design.md` — **relied on:**
  two variants not a replacement; no sender-side confirmation with explicitness via menu
  and toast; presigned links explicitly out of that mechanism's scope (kept so here);
  `readUrlParams` spread-last precedence (`App.jsx:184`), which is what makes the
  floor-override row in Q1's table happen.
- `docs/superpowers/specs/2026-07-26-connection-diagnostics-design.md` — **relied on**
  for the check list; its check-6 rationale is **qualified, not contradicted**: the
  inference holds only where the provider sends CORS headers on errors, so the connect
  screen with no floor gets a context variant, following the precedent #52 set with
  `connected` → `cors-blocked-transient`.
- `BUG-LOG.md` BUG-047 (same-document share links), BUG-058 (dead `isFirstMount`
  restore), BUG-042 (mobile actions column) — relied on for the hash-consumer list and
  the mobile constraint.
- `CLAUDE.md` § Tests / E2E Evidence Rules, § Bug tracking (sideways verification,
  harness fidelity), § Verification Gate (T-tool) — the verification shape of every item.
- **Gaps worth filing:** (1) no record anywhere of B2's error wire shape and CORS-on-error
  behaviour — B4 produces it; it should land in the synthesized spec and be back-cited
  from the 2026-08-13 record. (2) The stale header comment at `App.jsx:7-10` ("initial
  ListObjectsV2 probe in flight") describes a probe that no longer exists; a one-line
  docs fix, not part of this batch (surgical-changes rule), but the EM should file it.

---

## Hand-off

Order of implementation: **B1 → B2 → B3 → A1**, with B4 whenever the operator has a key
(independent). B1/B2 could share one version if shipped together, but keep separate
commits and issues.

| Role | Implements | Reviews |
|---|---|---|
| **frontend** | B1 (`ErrorBlock.jsx`, failed-splash wiring in `App.jsx`), B2 (`connection-diagnostics.js` + `VERDICT_MESSAGES`, and the mock knob in `test/e2e/mock-s3/server.mjs` since the product spec depends on it), B3 (`App.jsx` post-success write; confirm the hook point), A1 (`url-params.js`, `ShareLinkMenu.jsx`, `App.jsx:1542`). Constraints that are boundaries, not style: § 3.1 emission rule and byte-identity anchor; `prefix` never enters `readUrlParams`/`hasUrlParams`; B3 writes only after listing success and only for empty-floor records; the scope hint renders before the CORS note. Each commit message carries the item's harness-fidelity statement verbatim. | — |
| **ux-review** | — | B1 copy, hint structure and button placement on desktop and Pixel 5 (the "cannot be missed" judgment — walk it as the least technical user, from both the connect form and a quick-switch tab); A1 caption wording; the A2 deferral (is navigate-then-copy acceptable?). |
| **security** | — | A1's contract change (`prefix` disclosure class = `basePrefix`; `dl` exclusivity remains structural); B3's localStorage write (a credential property written without the Save button — confirm the empty-floor-only guard is sufficient). |
| **qa-verify** | The B3 reproduction (pre-step); the e2e cases named per item if frontend hands back product code only. | Baseline: full container 3×3 on the untouched tree first (`CLAUDE.md` E2E Evidence Rules). Per item: the single observable, matched-pair (B1/B2/B3, three engines, same image tag recorded) or not-inert evidence (A1), sideways spec runs, and that every commit's fidelity statement is present and true. Reject any green that rests on `textContent.includes(...)` alone for B1 — the observable is focus + viewport. |
| **operator** | B4 probe and its four recorded answers. | Sign-off on the A2 deferral and on B3's silent-persist-with-toast choice. |
| **architect (this lane)** | — | Sign-off against intent after the build: one revision round. |
