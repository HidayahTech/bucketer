# Prefix access — folder share links and the prefix-restricted-key connect failure

**Date:** 2026-09-16 · **Status:** synthesized design, awaiting operator confirmation of the
run · **Blast radius:** T-tool · **Provenance:** three-lane expert panel convened by the EM
session on 2026-09-16 — architect (`docs/review-prefix-access/10-architect.md`), UI/UX
(`20-ux-review.md`), security (`30-security.md`) — on the shared facts brief
`docs/review-prefix-access/00-facts.md`. The raw lane files are preserved; this document
records the decisions and where the EM overrode a lane, with reasons.

## The operator's report

1. No way to share a link to a specific folder — neither from the listing nor from "Copy link".
2. A key limited to a prefix (Backblaze B2 Name Prefix) fails to connect with no explanation.

## What the panel established (verified, not inferred)

- **The failed-connect explanation exists but is never seen.** After a denied first listing
  the error block renders at `top ≈ 914px` in a 720px desktop viewport and `top ≈ 931px` in a
  727px Pixel 5 viewport, `scrollY` stays 0, and focus stays on `<body>`. The only visible
  change is the header pill turning to "Failed". Measured by the UX lane and re-measured
  independently by the EM (`.claude-scratch/prefix-access/verify-offscreen.mjs`, chromium,
  committed bundle). This reproduces on the readable-403 shape the mock models, so it explains
  the report without needing B2's wire shape. The 2026-08-13 design declined a focus-jump with
  "reconsider if users miss it"; that clause has fired.
- **On the CORS-masked shape the product gives a confident wrong answer.** If the provider's
  denial reaches the browser without CORS headers, the error is "Failed to fetch"; the
  Base-folder sentence is the un-emphasised tail of the CORS paragraph, and "Run diagnostics"
  returns five green ticks and, in bold, "almost certainly missing or incorrect CORS
  configuration". Reproduced by the UX lane by aborting only the list request. Whether B2
  sends this shape is unknown (see Research gaps).
- **A recovered Base folder never reaches the saved connection.** `saveConnectionRecord` is
  called only from the explicit Save action and the (gated-off) vault-offer path, so a Base
  folder typed on the failed screen persists only to the flat last-connected mirror.
  Quick-switch and the sidebar re-resolve the record, whose floor is still empty, and fail
  again. Verified by the EM by code reading (App.jsx `saveConnectionRecord` call sites);
  QA reproduces it in the harness before it is fixed.
- **"Copy link" from inside a folder drops the folder.** Clipboard read from
  `clients/acme/sub/`: `#endpoint=…&bucket=…&provider=…&region=…&basePrefix=clients%2Facme%2F`,
  while the address bar reads `#prefix=clients%2Facme%2Fsub%2F`. The reader side of a folder
  link (`#prefix=`, first-mount restore, floor clamp) shipped in v1.14.4 / v1.50.0; only the
  writer is missing.
- **`prefix` is the one navigation param read raw.** Three Browser read sites clamp with
  `startsWith` and never normalize or validate; `clampToFloor('clients/acme', '')` passes a
  slash-less value, `../`, `a\b/` and 5001-char strings. Downstream, New folder composes
  `prefix + name + '/'`, so a crafted link makes "Reports" land at `clients/acmeReports/`.
  Demonstrated at unit level by the security lane. Uploads are safe (they append `/`).
- **A share link opened in a tab that still holds a secret auto-connects to the link's
  endpoint with that secret** (mount-time merge spreads URL params over stored credentials and
  calls `handleConnect` when all four fields are present). Pre-existing, Medium, plausible-
  unverified in a browser; folder links multiply the links in circulation. Security lane F1.

## Decisions

### D1 — A folder link is the existing connection share link plus `prefix` (all three lanes)

Same family, same hash, same recipient contract: the recipient brings their own key and
lands in the folder. There is no third link type. A folder cannot be presigned, so the
credential-bearing per-file links (`CopyLinkPopover`, `#dl=`) stay a disjoint family and
never carry a folder. The floor still clamps on open with the existing notice, so a stale
folder link degrades to "you landed at your floor", never to a 403.

**Hash contract after this batch** (architect §3.1, adopted verbatim in substance):

| Param | Owner | Written by | Read by | Rule |
|---|---|---|---|---|
| `dl` | presigned route | `buildShareLink` | `main.jsx` | exclusive; no builder combines it with the others |
| `endpoint` `bucket` `provider` `region` `keyId` `basePrefix` | connection | `buildShareUrl` | `readUrlParams`, `hasUrlParams` | unchanged |
| `prefix` | navigation | `pushPrefixHistory` **+ `buildShareUrl` (new)** | Browser first mount only, through one validated read (D5) | `basePrefix` outranks it (clamp + notice); **not** consumed by `readUrlParams`, **not** in `hasUrlParams` — a bare `#prefix=` never triggers the pre-filled banner (existing invariants in `url-params.test.js` stay) |

**Emission rule:** `buildShareUrl(credentials, { includeKeyId, prefix })` sets `prefix` only
when it is non-empty **and differs from the connection's floor**. A link copied at the root
of an unscoped connection, or at the floor of a scoped one, is byte-identical to v1.62.3
output (back-compat anchor, extends invariant 4 of the 2026-08-13 record). Migration order:
none — the reader shipped before the writer; old links behave exactly as today.

Folder links are built from `credentials` + normalized `currentPrefix` via `buildShareUrl`,
**never from the address bar** (which preserves the opt-in `keyId` across navigation and
would leak it silently — security F4).

### D2 — Labelled choice, defaulted by position (EM sides with the UX lane over the architect)

The architect proposed carrying the folder automatically with a caption. The EM adopts the UX
lane's labelled choice: a user copying a link from deep inside a private subfolder would not
expect the path to travel silently (least surprise), the security lane independently requires
the labels to change anyway ("Connection only (no credentials)" cannot remain the label of a
link that names a folder), and naming the folder in the label is what makes the payload
visible before the click. The cost the architect feared (a doubled menu) is avoided by making
the key-ID variant a modifier instead of a rival item.

**Header menu** (`ShareLinkMenu`), folder item first and only when `currentPrefix` is set and
differs from the floor; at the floor the first item is omitted, not disabled:

```
Open in Bucketer — this folder (…/acme/sub/)
Open in Bucketer — top of this bucket
☐ Include my access key ID
The recipient needs their own secret key. It is never included.
```

The folder label is shown relative to the floor, truncated from the left beyond ~28 chars,
full value in `title`. "Include my access key ID" is a checkbox modifier of either item
(session-persistent checked state), disabled with the existing title when the connection has
no key ID. For a scoped connection the "top of this bucket" item reads "top of this
connection" (the floor is not the bucket top — same reasoning as the 2026-08-13 "Entire
scope" relabel).

**Toasts** name what travelled:

```
Link copied — opens at clients/acme/sub/
Link copied — opens at the top of test-bucket
```
with, when the key-ID modifier is on, a second line: `Includes your access key ID. The
recipient still needs the secret key.`

### D3 — A directory-level control lives on the breadcrumb, not on folder rows (EM decision)

The operator asked for directories to have a copy-link option. Both lanes reject a per-row
button: Pixel 5 folder rows already wrap and the ✕ is already displaced (UX F5, the
BUG-042 class), and a sign-in-required link one row from the per-file ⎘ presigned link is
the exact confusion point (security F4, architect Q1). The EM adopts the UX lane's
alternative: **one `🔗` button beside the breadcrumb** — a real `<button type="button">`
(the crumbs themselves are `<span onClick>`, UX F8), `aria-label="Copy a link to this
folder"`, `title="Copy a link that opens Bucketer in this folder"`, ≥32×32px, visible focus
ring, one click, no menu; it copies the folder link honouring the key-ID modifier's current
state and shows the first toast above. It is rendered only when `currentPrefix` differs from
the floor. A folder that is not the current one is linked by navigating into it (one click)
— the row's own click. The UX lane's further suggestion of a selection-bar "Copy link to
folder" item is **deferred** (L2): a third surface for the same link is not needed to meet the
ask, and it can be added later without redesign.

### D4 — The failed connect: scroll-and-focus, one hypothesis block with an action, an honest verdict, and a persisted floor

Four coordinated moves, all extensions of what exists.

**(i) Make the failure impossible to miss** (UX F1). On the transition to `session='failed'`
the error block is scrolled into view (`block: 'center'`) and receives focus (`tabIndex={-1}`
on the `role="alert"` container). One effect, no new markup. Serves sighted, keyboard and
screen-reader users; makes the mobile case work.

**(ii) One ranked hypothesis block with the fix in reach** (UX 2b, architect Q3(i)). The
scope hint becomes its own block directly under the message, before any CORS note, on both
wire shapes, with an inline **Set base folder** button that scrolls to and focuses
`#cred-baseprefix` ("in the form above" is a direction, not a control). The CORS note loses
its appended prefix sentence (dedupe). On the readable-403 shape the generic "if this looks
like a CORS error…" tail is removed — a parsed HTTP response proves CORS is fine (UX F7).
Two text variants, one block:

*Readable 403 / AccessDenied, no Base folder:*

```
Couldn't list this bucket — Access Denied

The most likely reason: your access key is limited to one folder inside the
bucket rather than the whole bucket. Backblaze B2 calls this the key's
"Name Prefix"; AWS calls it a prefix condition.

If that's your key, enter that folder as the Base folder and connect again.
    [ Set base folder ]

If your key isn't limited to a folder, then the key ID or secret key is wrong
for this bucket.
```

*CORS-masked "Failed to fetch", no Base folder:*

```
Couldn't reach this bucket — the browser blocked the response

The browser won't show us why, so there are two likely causes:

1. Your access key is limited to a folder inside the bucket (Backblaze B2
   calls this the key's "Name Prefix"). Some providers don't attach CORS
   headers to a denial, which hides it exactly like this. This is free to
   test: enter that folder and connect again.
       [ Set base folder ]

2. Your bucket's CORS rules don't allow this page. See the setup guide for
   your provider's exact command.
       [ S3-compatible setup guide ]

To see the real error, run the same request with curl or the AWS CLI —
those aren't subject to CORS.
```

*Set-but-denied* (a floor is set and the first listing is still denied — e.g. a recipient
whose link carried a different `basePrefix` than their key's): the same block says the
current Base folder is `F` and that a key limited to a different folder needs it corrected.

**Gating** (security F6, architect Q3): the block shows when `basePrefixUnset` and the error
is `AccessDenied`, or a 403/401 with no code, or CORS-like; it is **suppressed** on
`SignatureDoesNotMatch` / `InvalidAccessKeyId`, where the plain message is "the key ID or
secret key is wrong". These codes are S3 convention; B2's actual codes for a bad secret/key
ID are unverified (Research gaps) — until verified the gate stays inclusive for everything
except the two named codes. No new probes: the verdict derives from the error code of the one
listing already made; there is no request Bucketer can issue that separates "wrong
credentials" from "prefix-restricted" when the response is masked (architect Q3, honest
answer), and iterating prefixes with signed requests would be enumeration against the user's
own key that lands in provider audit logs (security F6).

**(iii) Honest diagnostics verdict** (UX 2c, architect Q3(ii)). `diagnosticsProps` carries
`basePrefixUnset`; when `!connected && basePrefixUnset` and every probe passes,
`runDiagnostics` returns a new verdict `cors-blocked-or-scoped` whose text names both causes
and points at each remedy — it must never read "almost certainly" while a free untested
hypothesis is on screen:

```
Your storage is reachable and its hostname resolves, so the endpoint and
bucket name look right. These checks can't tell a CORS block apart from a
denial your provider sent without CORS headers — so both causes above are
still open. Try the base folder first; it costs nothing.
```

Every other context keeps today's verdicts (`cors-blocked` once a floor is set;
`cors-blocked-transient` in-session). Correct under either outcome of the live probe.

**(iv) Persist a discovered floor** (architect §2.3). After the first successful listing at
the floor, if a saved connection is selected and its record's `basePrefix` is `''` while the
live floor is set, write that one field to the record (`saveConnectionRecord` supports partial
updates), refresh the sidebar, and toast `Base folder saved to <connection name>`. Never
before success; never over a non-empty stored floor (editing an existing floor stays with the
explicit Save flow, where floor is part of a connection's identity). Quick-switch failures
title the block with the bucket so a failed tab click does not read as a sign-out:
`Couldn't open test-bucket-b — Access Denied`. Whether a failed switch should preserve the
previous view instead of dropping to the splash is out of scope (flagged, not prescribed).

### D5 — Validated `prefix` intake (security F2, must-fix)

One read function for the navigation `prefix` (hash and history state), applying the
`basePrefix` rule: cap 1024, reject `\` and `..` segments, `normalizeBasePrefix` (so a
slash-less value becomes a folder), then `clampToFloor`. All three Browser read sites call
it. `region` gets the same whitespace/length guard as `keyId` (security F7, same file).

### D6 — No auto-connect on a link that changes the connection (security F1 + F3)

In the mount effect, auto-connect only when the URL-supplied values (endpoint, bucket,
keyId, basePrefix, region) equal the stored connection's; otherwise fall through to the
pre-filled form with the existing banner, which now enumerates what the link set, including
`Base folder: team/` when present. The legitimate "reload my share-link tab" path (values
equal) is untouched. **Session choice, flagged for the operator:** this is pre-existing and
adjacent to the ask; the security lane's verdict requires either fixing it in this batch or
saying explicitly that it is tracked separately. The EM includes it as the last item of the
batch (S2) because the fix is one comparison in one effect and the batch exists to put more
such links in circulation. The operator may drop it to its own issue.

## Research gaps — what only a live B2 probe can settle (item P1, operator action)

With a real Name-Prefix key, in Chromium with DevTools open, record for the root
ListObjectsV2: the HTTP status and `<Code>`; whether `Access-Control-Allow-Origin` is present
(decides readable vs masked shape for B2 users); B2's codes for a wrong secret and a wrong key
ID (the D4 gating hedge); whether a non-folder Name Prefix (`photos-2024`) accepts the
normalized `Prefix=photos-2024/`. Record the answers here and in the 2026-08-13 record's
"Unresolved" bullet. Not a blocker: every item above is correct under either outcome.

## Items (implementation order, each one issue + one commit + one bump)

Item labels: **E** = error-explanation fixes, **S** = security fixes, **L** = link feature,
**P** = probe. The raw lane files (`10-architect.md`, `40-qa-plan.md`) predate this scheme
and use B1→E1, B2→E2, B3→E3, B4→P1, A1→L1, A2→L2; "B2" there means the item, never
Backblaze, unless it says so. Renamed on operator instruction (2026-09-16) to avoid exactly
that ambiguity.

| # | Item | Bump | Observable (the one thing QA measures) |
|---|---|---|---|
| E1 | Failed connect: scroll-and-focus + first-class hint block with **Set base folder** action, both wire shapes, code gating, CORS-tail removal, quick-switch title | patch | after a scoped-mock denial with no Base folder, the error block is inside the viewport and focused; clicking **Set base folder** makes `#cred-baseprefix` the active element with its rect inside the viewport — desktop and Pixel 5 |
| E2 | Honest diagnostics verdict on the connect screen; mock gains `corsOnErrors:false` | patch | with `scopePrefix` + `corsOnErrors:false`, no Base folder: error is CORS-like, **Set base folder** present, Run diagnostics → verdict names both causes; `mock.requestLog` shows the root list reached the mock |
| E3 | Persist a discovered floor into the selected saved connection; toast | patch | after recovery, a **quick-switch tab click** back to the saved connection renders a row from inside the floor (presence) and no root list in `mock.requestLog` (absence). QA reproduced the loop live on 2026-09-16 (`40-qa-plan.md`): a same-tab reload already works via the flat mirror, so a reload-based spec would pass on pre-fix code — a proxy; the quick-switch path is the one that loops (error block reappears, `#cred-baseprefix` reverts to empty, one denied root list reaches the mock). Second-order: `handleConnect` calls `saveCredentials` on failure too, so one failed quick-switch also clobbers the flat mirror — the fix must not persist a failed connect's empty floor over a recovered one |
| S1 | Validated `prefix` intake at one read site; `region` guard | patch (security) | a link with `#prefix=clients/acme` lands in `clients/acme/` (normalized) and New folder → `Reports` PUTs `clients/acme/Reports/`; unit table for `\`, `..`, >1024 |
| L1 | Header menu carries the folder (labelled), key-ID modifier, breadcrumb 🔗 button, file-popover copy separating the families, README privacy note | minor | copy the folder item from `clients/acme/sub/`, open the URL in a fresh context, enter key ID + secret → a `file-row` from inside `sub/` renders and `mock.requestLog` has no empty-prefix list |
| S2 | No auto-connect on differing URL values; banner enumerates link-set fields | patch (security) | a secret-holding tab loaded with a hash naming a different endpoint shows the pre-filled form and issues **no** request to that endpoint (mock log absence beside the form's presence) |
| P1 | Live B2 probe runbook | none | operator records the four answers |
| L2 | Selection-bar "Copy link to folder" | deferred | — |

Every bug-fix item (E1–E3, S1, S2) carries matched-pair evidence on all three engines
(operator policy 2026-09-05); L1 carries not-inert evidence (new e2e case fails on
pre-feature main). Harness-fidelity statements: E1 "readable-403 shape only"; E2, mandatory
wording: "The mock's `corsOnErrors:false` models the hypothesis that a provider omits CORS
headers on error responses; it does not establish that Backblaze B2 does. No e2e coverage:
harness cannot represent B2's real denial/CORS behaviour." The mock also gains
`SignatureDoesNotMatch`/`InvalidAccessKeyId` so E1's negative (no hint on bad credentials) is
testable.

## Sideways verification (behaviours the batch could plausibly break)

- Existing share-link e2e cases (prefix-scope shared-link screen, profiles BUG-047) unchanged
  and green; `#dl=` route untouched; per-file presigned links untouched in behaviour.
- CORS note and Run diagnostics still render for CORS-like errors; `cors-blocked` and
  `cors-blocked-transient` unchanged in their contexts (all Browser callers pass
  `connected=true`).
- The in-session `!canList` block is unchanged.
- `handleSaveProfile`'s same-bucket-different-floor distinctness is unaffected (E3 writes
  only empty-floor records, partial update).
- Byte-identical links at root/floor (L1 back-compat anchor).
- Reload-auto-reconnect of a share-link tab with matching values still works (S2).

## Declined scope

- **Per-row folder copy-link button** — mobile reflow (BUG-042 class) and placement
  confusion beside the presigned ⎘; reopen only on a UX finding against navigate-then-copy,
  and then as the same `ShareLinkMenu` builder, labelled sign-in-required, never the ⎘ glyph.
- **Selection-bar folder link (L2)** — deferred, not rejected.
- **Pre-connect probe** — cannot distinguish the causes; adds a billed request per connect.
- **Provider-gated wording** — IAM `s3:prefix` keys fail identically; copy stays
  provider-agnostic and names B2's term.
- **B2 Name Prefix auto-detection** — declined 2026-08-13 (CORS-blocked), not reopened.
- **Preserving the previous view on a failed quick-switch** — flagged for a later design.

## Records relied on or superseded

- `2026-08-13-prefix-scoped-keys-design.md` — relied on for the floor model and hash param
  split; its declined "Focus-jump button in ErrorBlock" is **superseded** under its own
  reconsider clause; its "Unresolved" CORS-on-403 bullet is answered by P1.
- `2026-07-10-copy-link-with-key-id-design.md` — relied on for the key-ID opt-in property;
  the menu shape changes (modifier instead of rival item) but the property holds.
- `2026-07-26-connection-diagnostics-design.md` — the all-probes-pass inference is qualified
  for the no-floor connect screen, as #52 qualified it for connected sessions.
- BUG-042, BUG-047, BUG-058 — constraints honoured.
- Stale header comment at `App.jsx:7-10` ("probe in flight") — corrected in E1's commit.
