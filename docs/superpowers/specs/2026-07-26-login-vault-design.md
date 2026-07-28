# Login, Vault, and the Connection Model — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorming sessions 2026-07-26)

## Problem

Connecting to Bucketer is a six-field configuration form — endpoint, bucket, key
ID, secret key, provider, region — and the secret key is re-entered **every
session**, because it lives in `sessionStorage` and dies with the tab
(`storage.js:48,80`). Profiles save everything except the secret; `saveProfile`
strips it deliberately (`storage.js:284`). So a "saved profile" still means
retyping a 40-character secret each time.

That is a setup wizard on repeat, not a login. The goal is for Bucketer to be
approachable by people who are not comfortable with S3 tooling, which means the
returning-user path must collapse to something recognisable: enter one secret,
see your buckets, click one.

Two structural problems block that:

1. **Secrets cannot survive a tab close**, so there is nothing to log *into*.
2. **A profile conflates credential and bucket** in one flat record
   (`storage.js:365-373`), so N buckets means N duplicated credentials, and the
   real-world case of *two keys for the same bucket* — a read-only key for safe
   browsing, a read-write key for changes — is expressible only as two unrelated
   records that duplicate almost everything.

## Decisions (from brainstorming)

- **The vault is the login.** Encrypting secrets at rest is not a convenience
  feature bolted on; it is the mechanism that makes a login screen possible.
- **The model is bipartite, not a tree.** A credential reaches many buckets; a
  bucket is reached by many credentials. The nameable, clickable unit is the
  *pairing*, which is what today's profile already is and what must survive.
- **`ListBuckets` is a prefill, never a gate.** It is commonly denied — B2
  application keys are usually bucket-scoped — so no flow may depend on it.
- **No read-only mode.** The key's own permissions are the sole authority.
  Distinguishing two connections to one bucket is a naming matter — the user
  writes `(R/O)` in the name if they want — not a stored modifier. Rejected
  explicitly: a user-declared read-only flag, and a sticky bit derived from
  discovery. This does not affect `capabilities`, which continue to be learned
  from real operation failures exactly as they are today.
- **Vault is offered after the first successful connect**, not before. Nothing is
  gated behind a passphrase until the app has demonstrated it works. This
  supersedes the earlier "opt-in checkbox, off by default" decision.
- **Unlock screen shows connections above the passphrase field** — the login and
  the bucket list are one screen, not two.
- **Passphrase only** — no invented username for the human. The vault's username
  field exists solely for password managers and is not user-editable.
- **Easy post-unlock switching is a first-class requirement**, phased but not
  optional.

## Architecture

### Data model

Three records replace the single `s3b_profiles` record.

```js
// s3b_credentials — "who I am"
{ version: 1, credentials: [
  { id, label, endpoint, keyId, provider, regionOverride }
]}

// s3b_connections — "what I click"   (supersedes s3b_profiles)
{ version: 2, connections: [
  { id, name, credentialId, bucket, capabilities: { list, download, upload, delete } }
]}

// s3b_vault — absent until the user opts in
{ version, salt, iterations, check, entries: { [credentialId]: { iv, ct } } }
```

The r/o + r/w case is then expressed directly:

| name | credentialId | bucket |
|---|---|---|
| `Family photos (R/O)` | `c1` | `family-photos` |
| `Family photos (admin)` | `c2` | `family-photos` |
| `Site backups` | `c2` | `site-backups` |

Three connections, two credentials, one shared. Rotating `c2` is a single edit
that two connections pick up.

**Vault entries key on `credentialId`, not connection id.** The secret belongs to
the credential; connections sharing a credential share one ciphertext.

**Default naming.** Both `label` and `name` are user-editable strings with
generated defaults, following the existing `defaultName` helper
(`ProfilePicker.jsx:113`). A credential defaults to
`` `${PROVIDER_LABEL} — ${keyId.slice(0, 6)}…` `` (key IDs are opaque, so a
truncation is the only distinguishing thing available); a connection defaults to
`` `${PROVIDER_LABEL} — ${bucket}` ``, matching today's behaviour. Neither is
required to be unique — the id is the identity.

**Capabilities move onto the connection.** This is a correctness fix, not a
feature: `s3b_capabilities` is one global key today (`storage.js:47`), so with
more than one bucket in play, state learned against bucket A would be applied to
bucket B. Behaviour is otherwise unchanged — still learned from real failures,
never probed, never declared.

### Migration

Each `s3b_profiles` entry becomes one credential + one connection, with
credentials deduped on `(endpoint, keyId, provider, regionOverride)`. A user with
five profiles sharing one key ends up with one credential and five connections
with no action on their part — the migration repairs the duplication that
motivated this work.

`s3b_profiles` is read but **left in place for one release** as a rollback path,
then removed in a follow-up. Migration is idempotent and runs on mount, matching
the existing `migrateProfilesFromLegacy` pattern (`storage.js:343`).

Three functions in `storage.js` enumerate profile keys explicitly and will
silently miss the new records unless updated in the same change:
`wipeAllAppData` (`:317`), `deleteAllProfiles` (`:336`),
`repairStorageInvariants` (`:222`).

### Crypto — `src/lib/vault.js`

WebCrypto only, no dependencies. Pure module, no DOM access.

| Parameter | Value |
|---|---|
| KDF | PBKDF2-SHA-256, 600,000 iterations, 16-byte random per-vault salt |
| Cipher | AES-256-GCM, fresh 12-byte IV per entry |
| Passphrase check | known constant encrypted under the derived key |

`iterations` is stored in the record so the count can be raised later and entries
re-wrapped on the next successful unlock.

The `check` value verifies a passphrase without decrypting a real secret, and
works when the vault holds no entries yet.

**The derived key is exported raw into `sessionStorage`.** Two consequences are
accepted deliberately:

- The key must be derived `extractable: true`.
- Holding the key rather than a single decrypted secret means an XSS reaches
  *every* credential, not just the active one.

The justification is the switching requirement — decrypting lazily on switch
needs the key present — and the reload path, since `App.jsx:198` auto-connects on
load and an in-memory-only key would break it. Net posture versus today:
identical `sessionStorage` exposure, with the on-disk footprint going from
nothing to ciphertext.

**No recovery.** Reset wipes ciphertexts only; connections retain endpoint,
bucket, and key ID.

600k iterations is roughly one second on a slow phone. Unlock must show a spinner
and disable the submit button; an unexplained pause is a bug.

### Password-manager interaction

The collision predates this work: `keyId` is already `autocomplete="username"`
and `secretKey` already `autocomplete="current-password"`
(`CredentialForm.jsx:272,291`), so a connect already registers as a login on the
origin. Adding a passphrase puts a second password on that same origin.

Managers key on **(origin, username)**. Two secrets on one origin are ambiguous
only when they share a username, so the resolution is to give the vault a
username that cannot collide with a real key ID:

| Form | username field | password field |
|---|---|---|
| Vault unlock | constant `Bucketer vault (this device)`, **visible + readonly** | `current-password` |
| Vault create / change | same constant | `new-password` |
| Add credential | `keyId` (unchanged) | `secretKey` (unchanged) |

Key IDs are opaque alphanumerics (`AKIA…`, `0057…`); a constant containing spaces
and parentheses cannot be mistaken for one. Multiple credentials become multiple
manager entries distinguished by key ID — the ordinary two-accounts-on-one-site
case every manager handles.

The username field is **visible and readonly** rather than hidden: hidden
username fields are honoured by Chrome for change-password flows but are
inconsistently picked up by extension-based managers, and the visible line
reinforces that the unlock is device-local.

Supporting requirements:

- All credential and passphrase inputs need stable `name` attributes. They carry
  `id` today and no `name`; KeePassXC's matcher prefers `name`.
- The unlock screen must never render the connect form simultaneously, or a
  manager filling "the first password field" has a real choice to get wrong.

`autocomplete="new-password"` on vault creation invites managers to **generate**
the passphrase, so with KeePassXC or Vaultwarden the passphrase can be a long
random string the user never sees or types. The resulting division of labour: the
manager holds one strong secret and syncs it across devices; Bucketer holds N
credentials and switches between them.

### Screens

**First run** — unchanged. Fill in or paste credentials, connect, see files.

**After the first successful connect** — a dismissible, never-repeated offer:
*"Save this key so you don't have to retype it next time?"* Accepting asks for a
passphrase and creates the vault.

**Every visit after** — connections listed with lock icons, passphrase field
below. Clicking a connection focuses the passphrase; Enter unlocks and connects
into that connection in one motion.

```
╭────────────────────────────────╮
│          🪣  Bucketer          │
│   Your buckets          🔒     │
│   ┌────────────────────────┐   │
│   │ 🔒 Family photos (R/O) │   │
│   │    Backblaze B2        │   │
│   ├────────────────────────┤   │
│   │ 🔒 Site backups        │   │
│   │    Backblaze B2        │   │
│   └────────────────────────┘   │
│                                │
│   Bucketer vault (this device) │
│   Passphrase                   │
│   ┌───────────────┐ ┌───────┐  │
│   │ ••••••••••    │ │Unlock │  │
│   └───────────────┘ └───────┘  │
╰────────────────────────────────╯
```

Connection names and providers are visible before unlock. This is not a
regression — profile and bucket names are plaintext in localStorage today
(`storage.js:255`) — but the lock icons must make clear that what is protected is
the *key*, not the list.

**While connected** — the header bucket name (`App.jsx:374-405`) becomes the
connection switcher. Post-unlock the vault holds every credential, so switching
never re-prompts, whether or not the target shares a credential with the current
connection.

### Units

| New | Purpose |
|---|---|
| `src/lib/vault.js` | derive / wrap / unwrap / reset. Pure WebCrypto, no DOM |
| `src/lib/connections.js` | CRUD over both records, migration, credential dedupe |
| `src/lib/credential-paste.js` | Phase 4 — pure parser, provider blobs → form fields |
| `src/components/VaultUnlock.jsx` | passphrase field, readonly username, reset affordance |
| `src/components/ConnectionList.jsx` | replaces `ProfilePicker.jsx` |
| `src/components/ConnectionSwitcher.jsx` | header dropdown |

Changed: `App.jsx` (session state gains `locked`), `CredentialForm.jsx`
(credential picker when adding, `name` attributes), `storage.js` (key
enumeration).

## Phasing

| Phase | Ships | User-visible |
|---|---|---|
| **1** | model, migration, per-connection capabilities | no — pure refactor behind existing UI |
| **2** | vault, unlock screen, post-connect offer | **yes — this is the login** |
| **3** | switcher, add-bucket, `ListBuckets` prefill, URL fragment | yes |
| **4** | paste-anything parser | yes |

Phase 1 landing invisibly is deliberate: the migration is the riskiest element
and gets a release of its own to prove out before anything is built on it. Each
phase is a minor release.

### Phase 1 as-built — what Phase 2 must account for

**Phase 1 shipped as v1.39.0 on 2026-07-27** (merge `7790159`, patched by v1.39.1).
It landed the model this spec describes, but review surfaced three facts this
document was written before, and each changes Phase 2's scope.

**1. There is a migration marker: `s3b_connections_migrated`.** It did not exist
in this spec. It records — as a fact, not a derivation — that a device is on the
connection model, written both by migration and by `saveConnectionRecord()`. It
must be cleared alongside the vault by any wipe path, and the reasoning behind it
(`BUG-045`) is why the vault must not infer state it can record instead.

**2. Credentials are now garbage-collected, so vault entries must cascade.** The
edge case below asked for "blocked or cascade"; Phase 1 chose cascade —
`deleteConnectionRecord()` calls `deleteCredentialRecord()`, which refuses while
another connection still references the credential. Since vault entries key on
`credentialId`, **deleting the last connection using a credential must also delete
that credential's vault entry**, or the vault accumulates ciphertexts under ids
that no longer exist anywhere and no UI can reach.

**3. Editing a connection onto different credentials mints a new credential id**
([#53](https://gitlab.com/hidayahtech/bucketer/-/work_items/53), open). Today it
orphans the old credential record. Once the vault exists it orphans a *secret*
too, and worse: the secret the user just typed would be silently forgotten,
because the vault entry sits under the old id while the connection now points at
a new one. Phase 2 must therefore:

- fix #53 so the superseded credential is collected, and
- **re-wrap the secret under the new credential id** when a connection is saved
  with the vault unlocked and a secret present in the form.

Fixing #53 first, as its own change, is the cheaper order — it is small, it is
independently testable, and it stops the orphan class growing before secrets are
attached to it.

**Line references in this document predate Phase 1** and have all shifted; treat
them as pointers to the right function, not the right line.

### Phase 4 — paste-anything

`src/lib/credential-paste.js` is a pure function from pasted text to partial form
fields, recognising B2 application-key output, AWS credentials INI stanzas,
`export AWS_*` env blocks, rclone config sections, and bare endpoint URLs. No
storage, no side effects, trivially table-testable.

## Edge cases

- **`ListBuckets` denied** — the bucket field is always a text input; a
  successful call only *adds* a dropdown of names. Failure is silent. Results are
  cached per credential and re-fetched only on explicit refresh, so a denied key
  is not re-probed every visit.
- **Wrong passphrase** — AES-GCM tag failure on the `check` value. Message must
  distinguish "wrong passphrase" from "vault is corrupt"; the latter offers reset.
- **Vault present but empty** — unlock still succeeds via `check`; the screen
  falls through to the ordinary connect form.
- **Private browsing** — `safeGet`/`safeSet` already swallow storage errors
  (`storage.js:52-60`). A vault that cannot be persisted must fail loudly at
  creation rather than silently appearing to save.
- **Deleting a credential** with connections still referencing it must be blocked
  or must cascade; orphaned `credentialId` references are a corruption class the
  migration cannot repair.
- **Corrupt records** — `loadProfiles` returns a safe empty envelope on parse
  failure (`storage.js:266-272`); both new loaders follow that pattern.

## Deferred — recorded so they are not lost

- **In-flight queue guard on switch.** Upload, move, and delete queues are
  session-scoped. Switching mid-upload must either be blocked with a stated
  reason or the queues must become connection-scoped. This is a Phase 3
  decision; building the switcher without settling it is a data-loss bug.
- **Share links and the URL fragment.** `url-params.js` and `buildShareUrl`
  assume a single bucket; deep links break once there is more than one.
- **Vault export / import.** The honest answer to "move to another device" — the
  passphrase syncs via the password manager, the ciphertext does not. Out of
  scope here, but this design strengthens the case for it.

## Testing

- **`test/vault.test.js`** (unit, pure Node — WebCrypto is built in): round-trip
  wrap/unwrap; wrong passphrase rejected; `check` verification with an empty
  vault; iteration-count upgrade re-wraps entries; reset clears ciphertexts and
  leaves connections intact.
- **`test/connections.test.js`** (unit, `global.localStorage` mock per
  `storage.test.js`): table-driven migration including the dedupe path, corrupt
  and partial records, idempotency across repeated mounts, orphaned
  `credentialId` handling.
- **Component tests** (`test:ui`) for `VaultUnlock`, `ConnectionList`, and the
  switcher: locked/unlocked rendering, wrong-passphrase message, click-connection
  → passphrase focus.
- **E2E**: unlock-then-connect, and switch-while-connected.
- **Manual QA matrix — required, not optional.** Password-manager behaviour is
  heuristic and cannot be unit-tested. Save, autofill, and update must each be
  exercised against Chrome built-in, Firefox built-in, KeePassXC, and
  Bitwarden/Vaultwarden, with results recorded before Phase 2 closes.
- `BUG-LOG.md` is consulted before writing tests, per house policy.

## Versioning

Four minor bumps, one per phase, each with its own `CHANGELOG.md` entry in the
same commit and operator confirmation before commit, per house policy.
