# Copy link with access key ID — Design

**Date:** 2026-07-10
**Target version:** v1.36.0 (minor — new feature, backwards-compatible)
**Status:** Approved (brainstorming) — pending implementation plan

## Motivation

Bucketer already offers a **connection-share link**: the header "Copy link" button
(shown when connected) copies a URL whose hash fragment carries `endpoint`, `bucket`,
`provider`, and `region` — but deliberately no credentials. A recipient opens it and the
connect form is pre-filled except for the access key ID and secret key.

We want a second variant that also embeds the **access key ID**, so the recipient only
needs to type the **secret key** to connect. This makes handing off bucket access to a
collaborator a one-field operation on their end.

## Scope

This extends the existing connection-share mechanism only:
- `src/lib/url-params.js` (`buildShareUrl`, `readUrlParams`, `hasUrlParams`)
- the header "Copy link" control in `src/components/App.jsx`
- a small auto-focus touch in `src/components/App.jsx` / `src/components/CredentialForm.jsx`

**Out of scope:** the presigned object-download links (`CopyLinkPopover`, `share-url.js`)
are unrelated and untouched. The secret key is never included in any link.

## Decisions (resolved during brainstorming, 2026-07-10)

1. **Two variants, not a replacement.** Keep the fully credential-free "connection only"
   link AND add an "include access key ID" link, chosen from a small menu under the
   existing "Copy link" button. The credential-free link remains available for public
   sharing.
2. **No sender-side confirmation.** Clicking "Include access key ID" copies immediately;
   the menu label and a distinct toast make the behavior explicit.
3. **Keep the recipient auto-focus.** When a shared link supplies a key ID but no secret,
   auto-focus the Secret Key field on load.

## Security properties

- **Secret key is structurally excluded.** `buildShareUrl` only ever reads
  `endpoint`, `bucket`, `provider`, `region`, and (optionally) `keyId`. The secret key
  field is never referenced, so it cannot be included by any code path.
- **Hash fragment, not query string.** All params live in the URL hash, which the browser
  strips before sending HTTP requests — never transmitted to any server. Unchanged from
  today.
- **Access key ID sensitivity.** The key ID is a semi-public identifier (it already appears
  in presigned URLs Bucketer generates) but reveals *which* credential/account and lands in
  the recipient's browser history. This is why it is opt-in (a separate menu item), while
  the default remains the credential-free link.
- **Read-side validation.** `readUrlParams` validates the `keyId` param so a crafted link
  cannot inject free text into the form (mirrors the existing `provider`/`bucket` guards).

## Component design

### 1. `src/lib/url-params.js`

**`buildShareUrl(credentials, { includeKeyId = false } = {})`**
- New optional second argument. When `includeKeyId` is `true` **and** `credentials.keyId`
  is truthy, set `keyId` on the hash params.
- Default call (`buildShareUrl(credentials)`) produces byte-for-byte the current
  config-only link. No behavior change for existing callers.

**`readUrlParams()`**
- Add `keyId`: read `p.get('keyId')`; accept only when non-empty, contains no whitespace,
  and length ≤ 128. On acceptance, set `out.keyId`.
- The returned object is already spread **last** over stored/profile credentials in
  `App.jsx` (line ~75), so a shared `keyId` correctly pre-fills and overrides any stored
  key ID with no additional merge logic.

**`hasUrlParams()`**
- Add `keyId` to the recognized-keys list so a link carrying only `keyId` still counts as
  "params present".

### 2. Header UI — `src/components/App.jsx`

- Replace the single "Copy link" button with a small popover menu (lightweight, consistent
  with the existing `.copy-link-popover` pattern) containing two items:
  - **Connection only (no credentials)** → `buildShareUrl(credentials)`; toast:
    *"Share link copied to clipboard."* (unchanged wording).
  - **Include access key ID** → `buildShareUrl(credentials, { includeKeyId: true })`; toast:
    *"Link with access key ID copied — recipient still needs the secret key."*
    - Disabled when `credentials.keyId` is empty.
    - A subtle caption notes the secret key is not included.
- The menu is only rendered when `session === 'connected'` and `buildShareUrl(credentials)`
  is non-null (same guard as today).

### 3. Recipient auto-focus — `App.jsx` / `CredentialForm.jsx`

- On initial load, when the URL params supplied a `keyId` but no secret key is present,
  auto-focus the Secret Key input (`id="cred-secretkey"`).
- Implementation detail (to settle in the plan): either a prop passed to `CredentialForm`
  signalling "focus secret on mount", or a focus effect keyed on the pre-filled-keyId /
  empty-secret condition. Must not steal focus in the normal (non-shared-link) flow.

## Data flow

**Sender:** connected form/credentials → click "Include access key ID" →
`buildShareUrl(creds, { includeKeyId: true })` → clipboard → toast.

**Recipient:** open link → `readUrlParams()` extracts endpoint/bucket/provider/region/keyId
→ spread over stored creds → form pre-filled, secret empty → Secret Key auto-focused →
user types secret → connect.

## Error / edge handling

- `file://` origin: `buildShareUrl` returns `null` (unchanged); the menu is not shown.
- No `keyId` set on the connection: "Include access key ID" item disabled.
- Malformed/oversized `keyId` in an incoming link: rejected by `readUrlParams` validation;
  the field is simply left to whatever stored value exists (or empty).
- Clipboard API unavailable: same silent-catch behavior as the existing handler.

## Testing

**`test/url-params.test.js` (unit):**
- `keyId` round-trips: `buildShareUrl(creds, { includeKeyId: true })` → `readUrlParams()`
  returns the same `keyId`.
- Config-only (`buildShareUrl(creds)`) contains no `keyId`.
- Neither variant ever contains the secret key.
- `keyId` validation: whitespace-containing and overlong (>128) values are rejected.
- `hasUrlParams()` returns true for a link carrying only `keyId`.

**`test/components/` (jsdom):**
- Header menu renders both items.
- "Include access key ID" is disabled when `credentials.keyId` is empty.
- Correct toast wording fires for each item (or the correct `buildShareUrl` call is made).
- Auto-focus: with a pre-filled key ID and empty secret, the Secret Key field receives
  focus on mount; with no shared keyId, it does not.

**No build-invariant changes.**

## Versioning

- Minor bump to **v1.36.0**.
- `CHANGELOG.md` top entry: `## [1.36.0] — <date> — Copy link: include access key ID`.
- Update `package.json` version in the same commit (build enforces changelog/version match).
- No `BUG-LOG.md` entry (feature, not a bug fix).
