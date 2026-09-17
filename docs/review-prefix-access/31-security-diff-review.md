# Prefix access — security & privacy review of the built diff (lane 31)

**Date:** 2026-09-16 · **Reviewer:** security persona (read-and-probe only; no subagents) ·
**Tree:** worktree `.claude-scratch/runs/prefix-access/wt`, branch `feature/prefix-access`, six item commits
`c0109d9..8a82b94` on top of `origin/main @ 0b24aea` (v1.62.3). Working tree clean except an uncommitted
`BUG-LOG.md` (+183 lines), not reviewed here. ·
**Prompted by:** my own pre-implementation lane (`docs/review-prefix-access/30-security.md`) set a must-fix list
(F2, F4, F6, F1+F3); this is the acceptance check of the code that claims to close it, plus a fresh pass over
everything the diff touches.

Line numbers are from the worktree at `8a82b94`. *Demonstrated* = I ran it (node-level against the worktree's
modules, or I read a spec that runs it in the browser and its assertion is the observable); *plausible-unverified* =
the code trace is complete but I did not execute it end-to-end.

---

## Rotation / incident items

**None.** What I checked so the negative means something:

- Every added line in `src/`, `test/`, `scripts/` swept for `console.log/debug/info`, `AKIA…` shapes, inline
  secret-looking `secretKey:` literals, and new `localStorage.setItem` sites: no hits. The only new persistent write
  is `saveConnectionRecord({ id, basePrefix })` (`src/components/App.jsx:283`), a floor, not a secret.
- No raw-HTML sinks introduced (`innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML` still absent from `src/`).
  Every new string that comes from a link (`prefix`, `basePrefix`, bucket) renders as a Preact text node or
  attribute (`Breadcrumb.jsx` `title`, `ShareLinkMenu.jsx:66`, `App.jsx:1671` banner, `ErrorBlock.jsx:135-140`).
- `buildShareUrl` still never reads `secretKey` (`src/lib/url-params.js:121-135`); the two structural exclusion
  tests survive (`test/url-params.test.js:47-57`, `:140-146`). Demonstrated below with a secret-bearing credential
  object: the secret does not appear in any variant.
- The new mock knob `corsOnErrors` exists only in `test/e2e/mock-s3/server.mjs`; `grep` over `src/`, `build.mjs`
  and the committed `dist/index.html` returns nothing. `build.mjs:154` bundles `src/main.jsx` only.

---

## Surface reviewed

| Area | Read |
|---|---|
| Hash intake / link emission | `src/lib/url-params.js` (full), `src/lib/base-prefix.js` (full), `src/lib/connection-link.js` (full) |
| Link surfaces | `src/components/ShareLinkMenu.jsx` (full), `Breadcrumb.jsx` (diff + context), `Browser.jsx` 60-90, 415-430, 1160-1175, `CopyLinkPopover.jsx` (diff) |
| Auto-connect / persistence | `src/components/App.jsx` 1-75, 176-335, 340-470, 500-660, 1330-1380, 1480-1515, 1590-1700; `src/lib/storage.js` (sessionStorage sites); `CredentialForm.jsx` 205-226 |
| Failure explanation | `src/components/ErrorBlock.jsx` (full), `src/lib/connection-diagnostics.js` (diff), `src/lib/format.js` 40-70 |
| Harness | `test/e2e/mock-s3/server.mjs` (diff), `server.test.mjs` (added tests), `test/e2e/run.mjs`, `scripts/e2e-container.mjs`, `test/e2e/browser/prefix-scope.test.mjs` (diff), `profiles.test.mjs` (diff), `test/url-params.test.js` 320-375 |
| Docs | `README.md` "Sharing links", `AGENTS.md` line, the design spec D1/D2/D6 and its gating paragraph (`docs/superpowers/specs/2026-09-16-prefix-access-design.md:96-116, 185-196, 232-245`) |

Probe script (scratchpad, not committed): imports the worktree's `base-prefix.js` and `url-params.js` under a stub
`window.location` and exercises `sanitizeNavPrefix`, `readHashPrefix`, `buildShareUrl`, `urlChangesConnection`
with the bypass candidates listed in point 3 below. Its output is quoted where cited.

---

## The eight acceptance points

### 1. Must-fix items from lane 30 — implemented as specified?

| Item | Verdict | Where | Gap |
|---|---|---|---|
| **F2** validated prefix intake at one read site | **Yes** | `base-prefix.js:44-48` `sanitizeNavPrefix` (cap 1024, no `\`, no `..` segment, then `normalizeBasePrefix`); `url-params.js:22-24` `readHashPrefix` is the one hash read; all three Browser sites route through it: first mount `Browser.jsx:74`, clamp notice `:81`, popstate `:424` (history-state value goes through `sanitizeNavPrefix` directly). Then `clampToFloor` as before. `readUrlParams`/`hasUrlParams` still do not consume `prefix` (`url-params.js:106-109`). | None. See point 3 for what the rule does and does not stop (nothing security-relevant slips). |
| **F4** links built from state via `buildShareUrl`, never the address bar; labels say folder included + recipient needs own key; no `CopyLinkPopover` reuse | **Yes** | Single builder `connection-link.js:66-77` → `buildShareUrl(credentials, { includeKeyId, prefix })`; header menu calls it at `ShareLinkMenu.jsx:41` with `prefix` = `currentPrefix` prop (`App.jsx:1598`, fed by Browser's `onUploadTargetChange` on every navigation, `Browser.jsx:230-232`); breadcrumb button calls it at `Browser.jsx:1168-1171` with Browser's own `prefix` state. `buildShareUrl` reads only `window.location.origin + pathname` (`url-params.js:133`), never `hash`/`href`. The only remaining `location.hash`/`href` readers in `src/` are `url-params.js:16` (param parsing), `share-url.js:46` (the `#dl=` route) and `IntegrityCheck.jsx:108` (self-fetch) — none feed a link. Labels: `ShareLinkMenu.jsx:60-73` name the folder in the item text; note at `:82` "The recipient needs their own secret key. It is never included."; toast names the folder and, when on, the key ID (`connection-link.js:57-63`). `CopyLinkPopover` is copy-only changes. | The session-persisted modifier is a soft surprise on the breadcrumb button (Finding S-3, Low). Not a gap against F4's wording — the keyId is still reachable only through the explicit checkbox. |
| **F6** hint gated on `AccessDenied`, not bare 401/403; SDNM/IAKI excluded; honest verdict; no speculative probes | **Mostly** | `ErrorBlock.jsx:37` `BAD_CREDENTIAL_CODES`; `:70-72` `isDeniedLike = !isBadCredential && (code === 'AccessDenied' \|\| status === 403 \|\| status === 401)`; verdict `cors-blocked-or-scoped` (`connection-diagnostics.js:33-38`, selected `:158-159`) says "can't tell … apart", never "almost certainly"; the diagnostics diff adds **no** request — the probes are the pre-existing `HEAD no-cors` pair. | The gate is *inclusive minus two codes*, which matches the design's operative sentence ("stays inclusive for everything except the two named codes", spec `:193-194`) but not lane 30's wording ("`AccessDenied` plus unknown-code 403"). Known non-scope 403 codes (`RequestTimeTooSkewed`, `ExpiredToken`, `InvalidToken`, `AccountProblem`, `AllAccessDisabled`) still get the bold "most likely reason: your key is limited to one folder". Misdirection only, no disclosure — Finding S-4, Low, should-fix. |
| **F1 + F3** no auto-connect on differing link values; banner names Base folder | **Yes** | `url-params.js:30-39` `urlChangesConnection` over all six link-settable fields; `App.jsx:631-638` skips `handleConnect` and pre-fills with `secretKey: ''`; banner `App.jsx:1671` renders `describeUrlParams(...)` which includes `base folder <value>` (`url-params.js:43-51`). Browser-demonstrated by `test/e2e/browser/profiles.test.mjs` (#70 block): second mock's request log stays empty, secret field empty, banner names "endpoint, bucket". | Two adjacent paths remain where link values merge over a secret still held in *state* (not auto-connect, one click away): Findings S-1 and S-2. |

### 2. Link building, keyId leak, secret exclusion

- **Every folder link goes through `buildShareUrl` from live credentials + prefix.** Both call sites listed under F4
  above; no other writer of `#prefix=`-bearing URLs exists besides `pushPrefixHistory` (history only, never copied).
- **Can the opt-in keyId leak into a link the user did not ask for?** The modifier is stored in `sessionStorage`
  (`connection-link.js:17-33`, key `s3b_share_include_keyid`) and read at click time by the breadcrumb button
  (`Browser.jsx:1170`) and as initial checkbox state by the menu (`ShareLinkMenu.jsx:24`). It is *per tab-session,
  per origin*, not per connection. Consequences: (a) ticked once, it applies to the 🔗 breadcrumb button, which has
  no indicator of the modifier's state — the user learns from the toast after the link is already on the clipboard;
  (b) it survives a reload and a tab duplication (both clone `sessionStorage`), and applies to a *different* saved
  connection switched to later in the same tab (that connection's key ID rides along). The design approved
  "session-persistent checked state" (spec `:101-102`), so this is a labelled trade, not a defect against the spec.
  It is still the one place a key ID can leave the tab without a same-moment choice. Finding S-3 (Low) with a
  one-line mitigation.
- **Secret structurally excluded.** `buildShareUrl` reads `endpoint, bucket, provider, regionOverride, basePrefix,
  keyId` and nothing else (`url-params.js:124-131`). Demonstrated: with `secretKey: 'SECRET'` in the credential
  object, `includeKeyId: true` output contains no `SECRET` and no `secretKey` param.

### 3. Intake rules and bypass candidates

**`buildShareUrl` prefix emission** (`url-params.js:130-131`): emitted only when `normalizeBasePrefix(prefix)` is
non-empty and differs from the normalized floor. Demonstrated: at floor → no `prefix` param (byte-identical to
pre-#69); below floor → emitted, `&`/`#` percent-encoded (`prefix=team%2Fa%26b%23c%2F`); slash-less input → emitted
with trailing slash; a prefix *outside* the floor is emitted too (`prefix=other%2F`) — unreachable from the UI (the
Browser clamps), and harmless: the recipient clamps with a notice.

**`sanitizeNavPrefix` / `readHashPrefix`** — demonstrated results (node):

| Input | Result | Assessment |
|---|---|---|
| `a∕..∕b` (U+2215), `a／..／b` (U+FF0F) | kept as a literal folder name | Not a bypass: S3 keys are opaque byte strings; only ASCII `/` is a delimiter. The `..` rule exists to stop a *display* lie, and a Unicode slash does not split a crumb either. |
| `%5C` (backslash) | `''` (rejected) | as specified |
| `%255C` (double-encoded) | literal `a%5Cb/` | harmless; the SDK percent-encodes it again in the query |
| `%00` (null byte) | `a b/` | harmless client-side: it lands percent-encoded in the `prefix=` query of a signed request and in text nodes; no header or path injection possible from a query value |
| `CRLF` | kept | same — query-encoded by the SDK; no header injection path |
| `#`, `&` inside the value | must be `%23`/`%26` to survive `URLSearchParams`; raw `#prefix=a#b` parses as `a#b/` | fine; `buildShareUrl` encodes on emission |
| `+` | decoded to space (form-encoding) | consistent with emission (`toString()` encodes space as `+`) |
| 1024 chars | kept; 1025 → `''` | as specified |
| `%2e%2e%2f` | `''` | rejected after decoding |
| leading-space folder `"  x/"` | trimmed to `x/` | functional edge (a folder whose name starts with a space cannot be deep-linked), not security |
| non-string history state (`5`, object) | `''` | popstate is safe against a tampered `history.state` |

**No scenario found** for prefix-driven injection: the value reaches (a) `ListObjectsV2` `Prefix` (query-encoded by
the SDK), (b) breadcrumb/label text nodes and `title` attributes, (c) `pushPrefixHistory` (re-encoded via
`URLSearchParams`). A non-existent or out-of-scope prefix costs the recipient one 200-empty or one 403 listing.

**`urlChangesConnection`** (`url-params.js:30-39`): compares every field `readUrlParams` can produce — `endpoint`,
`bucket`, `keyId`, `provider`, `regionOverride`, `basePrefix` (line 30 vs. the six `out.*` assignments at
`:60-101`). No uncompared field. `canon()` normalizations, demonstrated: host case difference → *changed*
(fails closed; SigV4 hosts are case-insensitive so this is over-cautious, fine); `:443` explicit port → *changed*
(fails closed); trailing slash → equal; `/team//` vs `team/` → equal (same floor); narrower floor → changed; a
region set where none stored → changed; whitespace around `keyId` → equal (`readUrlParams` already rejects
whitespace-bearing keyIds, so unreachable from a link). **No differing-but-canon-equal value changes what the key
signs against**: the only equalities tolerated are a trailing slash on the endpoint (same host, the form itself strips
it at submit, `CredentialForm.jsx:214`) and prefix-contract normalization of the floor.

`region` guard (F7): `url-params.js:88-90` now applies `≤64` and no-whitespace — demonstrated by the existing unit
table per the commit.

### 4. The mount effect (#70) and its neighbours

- **Auto-connect fully prevented on a differing link, including the vault path.** `App.jsx:631` computes
  `linkChangesConnection`; `:632-633` gates the flat-credential `handleConnect`; `:634-638` is the pre-fill branch;
  the vault branch at `:639-649` is an `else if` *after* it, so `tryAutoConnectViaVault(lastId, fromUrl)` runs only
  when the link repeats the stored connection. (`VAULT_ENABLED = false`, `src/lib/vault.js:49`; the post-unlock call
  at `App.jsx:426` passes no URL fields at all.) Browser-demonstrated by `profiles.test.mjs` #70 (differing → other
  mock sees zero requests; equal → still auto-connects).
- **Pre-fill with the secret cleared leaks nothing.** `prefill = { ...merged, secretKey: '' }` goes to React state
  and the form only; `saveCredentials` is called from `handleConnect` alone (`App.jsx:352`), which this branch does
  not reach. The secret remains in `sessionStorage` (`storage.js:105`) untouched — same as before the change; nothing
  new is written. One paint-window note: the `credentials` initializer at `App.jsx:186-194` still builds
  `{ ...conn, secretKey: stored.secretKey, ...fromUrl }` for the *first* render, so the form mounts once with the
  stored secret + link values before the effect remounts it (`setFormResetKey`) with the secret cleared. No request
  is possible in that window without a click; noted, not a finding.
- **`hashchange` handler (non-connected states)** `App.jsx:552-565` still merges `fromUrl` over `prev`
  (`:558-559`) without clearing the secret. In `session === 'failed'` the state *does* hold the secret
  (`handleConnect` → `setCredentials(fullCreds)` at `:376`, and the failed state keeps it). So a fragment-only
  navigation to a crafted link on a failed screen yields a form pre-filled with the attacker's endpoint, the user's
  key ID *and* their secret (masked), one click from signing to the new host. No auto-connect — acceptable per the
  contract — but the banner then says "enter your Key ID and Secret Key" while both are already filled. Finding
  S-1 (Low): clear `secretKey` in that merge when `urlChangesConnection(fromUrl, prev)`.
- **`saveCredentials` with link-supplied values without a user action?** No. Its one caller is `handleConnect`
  (`:352`); every `handleConnect` reaching it is either the equal-values auto-connect (values already stored), a
  form submit, a quick-switch, or the sidebar reconnect. `handleDisconnect` (`:508-536`) still merges `fromUrl` into
  the form (with the secret cleared, `:521`) — display only.

### 5. `ErrorBlock` gating and disclosure

- **Information disclosure to a wrong-key holder: no scenario found.** The `'set'` variant (`ErrorBlock.jsx:79`,
  `:135-146`) renders `basePrefix` — the value the *viewer* typed into their own form — not anything the provider
  said. All three hint variants are static text keyed on the error the viewer's own signed request produced; no
  probe is issued to confirm that a floor exists (the diagnostics diff adds a verdict string only; the two `HEAD
  no-cors` probes are unchanged). The only party who can learn "prefix X is in scope for key K" is the holder of K.
- **"Provider response details"** (`ErrorBlock.jsx:184-195`) still prints `{ code, status, requestId, message }`
  from `parseS3Error` (`format.js:45-52`) — no key material, no endpoint, no signed headers. Unchanged.
- **Gate width.** See F6 above and Finding S-4. `isPermissionError` (`format.js:54-58`) is used at `App.jsx:1693`
  only to *drop* the generic CORS guidance on a parsed 401/403 — correct direction.
- The `'unset-masked'` variant fires on *any* CORS-like error when no floor is set (`:77-78`, `isCorsLike` includes
  `status === null`), i.e. also on an offline network or an extension block. It is phrased as "two likely causes",
  and the pre-existing extension hint lives elsewhere. Misdirection risk only; noted for the UX lane.

### 6. `corsOnErrors` knob — test-only?

Yes. Defined and consumed only in `test/e2e/mock-s3/server.mjs` (`configure` at `:146`, `sendXml` at `:255-256`,
`reset` at `:137`); default `true`; three self-tests cover default / off / reset (`server.test.mjs`). Not referenced
from `src/`, `build.mjs` or the committed `dist/index.html` (grep: no hits). Cannot reach a production path.

### 7. Clipboard stub in `prefix-scope.test.mjs`

`addInitScript` redefines `navigator.clipboard` with an own property capturing `writeText` into `window.__copied`
(`test/e2e/browser/prefix-scope.test.mjs`, `pageWithClipboardStub`). Test-only, per-context; the recipient context
(`openAsRecipient`) is deliberately unstubbed. Nothing odd. One fidelity note for the record: the stub proves what
the app *tried* to copy, not that the real clipboard permission model allows it — fine for these specs, which
measure the link's content, and the existing "clipboard failures are swallowed" behaviour is unchanged.

### 8. Anything else

Covered by Findings S-2 (link-supplied floor persisted into a *saved record* by the #67 write) and the doc note in
Questions. Nothing to rotate.

---

## Findings (ordered by severity)

No Critical/High/Medium. The must-fix list from lane 30 is closed; what remains are three Low residuals on paths
adjacent to the fixed one, and one Low gap in hint gating.

### S-1 — Low · residual of F1 · plausible-unverified
**On the failed-connect screen, a same-document link merge keeps the secret in the form.**

*Actor → path → impact.* A user whose connect just failed (`session === 'failed'`, credentials state holds the
secret) follows or pastes a crafted `#endpoint=https://attacker.example&bucket=b` into the *same tab* (fragment-only
navigation → `hashchange`, no reload). `App.jsx:558-559` merges the link over `prev`, secret included. The form now
shows the attacker's endpoint with the victim's key ID and a filled (masked) secret field; the banner
(`App.jsx:1671-1673`) reads "Pre-filled from the link: endpoint, bucket — enter your Key ID and Secret Key to
connect", which is wrong twice (both are filled). One click on Connect signs a request to the attacker's host and
persists the link's endpoint/bucket via `saveCredentials`. Requires a user click and the failed state; the signature
is host-bound, so the secret itself does not leave — the impact is the same as lane 30's F1 residual after a click:
uploads to, or downloads from, a host the user did not choose.

*Smallest fix.* In `onHashChange`, mirror the mount branch: `setCredentials((prev) => ({ ...prev, ...fromUrl,
...(urlChangesConnection(fromUrl, prev) ? { secretKey: '' } : {}) }))` and the same for `liveFormData`. Optionally
make the banner's "enter your …" clause reflect whether the key ID field is actually empty.

### S-2 — Low · new with #67 · plausible-unverified
**A link-supplied Base folder can be written into a saved connection record by the recovery-persist path.**

*Actor → path → impact.* Recipient has a saved connection R (empty floor, full-bucket key) to bucket B and it is
their last-selected (`loadLastProfileId()` → `selectedConnectionId`). A colleague — or anyone — sends a link to the
same endpoint/bucket with `basePrefix=team/bob/`. Mount: `linkChangesConnection` is true (floor newly set), so the
form pre-fills with the banner naming "base folder team/bob/". The recipient types their secret and clicks Connect
(`CredentialForm` → `handleConnect`; nothing in that path clears `selectedConnectionId`). Browser lists at
`team/bob/`, succeeds, reports `list → permitted`; `handleCapabilityChange` (`App.jsx:279-286`) finds R selected
with an empty floor and the live floor set, and writes `team/bob/` into R with a toast "Base folder saved to R".
From now on R opens at `team/bob/` and clamps navigation there until the user edits the record.

*Why Low.* The direction is restriction-only (`discoveredFloor`, `base-prefix.js:54-57`, never overrides a stored
floor, so a link cannot *widen* a floor); the banner named the floor before the click and the toast names the write
after it; the record is user-editable. But it is still link-originated data persisted into a saved record by a click
whose purpose was "connect", not "edit my saved connection" — exactly the F3 class lane 30 asked to keep visible.
It is visible; it is not *chosen*.

*Smallest fix.* Gate the #67 write on the floor having come from the form rather than the link: skip it when
`readUrlParams().basePrefix` normalizes to the live floor (`normalizeBasePrefix(readUrlParams().basePrefix) ===
floor`), or set a ref in the failed→connect transition ("floor edited on the failed screen") and require it. Either
is a one-line condition next to `App.jsx:281`.

### S-3 — Low · design-accepted trade (D2) · demonstrated by code reading
**The session-scoped "Include my access key ID" modifier applies to the breadcrumb button with no visible state, across reloads, duplicated tabs and connection switches.**

*Actor → path → impact.* The user ticks the modifier in the header menu once (`ShareLinkMenu.jsx:45-48` →
`sessionStorage`). Later in the same tab (or a duplicated one, which clones `sessionStorage`), possibly after
quick-switching to another saved connection, they click the breadcrumb 🔗 (`Browser.jsx:1168-1171`, reads
`getIncludeKeyId()` at click time). The link on the clipboard carries *that* connection's key ID; the toast says so
(`connection-link.js:62`) — after the copy. A key ID is an identifier, not a secret, and the design chose session
persistence explicitly; the residual is "surprise", not "leak".

*Smallest fix.* Make the state visible at the second surface: when the modifier is on, append "(includes your key
ID)" to the breadcrumb button's `title`/`aria-label` (`Breadcrumb.jsx` `copyLinkButton`), or clear the modifier on
`switchToConnection`. Not blocking.

### S-4 — Low · gap vs. lane 30 F6 wording, matches the design's operative sentence · demonstrated by code reading
**The strong scope hint still fires on known non-scope 403 codes.**

`ErrorBlock.jsx:70-72` admits any 401/403 except `SignatureDoesNotMatch`/`InvalidAccessKeyId`. AWS returns 403 for
`RequestTimeTooSkewed`, `ExpiredToken`, `InvalidToken`, `AccountProblem`, `AllAccessDisabled`; on each, a user with no
floor set sees "**The most likely reason:** your access key is limited to one folder" and a "Set base folder"
button that cannot help. No disclosure, no request; time wasted and trust in the hint eroded. The design's own
paragraph (spec `:189-194`) first states "`AccessDenied`, or a 403/401 with no code" and then "inclusive for
everything except the two named codes" — the code implements the second. Until B2's codes are verified (Question 2),
the smallest safe narrowing is to extend `BAD_CREDENTIAL_CODES` with the clock/token/account codes above (they are
S3 convention and not credential-shaped, so the "plain message" line should not claim a wrong key either — use a
neutral "this is not a folder-scope problem").

---

## Questions for the operator

1. **S-2 intent:** is "a link may set the floor of my saved connection after I click Connect" acceptable behaviour,
   or should the #67 persist be limited to floors typed on the failed screen? (My recommendation: limit it.)
2. **B2 wire truth (carried over from lane 30 Q4):** which code and CORS shape does a real Name-Prefix key get on a
   root listing? Both the F6 gate and the `cors-blocked-or-scoped` verdict remain hypotheses until one live probe
   with a restricted key is recorded. The commits say so honestly ("harness cannot represent B2's real behaviour").
3. **README accuracy:** "A link into a folder the recipient's key cannot reach lands them at their own base folder
   with a note, never in an error" (`README.md` "Sharing links") is true for `prefix`, but a link that also carries
   the *sender's* `basePrefix` pre-fills that floor and, after the recipient connects, can end in the honest
   "Your Base folder is set to X, but the key was still denied there" error. Soften "never in an error" to cover
   that case, or say the link's base folder is applied as-is.
4. **History sync (lane 30 Q2, still open):** folder names now travel in copied links and in `#prefix=` history
   entries on both sides; if any in-scope bucket uses person-level folder names, the README note should say
   "browser history and history sync", not just "history".

---

## Verdict

**Ship-after-fixes: S-1 and S-2.** Both are one-condition changes on the paths the batch itself opened
(the `hashchange` merge beside the fixed mount merge; the #67 write beside the link-floor pre-fill), and both keep a
link-originated value from combining with the user's stored secret or saved record without a same-moment choice.
S-3 and S-4 are should-fix in the same arc, not blocking. The four must-fix items from lane 30 (F2, F4, F6-as-
designed, F1+F3) are implemented where the table above says, with browser-level evidence for F1/F3 and F2 and
node-level evidence here for the intake and emission rules. Nothing to rotate.
