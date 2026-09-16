# Prefix access — shared facts brief for the design panel

**Date:** 2026-09-16 · **Prepared by:** the EM session (autonomous-run planning, Branch 1) ·
**Consumers:** every panel lane (architect, ux-review, security, qa-verify). Lane files land
beside this one as `NN-<lane>.md`; the EM synthesizes them into
`docs/superpowers/specs/2026-09-16-prefix-access-design.md`.

Everything below was read from the tree at `main` @ `0b24aea` (v1.62.3) on 2026-09-16.
Line numbers are from that commit. Treat this as the input contract; do not re-derive it,
but do verify anything you build a finding on.

## The operator's report (verbatim intent)

> There are two shades to it, both related to a similar aspect: access to "paths" or prefixes.
>
> 1. There's no way to share a link to a specific path that I can tell. Neither from the
>    directory listing nor from the "Copy link". I would think "Copy link" should include a
>    path attribute if you're not at the root and the directories should also have a "copy
>    link" option, but this may differ from how files are copied. I leave it to you to figure
>    out the best most user-friendly way for this to work.
> 2. When an application key is limited to accessing a prefix, login fails without any
>    explanation or reason why.

The operator uses Backblaze B2 primarily (application keys with a **Name Prefix**).

## What exists today

### Two unrelated "link" mechanisms

| Mechanism | Where | What the link carries | Recipient needs |
|---|---|---|---|
| **Connection share link** | header **Copy link** menu (`src/components/ShareLinkMenu.jsx`, rendered at `src/components/App.jsx:1542`), built by `buildShareUrl` in `src/lib/url-params.js:60-72` | hash params `endpoint`, `bucket`, `provider`, `region`, `basePrefix` (when set), optional `keyId` | their own secret key (and key ID unless included) |
| **Object share link** | per-file row → `src/components/CopyLinkPopover.jsx` (Browser.jsx:1120, 1243, 1627) | either raw presigned GET URLs (one per file, 1h/1d/7d/custom ≤7d), or a "Share via Bucketer" `#dl=<base64url presigned URL>` link (`src/lib/share-url.js`) | nothing — the presigned URL is the credential |

Folder rows have **no copy-link action** (Browser.jsx:1441-1470: download ⤓, rename ✎, move, delete).

### The current-folder hash param already exists, but no link builder includes it

- Navigating writes `#prefix=<current folder>` into the address bar via `pushPrefixHistory`
  (`src/lib/url-params.js:76-90`), preserving other hash params. Observed in the harness:
  inside `clients/acme/sub/` the address bar reads `#prefix=clients%2Facme%2Fsub%2F` and
  **nothing else** (no endpoint/bucket — those are only present if the page was opened from a
  share link). So the address bar is a deep link only for someone who already has stored
  credentials on the same origin.
- On the very first Browser mount of a page session, `#prefix=` is restored and clamped to
  the floor (`src/components/Browser.jsx:67-83`; App's `firstBrowserMountRef`, BUG-058).
  Out-of-floor prefix → clamped to floor with a visible notice.
- `buildShareUrl` **does not** read the current prefix — the header "Copy link" from inside a
  subfolder yields a link that opens at the root (or the base folder). `App` holds the current
  folder as `currentPrefix` state (`App.jsx:194`, updated via `onUploadTargetChange`,
  `App.jsx:1814`), so the value is available to the header menu.
- Hash param names: `prefix` = navigation state (current folder); `basePrefix` = the
  connection's floor (a credential property). Both may coexist (prefix-scoped keys design,
  2026-08-13, "Share links" section).

Existing tests: `test/url-params.test.js`, `test/share-url.test.js`,
`test/components/share-link-menu.test.jsx`, `test/base-prefix.test.js`, e2e
`test/e2e/browser/prefix-scope.test.mjs` (in-floor deep link, out-of-floor clamp, share link
with basePrefix), `profiles.test.mjs`.

Prior design records: `docs/superpowers/specs/2026-07-10-copy-link-with-key-id-design.md`
(why the header menu has two variants; key ID is opt-in because it lands in the recipient's
history), `docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md` (Base folder,
floor clamp, declined scope: B2 auto-detect is CORS-blocked at api.backblazeb2.com),
`docs/design-encrypted-share-links.md` (an older, unshipped idea).

### The prefix-scoped-key connect failure — what the code does

1. `handleConnect` (`App.jsx:311-364`) does **not** probe. It builds the client, sets
   `session='connected'`, mounts Browser. The header comment at App.jsx:7-10 describing a
   "ListObjectsV2 probe in flight" is stale.
2. Browser's first listing (`fetchPage`, Browser.jsx:351-412) at `clampToFloor('', basePrefix)`
   fails → `onInitialListFailed(err)` → App sets `session='failed'`, `connectionError=err`
   (App.jsx:1810-1813).
3. The failed splash renders the form plus `ErrorBlock` with `basePrefixUnset={!credentials.basePrefix}`
   (App.jsx:1627-1636). `ErrorBlock` (`src/components/ErrorBlock.jsx:21-66`) shows the
   **Base folder hint** when `basePrefixUnset && (code==='AccessDenied' || status 403/401)`;
   when the error is CORS-like (no status, or message mentions fetch/network) it shows the CORS
   note instead, with one appended sentence about prefix-restricted keys, plus a **Run
   diagnostics** button whose all-probes-pass verdict is `cors-blocked` ("almost certainly
   missing or incorrect CORS configuration") — see `src/lib/connection-diagnostics.js`.
4. Capability `list` becomes `denied` only for a readable 403/401/AccessDenied
   (`isPermissionError`, `src/lib/format.js:52-56`); a CORS-masked TypeError leaves it
   `unknown`.

**Screen truth in the e2e mock** (scoped key, no Base folder, chromium, committed bundle,
2026-09-16): the failed screen shows "Connection failed / Access Denied / Note: … set **Base
folder** in the form above …". Screenshots:
`/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/shots/fail-no-basefolder-desktop-1-after-connect.png`
and `…-mobile-1-after-connect.png` (Pixel 5). The error block sits directly below the
Connect button, i.e. below a ~9-field form; the Base folder field is the third field, well
above the fold on desktop, roughly 400px above the error on mobile. Capture script:
`.claude-scratch/prefix-access/screenshots.mjs`. (The harness served a stale `perf/index.html`
labelled v1.62.2; the surfaces involved are unchanged in v1.62.3.)

**So the mock does explain the failure.** The operator's "no explanation" therefore comes
from a path the mock does not model. Candidates, in the EM's order of likelihood:

- **(a) B2's real denial is not CORS-readable in the browser.** The 2026-08-13 design flagged
  this as unresolved ("whether a real B2/AWS 403 on a denied request carries CORS headers").
  If B2 omits `Access-Control-Allow-Origin` on the 403/401, the SDK surfaces a bare
  `TypeError: Failed to fetch`; the user sees "Failed to fetch", a CORS note, and — if they
  click Run diagnostics — a confident **wrong** verdict blaming CORS. The Base-folder sentence
  is present but buried at the end of the CORS paragraph. The mock's `sendError` always adds
  CORS headers, so this is exactly the shape the harness cannot represent. B2's CORS doc lists
  S3 `allowedOperations` as Delete/Get/Head/Put Object only and says nothing about error
  responses (fetched 2026-09-16, https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules).
- **(b) A different entry path.** Quick-switch tabs / sidebar `switchToConnection`
  (App.jsx:1306-1321) call `handleConnect(creds, { reconnect: session === 'connected' })` —
  the same initial-list failure path applies, but the user's mental model is "I clicked a
  bucket tab" rather than "I logged in".
- **(c) Discoverability.** The hint is a red paragraph among three; the field it names is off
  screen on mobile; there is no focus-jump (declined in the 2026-08-13 design: "the form sits
  directly above the error … reconsider if users miss it"). The operator has now missed it.
- **(d) A non-folder Name Prefix.** B2's namePrefix is an arbitrary string prefix
  (`photos-2024`), not necessarily a folder; `normalizeBasePrefix` appends `/`
  (`src/lib/base-prefix.js:14-20`), so `photos-2024` becomes `photos-2024/`, which B2 accepts
  (more restrictive) but which hides sibling keys like `photos-2024-raw/…`. Edge, noted for
  completeness.

B2 semantics (official doc, fetched 2026-09-16,
https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys): "For app keys that are
restricted to a file name prefix, you must include a matching prefix in the list request. You
can supply the same prefix as in the app key, or a more restrictive prefix." The doc does
**not** state the HTTP status or error code for a non-matching list. **No live probe with a
real prefix-restricted key has been run**; the EM has no such key. A design must be robust
to both readable-403 and CORS-masked shapes, and must say which it verified.

## Constraints every lane must honor

- Single self-contained `dist/index.html` (Preact + esbuild); no new dependencies without a
  case; no backend, no proxy (client-side-only architecture is a product pillar).
- All link state lives in the **hash fragment** (never the query string) so it never reaches
  a server (REQ-5). Secret keys are never in any link. Key ID is opt-in.
- Prefix contract everywhere: `''` = root/unscoped; non-empty prefixes end in `/`.
- The floor (`basePrefix`) is a credential property; `prefix` is navigation state. Out-of-floor
  prefixes clamp with a visible notice; never attempt-and-403.
- E2E evidence rules (`CLAUDE.md` § Tests): one user-observable per feature, absence only next
  to presence, matched-pair fails-before/passes-after on all three engines for bug fixes
  (operator policy 2026-09-05), full container 3×3 matrix for UI changes. Harness-fidelity
  statements are mandatory where the mock cannot represent the environment (here: B2's real
  denial/CORS shape).
- Mobile (≤640px) row actions must stay reachable (#49 / BUG-042 class); a new per-row button
  is a reflow risk.
- Versioning: minor bump for features, patch for fixes; CHANGELOG top entry ⇄ package.json.
- Blast radius tier T-tool (repo `CLAUDE.md`).

## Questions the panel must answer (the EM's synthesis needs a position on each)

1. What is the right user-facing model for "a link to this folder"? Same hash-param family as
   the connection share link (recipient authenticates), a per-folder row action, the header
   menu carrying the current folder, both, or something else? How does it relate to, and stay
   distinguishable from, the credential-bearing per-file presigned links?
2. Which link variants should include the current folder, and should that be automatic
   (always when not at root) or a labelled choice?
3. How should the failed-connect screen explain a prefix-restricted key so that it cannot be
   missed, on both wire shapes (readable 403 vs CORS-masked TypeError), on mobile, and from
   the quick-switch path — without misleading a user whose credentials really are wrong or
   whose CORS really is broken?
4. What is the smallest change set, and what is its verification: observables, specs, the
   harness-fidelity statement, and what only a live B2 probe can settle?
