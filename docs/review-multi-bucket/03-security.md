# Multi-Bucket + Account-Management Redesign — Security & Privacy Lane

**Reviewer:** Security/Privacy panel lane (03)
**Scope:** secret persistence + the four server-blindness pillars, under the fixed
"Both" account-management decision.
**Repo state:** v1.55.0, `main`. Design/spec only — no source modified.
**Method:** read of vault/connection/storage/url/share/move code + the vault design
docs, handoff, and App.jsx wiring; defects confirmed against source, marked
*verified* vs *hypothesis*.

Grounding pillars taken as fixed constraints, not things to redesign: (1) single
served HTML artifact; (2) server-blindness — secret key leaves the browser only as a
SigV4 signature over TLS to the storage endpoint, share config lives in `#hash`, no
relay/short-link; (3) no backend/admin; (4) `file://` support with no secure-context
guarantee.

---

## 1. Current vault design — how it works, what the flag gates, the two defects

### 1.1 Crypto core (sound)

`src/lib/vault.js` is a passphrase → key → wrapped-secret store, all client-side:

- **KDF:** PBKDF2-SHA256, **600,000** iterations (`vault.js:52`), 16-byte random salt
  (`vault.js:55,71`), deriving a 256-bit AES-GCM key (`deriveVaultKey`, `vault.js:77-92`).
- **Wrap/unwrap:** AES-GCM with a fresh 12-byte IV per call (`wrapSecret`, `vault.js:96-100`);
  the auth tag is left to reject on wrong key/tamper (`unwrapSecret`, `vault.js:105-108`).
- **Record:** one `localStorage` blob `s3b_vault` = `{version, salt, iterations, check, entries{credId→{iv,ct}}}`
  (`vault.js:110, 245-259`). Secrets are keyed by **credential id**, so connections
  sharing a credential share one ciphertext (matches the bipartite model).
- **`check` value:** a known plaintext (`CHECK_PLAINTEXT`, `vault.js:53`) wrapped at
  creation so `unlockVault` can verify a passphrase even with zero entries
  (`vault.js:284-290`).
- **Persist-verified writes:** `saveVaultRecord` reads back the value to defeat private-mode
  silent-swallow (`vault.js:142-146`) — good discipline.

The crypto is not where the risk is. The **session-key handling** is:

> **The derived AES key is exported *raw* (`exportKey('raw', …)`) and parked in
> `sessionStorage` under `s3b_vault_key`** (`vault.js:200-215, SS_KEY_VAULT_KEY`),
> re-imported on every read (`vault.js:219-223`).

This is a *deliberate* trade-off, documented in the module header (`vault.js:12-18`):
extractable-by-design so a page reload doesn't re-prompt. Its consequence is the
central threat-model fact for §2: **any script that can read `sessionStorage` in this
origin recovers the raw vault key and, through it, every wrapped secret.** The vault
protects secrets *at rest between sessions*; it does nothing against XSS or a hostile
page. Hold that line; do not let account-management UX quietly erode it.

### 1.2 What `VAULT_ENABLED` gates

`export const VAULT_ENABLED = false` (`vault.js:49`). The crypto + record layers stay
live and unit-tested; the flag gates every **user-reachable entry point** in `App.jsx`:

- initial `locked` session state — `App.jsx:127` (`VAULT_ENABLED && vaultExists() && !isUnlocked()`);
- the post-connect offer — `App.jsx:264`;
- auto-recall of a stored secret — `recallSecret` guarded at `App.jsx:281`.

So on `main` today the vault code ships in the bundle but is inert. Reviving it for
account management means flipping this flag — which re-arms the two defects below
unless they are fixed first.

### 1.3 The two accept-flow defects — **both VERIFIED against source**

Source-of-truth: `docs/superpowers/HANDOFF-2026-07-28-vault-phase2.md` (C1/C2) and the
DRAFT redesign `docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md`. I
confirmed both against the live code rather than trusting the docs.

**C1 — a passphrase typo/loss locks the user out of the entire app (VERIFIED).**
- `session === 'locked'` renders `VaultUnlock` *instead of* the connect form:
  `App.jsx:1265-1270` (`{session === 'locked' ? … <VaultUnlock …/> …}`).
- `VaultUnlock` offers the destructive reset **only** for `error === 'corrupt'`
  (`VaultUnlock.jsx:122`).
- But `unlockVault` maps a wrong/typo passphrase (an AES-GCM `OperationError`) to
  `'wrong-passphrase'`, never `'corrupt'` (`vault.js:287-290`) — correctly, so a typo
  can't nuke real secrets.
- **Net:** a user who mistypes or forgets the passphrase sees "Wrong passphrase," has
  **no reset button**, and the connect form is not reachable. The only escape is
  wipe-all-app-data. Actor → path → impact: *legitimate returning user → single typo
  at a lock screen with no escape hatch → total denial of service to their own
  buckets.* This is a fail-**closed**-too-hard availability bug, not a leak, but for a
  browser-only tool it is a data-loss-equivalent (they lose access to the app).

**C2 — accepting the offer after a key rotation wraps the secret under a credential no
connection points at → silent orphan, auto-connect never fires (VERIFIED).**
- `handleAcceptVaultOffer` (`App.jsx:309-366`) always derives `cred` from the **live**
  form values: `findOrCreateCredential({endpoint,keyId,provider,regionOverride})`
  (`App.jsx:335-340`).
- It only creates/points a connection when `existing` (the selected connection) is
  falsy (`App.jsx:341-354`). When a connection **is** selected, that branch is skipped
  — the connection's `credentialId` is never updated.
- It then wraps the secret under `cred.id` (`App.jsx:360`, `rememberSecret(cred.id, …)`).
- **If the user edited their key before connecting**, the live `keyId` differs from the
  selected connection's stored credential, so `findOrCreateCredential` mints a *new*
  credential id. The secret is stored under the new id; the connection still references
  the old one. On next launch `recallSecret(conn.credentialId)` (`App.jsx:284`) looks
  up the **old** id → `null` → auto-connect never fires, and a wrapped secret sits
  under a credential nothing references. Actor → path → impact: *user rotates a key,
  says "remember it" → secret persisted under an unreachable credential → returning-user
  login silently broken + an orphaned encrypted secret with no UI to remove it.*

### 1.4 The unapproved redesign draft (located + summarized)

`docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md` — **DRAFT, presented,
NOT approved.** Its shipped-as-code twin is commit `78b5e40` on branch `vault-phase2`
(never merged); the merged-but-gated wiring is what lives on `main`. Key moves:

- **Offer scope shrinks to "only remember, never create"** (operator-locked). The offer
  wraps the secret for the *already-selected* connection and nothing else; actionable
  only when a connection is selected **and** live credentials match it by the existing
  `credentialFingerprint` (`connections.js:216-226`). This kills C2 *by construction* —
  the flow can never wrap under a credential no connection references.
- **Lock-screen escape hatch** "Connect manually instead" (operator-locked) → kills C1.
- **Offer appears on `capabilities.list === 'permitted'`** (a real "these creds work"
  signal), not on `createS3Client` returning — fixes an Important where the offer
  showed on a failed connection.
- **Suppress the sidebar `CredentialForm` while the passphrase form is open** — restores
  the "one `autocomplete=username` field live" invariant.
- Confirmation field + unrecoverable-passphrase warning; check `rememberSecret`'s
  boolean and don't persist dismissal on a failed write (the swallowed-`sessionStorage`
  case where `createVault` reports success but nothing can be stored).
- Explicitly **out of scope:** changing a passphrase; whether the offer reappears after
  dismissal.

The draft is coherent and closes both Criticals at the design level. It is the right
starting point for revival — but it was never approved, never planned into a revised
Task 6, and Task 7 (inspector + a **manual** password-manager matrix across Chrome,
Firefox, KeePassXC, Vaultwarden) was never done.

---

## 2. Vault-revival decision — threat model + required guardrails

**The account-management "Both" model makes revival close to mandatory.** Without
at-rest secrets, every account/bucket quick-switch tab re-demands a 40-char secret,
which guts the very UX the redesign exists to deliver (the parent design says so
outright: `docs/superpowers/specs/2026-07-26-login-vault-design.md` — "The vault is the
login"). Session-only status quo and account-management are in direct tension.

### Threat model for a browser-only, no-backend app

| Threat | Session-only (status quo) | Vault (revived) | Verdict |
|---|---|---|---|
| **XSS / malicious dependency in the page** | Reads `sessionStorage` secret *of the current tab only*, while unlocked | Reads the raw vault key from `sessionStorage` → **every** wrapped secret at once | Vault **widens** blast radius from one live secret to the whole credential set. This is the dominant new risk. |
| **Disk-at-rest / stolen laptop, tab closed** | Nothing on disk (secret was `sessionStorage`) | Ciphertext on disk; needs passphrase; 600k PBKDF2 makes offline brute-force costly | Vault **wins** — this is the threat it exists for. |
| **Shared/kiosk machine** | Secret dies on tab close | Ciphertext persists on that machine for the next user to attack offline | Vault **loses** unless the user is warned + given easy per-device reset. |
| **Passphrase strength** | N/A | Weak passphrase collapses the 600k-PBKDF2 margin; no server to rate-limit | Needs a strength floor + explicit "this cannot be recovered" copy. |
| **`file://` (no secure-context guarantee)** | Works (no crypto needed for secrets) | `window.crypto.subtle` may be absent/throw; `unlockVault` would mis-report absence as `'corrupt'` (`vault.js:281`) | Must probe `crypto.subtle` and degrade to session-only, not brick. |

**The core tension:** persistence (what account-management wants) and XSS blast-radius
(what a single-artifact page with third-party build deps must fear) pull opposite ways.
The vault's own header concedes it does not defend XSS. For a fleet whose sibling apps
handle children's data, note the *transferable-risk* framing: a bucketer XSS now leaks
**all** of a user's storage credentials, which may reach buckets holding that data.

### Guardrails/fixes REQUIRED before revival (ordered)

1. **Fix C1 and C2 first** (§1.3). Non-negotiable pre-conditions; the draft's design
   closes both. Re-arming the flag without them ships two known Criticals.
2. **Approve the draft and write the revised Task 6 + Task 7**; the manual
   password-manager matrix gates the release and was never run.
3. **Harden the single-artifact against XSS**, because the vault raises XSS from
   "one live secret" to "all secrets." Add a strict `Content-Security-Policy` (the
   bundle is self-contained — `script-src 'self' 'unsafe-inline'`-free is achievable
   with hashed inline, or at minimum no third-party origins), and treat any
   `dangerouslySetInnerHTML`/`{@html}`-equivalent as a release blocker. *(Out of this
   lane to audit fully — flag to the infra/frontend lanes; call it a pre-condition.)*
4. **Passphrase strength floor + unrecoverable warning shown before commit** (draft
   already specifies the warning; add a minimum-entropy check).
5. **`file://` capability probe:** detect missing/throwing `crypto.subtle` and fall
   back to session-only with a clear message, instead of `unlockVault` returning the
   destructive `'corrupt'` verdict (`vault.js:281`) that offers a data-wiping reset.
6. **Auto-lock / TTL option** for shared machines: re-lock after inactivity (clear
   `s3b_vault_key`), and an obvious per-device "forget this device" reset reachable
   *without* unlocking (the draft's Storage & Privacy home).
7. **Keep the key extractable-in-sessionStorage trade-off documented and visible in the
   UI**, not just in a code comment — the user is accepting XSS exposure of all
   secrets; that belongs in the pre-commit copy.

### Alternatives (weighed within the pillars)

- **Session-only (status quo):** smallest attack surface, worst account-management UX.
  Viable *only* if the "Both" model is scoped so switching within one already-unlocked
  session doesn't need re-entry (secrets held in memory for the tab's life across
  account tabs). Loses everything on tab close.
- **Per-tab (`sessionStorage` secret, no vault):** already the model. Multi-account
  quick-switch *within a tab* is feasible by holding several secrets in memory keyed by
  credential id — no disk, no new at-rest risk. This is the **cheapest partial win** and
  should be the fallback if vault revival stalls: it delivers in-session multi-account
  switching without reviving at-rest crypto at all.
- **WebAuthn / Credential Management API:** `navigator.credentials` `PasswordCredential`
  storage is non-standard/deprecated in practice and doesn't give you an encryption key.
  WebAuthn `prf` extension *could* derive a wrapping key from a passkey (replacing the
  passphrase, removing the "typo locks you out" class and the offline-brute-force risk).
  **But:** requires a secure context (breaks pillar 4 `file://`), platform/authenticator
  support is uneven, and it adds real complexity. Worth a spike as a *future* passphrase
  alternative, **not** a v1 dependency. Recommend: design the wrapping-key source as
  pluggable (passphrase now, PRF later) but ship passphrase.

---

## 3. Multi-account secret confusion — what stops A's secret hitting B's bucket

With several accounts persisted, the danger is running account A's credential against
account B's bucket (the classic "valid credential, wrong target" class).

**Precedent that already exists and works — apply it verbatim.** Resumable move jobs
are scoped to the **full origin**, not just the bucket name:

```
App.jsx:598-602
  if (j.bucket !== credentials.bucket
      || j.provider !== credentials.provider
      || j.endpoint !== credentials.endpoint) continue;
```
with the comment naming the risk exactly: *"a different provider/endpoint can reuse the
same bucket name, and resuming would run copy/delete against the wrong origin with the
current credentials (credential confusion)."* Move jobs record
`{provider, endpoint, bucket}` at creation (`move-queue.js:199`) precisely so this
filter can hold.

**Design requirement for account-management:** the vault already keys ciphertext by
**credential id** (`vault.js:152-166`), and a credential id is the fingerprint of
`{endpoint, keyId, provider, regionOverride}` (`connections.js:216-226,244-248`). So the
binding *secret ↔ credential ↔ (endpoint,provider,region)* is structurally sound today.
The confusion risk enters at the **switch boundary**, not in storage:

- **R1 (design finding, plausible):** when quick-switching accounts, the connect path
  must recall the secret via `recallSecret(conn.credentialId)` (`App.jsx:284`) and build
  the S3 client from **that connection's** endpoint/region — never from stale live form
  values or a previously-selected account's `credentials` object. C2 (§1.3) is exactly
  this class already realized once (live values vs selected connection diverging). The
  account switcher must re-derive the full `{endpoint, region, provider, bucket, secret}`
  tuple atomically from the target connection record, and **assert** the recalled
  secret's credential id equals the connection's `credentialId` before any request
  fires.
- **R2 (guardrail):** carry the move-jobs origin-match discipline into every persisted,
  replayable artifact that a multi-account UI can surface across accounts — download
  jobs, resumable uploads, master-queue rows. A job list rendered while account B is
  active must filter by B's full origin (App already does this for moves at
  `App.jsx:598-602` and for downloads via `listJobs`/`classifyJob`, `App.jsx:614-619`).
  New account-tab UI must not bypass that filter to show "all jobs."
- **R3 (naming ≠ authority):** the model deliberately has "no read-only mode" — the
  key's own IAM/permissions are the sole authority
  (`2026-07-26-login-vault-design.md`). Account-management UI must not imply a stored
  read-only/scope modifier gives protection; it does not. Don't invent trust the
  server-side ACL isn't providing.

**Bottom line:** the primitives to prevent multi-account confusion already exist
(credential-id keying + origin-match filter). The redesign must *use them at the switch
boundary* and never reconstruct a client from ambient/stale credential state — the C2
bug is the proof that this is a live, not theoretical, failure mode in this codebase.

---

## 4. Server-blindness under multi-bucket

Server-blindness holds today: `#hash` fragments are never sent to any server
(`url-params.js:5-11`, `share-url.js:5-10`), presigned share links live in `#dl=`
(`share-url.js:38-43`), and the secret leaves only as a SigV4 signature. Multi-bucket +
accounts introduces three surfaces to check:

- **ListBuckets discovery — does NOT exist in `src/`, keep it that way (VERIFIED).**
  No `ListBuckets` call anywhere in the source; the only hits are prose in
  `SetupGuide.jsx`. The parent design already ruled *"`ListBuckets` is a prefill, never
  a gate"* (`2026-07-26-login-vault-design.md`) because B2 keys are usually
  bucket-scoped. **Server-blindness note:** a bucket *switcher* that lists objects in
  the newly-selected bucket sends a normal signed `ListObjectsV2` directly to the
  storage endpoint over TLS — that is the same request the app already makes and leaks
  nothing new to any *third* party (there is no backend or relay to see it). If a future
  "discover my buckets" convenience is added, it is a `ListBuckets` call to the storage
  provider only — still no relay, still within the pillar — but it reveals the full
  bucket inventory to the app's in-memory state; keep it opt-in and never a gate.

- **keyId-in-share-URL trade-off (design-level, acceptable with current copy).**
  `buildShareUrl(creds, {includeKeyId:true})` puts the **access key ID** (not the
  secret) in `#hash` (`url-params.js:73-85`), surfaced as a distinct "Include access key
  ID" menu item with the warning *"recipient still needs the secret key"*
  (`ShareLinkMenu.jsx:35-37,54-62`). The key ID is a public-ish identifier (it travels in
  every SigV4 `Authorization` header anyway), and the `#hash` keeps it off the wire to
  the app's own host. **Residual exposure:** the key ID lands in the recipient's browser
  history, clipboard managers, and any chat app it's pasted into. That is inherent to
  "share a pre-filled link" and is honestly labeled. **Multi-account amplifier:** with
  many accounts, a quick "copy link" from the wrong active tab could share account A's
  key ID while the user thinks they're sharing B's. Design requirement: the share menu
  must show *which connection* it is sharing (name + bucket), so the active-account
  ambiguity that drives C2/R1 doesn't also mis-target a share link.

- **New leakage from tabs/quick-switch (design finding, plausible).**
  - `pushPrefixHistory` writes endpoint/bucket/provider/prefix into the URL hash for
    back-button support (`url-params.js:92-102`). With account tabs, switching accounts
    must not leave the *previous* account's endpoint/bucket sitting in the visible URL
    (shoulder-surf / screenshot leak). Decide explicitly whether each account tab owns
    its own hash state or whether switching rewrites it.
  - **Cross-tab secret reach:** `sessionStorage` is per-tab, but the vault key
    (`s3b_vault_key`) and all ciphertext (`s3b_vault`) are origin-scoped — every
    same-origin tab and any injected script shares them once unlocked. "Quick-switch
    tabs" that are real browser tabs each need their own unlock unless the design uses a
    single-tab in-app tab model. Nail this down; it changes the XSS blast radius wording
    in §2.

No server-side leak is introduced by multi-bucket itself — the architecture has no
server to leak *to*. The real multi-account risks are **client-side mis-targeting**
(wrong account's secret/keyId used or shared) and **XSS blast-radius amplification**, both
covered above.

---

## 5. Verdict

**REVIVE the vault — conditionally.** At-rest encrypted secrets are effectively required
to deliver the "Both" account-management UX; session-only cannot provide a returning-user
login, and the parent design already committed to "the vault is the login." The crypto
core is sound. But revival is **ship-after-fixes**, not ship-as-is, and the fixes are
concrete and already largely designed.

**Pre-conditions, ordered by severity:**

1. **[Critical] Fix C1** — lock-screen escape hatch so a passphrase typo/loss cannot
   deny access to the whole app (draft §"Lock-screen escape hatch"; `App.jsx:1265-1270`,
   `VaultUnlock.jsx:122`, `vault.js:287-290`).
2. **[Critical] Fix C2** — offer wraps the secret only under the selected connection's
   own credential, gated on `credentialFingerprint` match; never mint a new credential
   in the accept flow (draft §"What the offer does"; `App.jsx:335-360`).
3. **[Critical] Enforce switch-boundary credential binding (R1)** — the account switcher
   re-derives the full `{endpoint,region,provider,bucket,secret}` atomically from the
   target connection and asserts `recalledSecret.credentialId === conn.credentialId`
   before any request. Apply the move-jobs origin-match precedent (`App.jsx:598-602`) to
   every replayable artifact surfaced across accounts (R2).
4. **[High] Approve the draft, write revised Task 6 + Task 7, and run the manual
   password-manager matrix** (Chrome, Firefox, KeePassXC, Vaultwarden) — it gates the
   release and has never run.
5. **[High] CSP / XSS hardening of the single artifact** before flipping `VAULT_ENABLED`,
   because the vault raises XSS impact from one live secret to all stored secrets. (Refer
   to infra/frontend lanes; treat as a release blocker for revival.)
6. **[Medium] `file://` `crypto.subtle` probe → graceful session-only fallback**, not the
   destructive `'corrupt'` verdict (`vault.js:281`).
7. **[Medium] Shared-machine guardrails:** passphrase strength floor + pre-commit
   unrecoverable warning; optional inactivity auto-lock; a "forget this device" reset
   reachable without unlocking.
8. **[Low] Share-menu account labeling** so a wrong-tab "copy link" can't mis-target a
   key ID (§4).

**If revival stalls:** ship the **per-tab in-memory multi-account** fallback (§2) — hold
several secrets in memory keyed by credential id for the tab's life. It delivers
in-session account switching with **zero** new at-rest risk and no vault dependency, and
buys time to do the vault revival properly.

---

## RECOMMENDATION

Revive at-rest encrypted secret storage — it is required for the account-management UX
and the crypto core is sound — but **only after** the three Critical fixes land: C1
(lock-screen escape hatch, `App.jsx:1265-1270` / `VaultUnlock.jsx:122`), C2 (offer wraps
only under the selected connection's matched credential, `App.jsx:335-360`), and the
switch-boundary binding assertion that re-derives the full origin+secret atomically per
account and reuses the existing move-jobs `{provider,endpoint,bucket}` origin-match guard
(`App.jsx:598-602`) for every cross-account job list. Approve the existing DRAFT
(`docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md`) — it already closes
C1 and C2 by design — write the revised Task 6/Task 7, and run the manual
password-manager matrix that gates release. Treat CSP/XSS hardening of the single
artifact as a hard pre-condition, since the vault raises XSS blast radius from one live
secret to the entire credential set. Add a `file://` `crypto.subtle` probe with
session-only fallback and shared-machine guardrails (auto-lock, no-unlock reset,
passphrase floor). Server-blindness is not weakened by multi-bucket itself — there is no
backend or relay — so ListBuckets/bucket-switching leaks nothing to a third party; the
real multi-account risks are client-side mis-targeting (wrong account's secret or keyId)
and XSS amplification, both addressed above. If vault revival stalls, ship the per-tab
in-memory multi-account fallback as the zero-new-risk interim.
