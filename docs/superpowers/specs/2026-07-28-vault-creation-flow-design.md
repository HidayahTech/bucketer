# Vault Creation Flow and Lock-Screen Escape — Design

**Date:** 2026-07-28
**Status:** ⚠️ **DRAFT — presented but NOT yet approved.** Two of its decisions were
explicitly chosen by the operator (marked below); the rest was presented and the
session ended before approval. Re-present section by section before implementing.

## Why this exists

Phase 2's Task 6 wired the vault into `App.jsx`. Its review (opus, whole-file)
approved the *specified* work and found **2 Critical + 5 Important** — all of them
in the one piece the Phase 2 plan never specified: the post-connect offer's accept
flow. With no vault-creation UI described anywhere, the implementer had to design
the user's first encounter with the feature, including how a passphrase is chosen.

The root cause is structural, not careless. The offer does four things under one
button: creates the vault, find-or-creates a credential from the live form values,
conditionally creates *and selects* a whole connection, then remembers the secret.
Connection management became a side effect of "remember my key."

## Operator decisions (locked)

1. **Offer scope: only remember, never create.** The offer creates the vault and
   wraps the secret for the connection already selected — nothing else.
2. **Placement: inline banner expansion, plus a permanent home** in Storage &
   Privacy.
3. **Lock screen gets an escape hatch** — "Connect manually instead."
4. **Redesign rather than patch** — this document exists because of that choice.

## Design

### What the offer does

Creates the vault and remembers one secret. It never creates, names, selects, or
re-points a connection.

Actionable only when both hold:

- a connection is selected, and
- the credentials in use match that connection's credential, compared with the
  existing `credentialFingerprint` from `connections.js` — no new comparison logic.

If either fails, the banner says so and points at "Save as profile…". This removes
**C2** and **M10** by construction: the flow cannot wrap a secret under a credential
that no connection references, because it only ever uses a credential a selected
connection already points at. The dangerous case — the user edited their key before
connecting, so live credentials no longer match the selected connection — stops
being something the flow must detect and handle correctly.

### When it appears

On `capabilities.list === 'permitted'`, which `Browser.jsx:323` sets after a
successful listing — a real "these credentials work" signal. **Not** on
`createS3Client` returning, which is what the current code uses and which is why the
offer can appear on the "Connection failed" screen (**I2**).

It must render *inside* the connected branch, not outside the session conditional,
so a failed probe removes it.

### Where creation lives

Two entry points, one implementation:

- **The banner**, expanding into the passphrase form in place — lowest friction at
  the moment the user says yes.
- **A vault section in Storage & Privacy**, permanent. Dismissal stops being a
  one-way door, and there is somewhere to reach reset later (**I3**).

While either form is open, the sidebar's `CredentialForm` is **suppressed**. That
form currently renders unconditionally — `sidebarOpen` toggles a CSS class only — so
this is a real change, and it restores the "only one `autocomplete="username"` field
live" invariant that Task 6 broke (**I5**). A modal alone would not fix this: the
sidebar form stays in the DOM behind it.

### The creation form

- Passphrase **and a confirmation field**.
- A plain-language line stating the passphrase cannot be recovered, shown *before*
  the user commits.
- Failure surfaced, never swallowed: `rememberSecret` returns `false` when the write
  did not land, and that boolean must be checked. On failure, show the error and do
  **not** persist the dismissal, so the user can retry (**I1**).

I1 matters more than it looks: `createVault` verifies only that the *localStorage*
record landed, while `storeSessionKey`'s write is swallowed by design. A blocked
`sessionStorage` therefore produces exactly this state — a vault the user can never
put anything into, reported as success.

### Lock-screen escape hatch

A "Connect manually instead" affordance on the unlock screen, dropping to the normal
connect form with the vault still locked.

Today `session === 'locked'` renders `VaultUnlock` *instead of* `ProfilePicker` +
`CredentialForm` (`App.jsx:732-734`), and `VaultUnlock` offers reset only for
`corrupt`, never `wrong-passphrase` — deliberately, so a typo cannot destroy secrets.
Together those mean a forgotten passphrase locks the user out of the entire
application, with wipe-all as the only escape (**C1**).

The original "no passphrase recovery" decision meant *stored secrets are
unrecoverable*. It did not mean *the app becomes unusable*. This restores that
distinction.

### Unlock connects with the right precedence

`handleVaultUnlock` connects from the connection record, discarding stored flat
credentials and URL params that the mount effect explicitly prefers
(`App.jsx:413-419`). It must use the same precedence (**I4**).

## Deliberately unresolved

- **Changing a passphrase** is not in scope. The Storage & Privacy section gives it
  a home when it is wanted.
- **Whether the offer should reappear** after being dismissed once (M6 — it currently
  reappears on every connect until acted on). Decide during planning.

## Testing

- The match/mismatch precondition is pure and belongs in the unit layer via
  `credentialFingerprint`.
- Component tests: offer hidden on `failed`; offer hidden until
  `capabilities.list === 'permitted'`; sidebar form absent while the passphrase form
  is open; mismatched credentials produce the "save first" state rather than
  remembering; `rememberSecret` returning `false` surfaces an error and does not
  persist dismissal; the escape hatch reaches the connect form with the vault still
  locked.
- The password-manager matrix (Chrome, Firefox, KeePassXC, Vaultwarden) remains
  manual and still gates the release.
