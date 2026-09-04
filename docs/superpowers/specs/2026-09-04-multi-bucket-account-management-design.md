# Multi-Bucket & Account Management — Design

**Date:** 2026-09-04 · **Base:** v1.55.0 · **Status:** DESIGN & SPEC (no code) · **Blast radius:** T-tool
**Author:** Engineering Manager session, synthesizing a 5-lane expert panel.
**Evidence base:** `docs/review-multi-bucket/{01-architecture,02-ux,03-security,04-frontend-feasibility,05-providers}.md` (the raw lane reports — cite them for the underlying file:line and vendor-doc URLs).

---

## 1. Problem & goals

Bucketer can only browse **one bucket at a time**, and reaching a second bucket is unintuitive:
saved connections appear as a **flat "profiles" list** with no notion of the *account* several
buckets share; switching means clicking **Disconnect → splash → re-drive the whole credential
form → re-enter the secret → reconnect** (~5–6 steps and a full view teardown); and adding a
sibling bucket on an account you already configured forces you to retype endpoint/key/region.

**Goal:** make multi-bucket access and account management feel like switching browser tabs, using
the mental model the operator chose — **Both**:

1. **Accounts organize buckets** in a manager/tree (an account = a credential; buckets nest under it).
2. **A quick-switch tab-bar** for instant live switching between recently-used buckets.

**This session's output is design + spec only.** Implementation is a later, separately-approved
effort (see §13 slice plan).

---

## 2. Grounding pillars (fixed constraints)

1. **Single served artifact** — one self-contained `dist/index.html`; no second asset/service by default.
2. **Server-blindness** — the secret key leaves the browser only as a SigV4 signature over TLS to
   the storage endpoint; share config lives in the URL `#hash`, never sent to any server; no relay.
3. **No backend / no admin console** — GitLab #40 declined a "bucket list / create / admin console".
   See §8 for how the opportunistic discovery probe is reconciled with this.
4. **`file://` support** — no `crypto.randomUUID` for ids, no secure-context guarantee (matters for the vault).

Every design element below respects these; the two places they bite (ListBuckets discovery, vault
`crypto.subtle`) are called out explicitly.

---

## 3. What already exists (the substrate — do not rebuild)

All five lanes independently confirmed the structural work is largely **already done**:

- **Bipartite model** (`src/lib/connections.js`): a *credential* `{id, endpoint, keyId, provider,
  regionOverride, label}` (= an **account**) backs many *connections* `{id, credentialId, bucket,
  basePrefix, name, capabilities}` (= an **account+bucket**). `findOrCreateCredential` already
  de-dupes credentials by fingerprint, so N buckets on one key store the key once. The
  accounts→buckets tree is therefore a **zero-schema UI projection**:
  `groupBy(listResolvedConnections(), c => c.credentialId)`.
- **`bucket` is not baked into the S3 client** (`src/lib/s3-client.js` — `bucket` is destructured
  but unused). It's only ever a per-command `Bucket:` param in `Browser.jsx`/`UploadQueue.jsx`. So
  runtime bucket selection is a **prop-origin change**, not a data-flow redesign.
- **Capabilities are already per-(account,bucket)** — they live on the connection record since
  v1.39.0. The old v1.14.0 prereq "key capabilities by bucket name" is DONE and its prescribed
  shape is now *obsolete* (per-connection is strictly better — two accounts sharing a bucket name
  would have collided under the old plan).
- **In-flight transfers already survive a connection switch** — engines receive `client` as a
  closure-captured argument at call time, and the task store (`src/lib/task-store.js`) is a
  session-independent module singleton that `MasterQueue` subscribes to directly. A later
  `setClient()` never reaches a running transfer.

**Consequence:** the redesign is mostly a **UX layer + one safety fix + a secrets decision**, not a
data-model rewrite. The v1.14.0 "decouple bucket (156 refs), make it nullable" framing predates the
bipartite model and is superseded (see §14).

---

## 4. Decisions locked (operator, 2026-09-04)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Secret persistence | **Phased.** In-memory multi-secret interim now (zero new at-rest risk); vault revival + preconditions as a later phase. |
| D2 | Bucket model (switch = connection, or connections roam buckets) | **Default to 1:1 (switch = saved connection)** in this spec; operator confirms on review (§5.6). |
| D3 | ListBuckets discovery | **Cut for now** (operator, 2026-09-04). No discovery flow; manual / `+ bucket` entry only. The false "SDK calls ListBuckets on init" claim is still fixed as an independent cleanup (§8). |

---

## 5. Target architecture

### 5.1 Session/state model — one live client, tabs as switch UI

Keep the singular `session` state machine (`locked | disconnected | connecting | connected |
failed`) and **one live S3 client + one mounted `Browser`**, all describing the **foreground** tab
only. Reject N-live-Browsers/kept-alive panes as the default (multiplies the codebase's heaviest
component — `Browser.jsx` is 1,408 lines / 65 hook sites — for sub-second latency). Warm keep-alive
is a **gated follow-up** (§13 Slice 5), not the initial shape.

- **Exactly one interactive client is alive; zero-or-more *transfer* clients are alive**, each owned
  by a running task and discarded when it settles. There is never a second *interactive* session.
- A tab is a control that drives the existing `handleSelectProfile → connect` motion; it does **not**
  add session states.
- **Honesty rule:** a tab can only switch "instantly" if its secret is already available (this
  session's memory, or the vault once revived). When it isn't, selecting the tab lands in
  `disconnected/connecting` with an **inline secret field** focused — the tab-bar must never imply a
  live switch it can't perform (the tab-bar analogue of the master-queue "never claim what you can't
  observe" rule).

### 5.2 The Accounts manager (accounts → buckets tree)

**One `AccountsManager` component** replacing the flat `ProfilePicker`, mounted in **two** contexts:

- **Splash** (disconnected): full-width, the primary content.
- **Sidebar drawer** (connected): same component, narrower, inside the existing `translateX` drawer —
  so switching **never leaves the connected view**. Reuse the existing hamburger + drawer; no new
  interaction pattern.

Structure — two-level disclosure tree, accounts collapsed by default except the active account:

```
┌─ Accounts & buckets ──────────────────────────────────────┐
│  ▾ Backblaze B2 · key 0042abc…              [+ bucket]     │
│      ● photos                          (active)            │
│        backups                                             │
│  ▸ AWS S3 · key AKIA7f2…                    [+ bucket]     │
│  + Add account…                                            │
└───────────────────────────────────────────────────────────┘
```

- **Account row:** provider label + a disambiguator (masked key-ID tail — needed when two accounts
  share a provider). The whole row toggles expand/collapse.
- **`+ bucket`** under an account: opens a **name-the-bucket-only** step that reuses the account's
  stored endpoint/key/provider/region via `findOrCreateCredential`. The secret is still required at
  add-time (never stored), but nothing else is retyped. Closes the "retype everything for a sibling
  bucket" friction.
- **Bucket row:** name + active indicator; click anywhere to switch; inline hover delete reusing the
  existing confirm-inline pattern.
- **`+ Add account…`:** the *only* place a fresh full `CredentialForm` appears, framed explicitly as
  "new account".

**Empty states:** zero accounts (true first-run) collapses to today's centered `CredentialForm` (no
empty tree chrome). An account with zero buckets stays visible ("No buckets saved yet — [+ bucket]")
rather than silently vanishing — a dangling credential the user can either populate or remove.

**Deleting the last bucket under an account** must state what happens to the account's stored
credential before committing (today's flat "Delete?" says nothing).

### 5.3 The quick-switch tab-strip

A slim MRU strip in the **app header** (between logo and status/actions). Shows only *recently-used*
buckets (~5, most-recent first, active pinned first) — **derived from, never a duplicate of**, the
manager. Deleting a bucket in the manager removes its tab; a tab click never creates a bucket the
manager doesn't already hold. One-way relationship keeps "Both" from becoming two lists to keep in sync.

- Each tab shows **provider + bucket** (reuse the existing `profileHint()` label shape).
- Active tab uses the existing `.profile-row-selected` accent (visual consistency with the manager).
- An overflow "**⊕ Switch…**" opens the manager (popover on desktop, drawer on mobile) for buckets
  outside the recents window.
- No destructive-looking `✕` on the active tab (closing the active tab = "disconnect", which has its
  own renamed control). A `✕` on inactive tabs only removes them from the recents strip, not from
  saved storage.

### 5.4 Switching flow (the payoff)

- **Tab visible, secret held this session:** 1 click → `Browser` remounts against the new
  connection. Instant.
- **Tab visible, secret not held:** 1 click + 1 inline Secret Key field anchored under the tab
  (not the full form, not a splash round-trip).
- **Bucket not in recents:** open manager/⊕ → click the bucket row → same secret-if-needed step.

Never routes through Disconnect/splash. Compared to today (~5–6 steps + full context loss) the common
case collapses to **1 click**.

### 5.5 Transfers survive a switch (origin-tagging — the make-or-break)

A switch **never blocks and never cancels** in-flight work. The existing closure-pinning makes
transfers keep running; the missing piece is **attribution** so a background job doesn't corrupt the
foreground view. Three mechanical requirements:

1. **Tag every task with its origin** — extend the task factories (`src/lib/queue-tasks.js`) so each
   task carries `connectionId` + full origin `{bucket, provider, endpoint}`.
2. **Route side-effects by the task's origin, not the live ref.** Progress callbacks must check "is
   my task's `connectionId` the foreground one?" before touching `browserActionsRef` /
   `saveConnectionCapabilities`. When it isn't: capability writes go to the *task's* `connectionId`;
   view refreshes are **skipped** (the eventual foreground remount re-lists from the network — boring
   and correct). Today these callbacks reach `browserActionsRef.current` / `selectedConnectionId`,
   which after a switch point at the *wrong* connection.
3. **Give the master queue an origin chip** — keep rendering every task (hiding background work
   re-introduces the "invisible job" postmortem class); add a per-row connection chip from
   `connectionId`, optionally grouped by origin when >1 is present.

**Interactive handoffs stay blocking-as-paused:** a job awaiting a `showDirectoryPicker`/save-dialog
under a user gesture converts to a resumable "paused-for-input" queue row on switch rather than
trapping the switch.

**Does a bucket switch reset the upload/master queue?** No. The master queue is global and
origin-labelled; the upload queue's transfers likewise pin their client. (Flagged for QA: confirm
`UploadQueue`'s own queue pins client at enqueue time — architect lane did not audit it.)

### 5.6 Bucket model — D2 (default 1:1, confirm on review)

**Recommended default (this spec assumes it):** *switch bucket = switch to a saved connection.* Each
`(credential, bucket)` is a connection; picking a bucket **materializes or re-selects** its
connection lazily via a new `findOrCreateConnection({credentialId, bucket, basePrefix})` mirroring the
proven `findOrCreateCredential`. This keeps `bucket` **on the connection** (non-null; `Browser`/
`UploadQueue` contract byte-identical) and capabilities cleanly per-(account,bucket) with **no second
keying dimension**.

**The alternative (flagged, not chosen):** one saved connection *roams* arbitrary buckets its
credential can reach at runtime, without saving each. More flexible, but capability state then needs a
`connectionId × bucket` key, and it muddies the tree (a connection would no longer equal one bucket).
The 1:1 model can always *feel* like roaming — "+ bucket" is one field — without the extra keying.

> **Operator confirm on review:** 1:1 (recommended) or roaming? Everything downstream (capability
> keying effort, tree semantics) follows from this.

---

## 6. Data-model & schema deltas

No change to the *saved* connection or credential shape. `CONNECTIONS_VERSION` stays 2;
`DB_VERSION` stays 6. Additive only:

1. **`findOrCreateConnection({credentialId, bucket, basePrefix})`** in `connections.js` — new
   constructor, mirrors `findOrCreateCredential`. Materializes/re-selects an (account,bucket)
   connection on demand.
2. **Optional-bucket at credential-entry time** — relax `CredentialForm`'s required-bucket so an
   *account* can be added without first naming a bucket. `storage.js` already writes an empty bucket
   happily; the only gate is the form validation. `bucket` stays mandatory on a *materialized*
   connection.
3. **Download-job origin fix (the latent bug, §7)** — add `endpoint` (and `connectionId`) to the job
   record at creation; change the job filters from bucket-name equality to full-origin (matching how
   move jobs already filter). Additive; legacy jobs fall back to `bucket`+`provider` match. No
   DB-version bump.
4. **Task origin tags (§5.5)** — `connectionId` + `{bucket, provider, endpoint}` on every task
   factory. The store isn't persisted, so no migration — only the factories and two callback sites.

---

## 7. The latent bug this surfaces (must fix before multi-account ships)

**Download jobs filter by bucket *name* only and don't record `endpoint`** — unlike move jobs, which
match full origin `{provider, endpoint, bucket}`. Two accounts sharing a common bucket name
(`backups`, `media`, `assets` — extremely common) would **cross-surface each other's download jobs**.
Latent today; a correctness bug the moment multi-account exists.

Security lane independently ranked this class ("credential confusion") the #1 multi-account risk and
pointed at the existing move-jobs precedent as the fix template. **Fix:** add `endpoint`/`connectionId`
to the download-job record; switch all download-job filters to full-origin equality. Additive, no
DB-version bump. Ships in Slice 2 (§13).

---

## 8. ListBuckets discovery — cut for now (D3), plus a doc cleanup

**Decision: no `ListBuckets` discovery flow ships.** Manual bucket entry and the `+ bucket`
name-only step (§5.2) are the whole story; the manager only ever shows buckets the user has explicitly
told Bucketer about. This keeps the design cleanly inside GitLab #40 (no bucket-list/admin surface) and
matches the UX lane's recommendation.

**Why it wasn't worth pursuing** (recorded so it isn't re-proposed): the provider lane found the
dominant blocker is **CORS-on-service-root** — `ListBuckets` targets the account root (`GET /`), but
CORS config is a *per-bucket* property, so there is no CORS config for the browser preflight to
satisfy. **Confirmed blocked on AWS and B2; very likely blocked on R2 and DO Spaces** (4 of 6). Only
Wasabi and MinIO *might* work (different CORS mechanisms) and only after a live test — and even where
it works it needs the *broad* key scope Bucketer's own guidance steers users away from. Net value is
low; deferring loses little. If a future request revisits it, it should be a bounded, opportunistic,
silently-degrading probe (never a gate), and the #40 line to draw is "read-only discovery against
one's own endpoint" vs. "admin console" — but that is out of scope here.

**One cleanup to do regardless (small, independent of everything above):** the repo currently claims, in
`SetupGuide.jsx` and an enforcing test (`test/source-invariants.test.js`), that "AWS SDK v3 calls
ListBuckets during client initialisation." The provider lane proved this **false** (empirical: no
network call on `new S3Client(...)`; Bucketer's actual connect probe is `ListObjectsV2`). Fix the
SetupGuide text + test + the PV-11 note. The underlying advice (bucket-restricted B2 keys need
`listAllBucketNames` *to call ListBuckets*) stays right; only the "why" is wrong.

---

## 9. Secret handling — D1 (phased)

### Phase A (near-term): in-memory multi-secret

Hold **several secrets in memory, keyed by credential id, for the tab's life** — so switching between
accounts *within one session* never re-prompts once each has been entered once. Zero new at-rest risk,
no vault dependency. This delivers the in-session half of the "Both" UX immediately.

- Secrets stay out of `localStorage` (unchanged posture); they live in an in-memory map, not
  `sessionStorage` beyond today's single-secret slot unless a later decision widens it.
- **Switch-boundary binding (Critical, from security lane):** on switch, re-derive the full
  `{endpoint, region, provider, bucket, secret}` tuple **atomically from the target connection
  record**, never from stale live form values or the previously-active `credentials` object, and
  **assert `recalledSecret.credentialId === connection.credentialId`** before any request fires. The
  existing move-jobs origin-match discipline is the template; apply it to every replayable artifact a
  multi-account UI can surface (download jobs, resumable uploads, master-queue rows).

### Phase B (later, separately scoped): vault revival

At-rest encrypted secrets give a **returning-user login** across accounts. The crypto core is sound
(PBKDF2 600k → AES-GCM, per-credential ciphertext). Revival is **ship-after-fixes** — flipping
`VAULT_ENABLED` re-arms two verified defects and widens XSS blast radius. Preconditions, ordered:

1. **[Critical] Fix C1** — a passphrase typo currently locks the user out of the *whole app* (the
   lock screen offers reset only for `corrupt`, not `wrong-passphrase`). Add a lock-screen "connect
   manually instead" escape hatch.
2. **[Critical] Fix C2** — accepting the offer after a key rotation wraps the secret under a *newly
   minted* credential the connection never points at ⇒ silent orphan + broken auto-connect. The offer
   must wrap only under the *selected connection's own* credential, gated on a `credentialFingerprint`
   match; never mint a credential in the accept flow.
3. **[Critical] Switch-boundary binding** — same assertion as Phase A (§9 Phase A), now over recalled
   *vault* secrets.
4. **[High] Approve the existing draft** (`docs/superpowers/specs/2026-07-28-vault-creation-flow-design.md`
   — it closes C1/C2 by construction), write the revised Task 6/7, and **run the manual
   password-manager matrix** (Chrome, Firefox, KeePassXC, Vaultwarden) that gates release and has
   never run.
5. **[High] CSP / XSS hardening of the single artifact** — the vault raises XSS impact from one live
   secret to **all** stored secrets. A strict CSP (no third-party origins; hashed inline) is a
   **release blocker** for flipping the flag. (Refer to a dedicated infra/frontend pass.)
6. **[Medium] `file://` `crypto.subtle` probe** → graceful session-only fallback, not the destructive
   `corrupt` verdict that offers a data-wiping reset.
7. **[Medium] Shared-machine guardrails** — passphrase strength floor + pre-commit "unrecoverable"
   warning; optional inactivity auto-lock; a "forget this device" reset reachable *without* unlocking.
8. **[Low] Share-menu account labeling** — show *which* connection a "copy link" shares (name +
   bucket) so a wrong-active-tab copy can't mis-target a key ID.

**Design the wrapping-key source as pluggable** (passphrase now; a WebAuthn `prf`-derived key is a
possible *future* alternative that would remove the "typo locks you out" class — but it needs a
secure context, so it can never be the only path while `file://` is supported).

---

## 10. Vocabulary

The UI says "profile" (`ProfilePicker`), "Saved Profiles" (`StorageModal`), and "Your buckets"
(`VaultUnlock`) — three words for one concept, while the code already moved to `connection(s)`.
Standardize, decisively:

| Concept | User-facing word |
|---------|------------------|
| Credential (endpoint + key + provider + region) | **Account** |
| A saved `{credential, bucket}` you click to browse | **Bucket** (or "saved bucket" in lists) |
| The join record itself | *not surfaced as a noun* — show accounts and buckets, not "connections" |
| The manager/view | **"Accounts & buckets"** |
| Add a new bucket to an existing account | **"Add a bucket"** |
| Add a wholly new credential | **"Add an account"** |
| The "leave the app" action (today "Disconnect") | rename to read as leaving (e.g. "Sign out" / "Close connection") — stop using one word for both "switch bucket" and "leave" |

Retire "profile" from **every** UI string in the same pass (avoid re-creating the drift).
**Open UX question (not blocking):** does "Account" wrongly imply a server-side login exists? Worth a
small word-test vs. "Provider"/"Key" before committing the string.

---

## 11. Feasibility & component notes

- **Multi-client cost is negligible** — an `S3Client` is a stateless config object, not a socket.
  The real cost of warm tabs is N mounted `Browser` trees, not N clients.
- **State home:** App.jsx is 1,547 lines. Follow the existing plain-hook extraction convention (no
  state library): a new **`useConnections`** hook (lift `connections`/`selectedConnectionId`/the
  three handlers) and, for the tab work, a **`useConnectionTabs`** hook owning the recents set, active
  tab, and (for warm tabs later) per-tab client/capabilities/bucket + eviction. Per-tab identity
  replaces the single global `browserKey` counter when warm tabs land.
- **`browserKey` semantics:** today it means "reconnect happened, drop the listing cache." A
  same-account bucket switch is a *different* invalidation (client + capabilities still valid, only
  the listing is stale). Under the 1:1 model each switch is a connection switch, so the existing
  remount motion is correct for Slice 4 (cold switch); warm tabs (Slice 5) need per-tab keys.
- **Browser.jsx decomposition is a prerequisite for warm tabs only.** At 1,408 lines / 65 hook sites,
  mounting it N times multiplies per-render work. Extract the **rename** and **new-folder** state
  clusters first (following the proven `usePreview(client, bucket)` extraction — already written in
  the bucket-as-runtime-prop shape), *before* multi-mounting, not after. Not a blocker for Slices 1–4.
- **Zero new runtime deps** for anything here. Bundle: ~28% raw headroom against the 1 MB tripwire;
  re-check after the cold-switch phase before starting warm tabs (GitLab #41 tracks the long-term
  audit).

---

## 12. Mobile

The sidebar is already a `translateX` overlay drawer at **every** width, so hosting the manager there
costs nothing extra on mobile. Explicit mobile treatment needed for:

- **The tab-strip doesn't fit a phone header** — at ≤640px collapse it to a single "active bucket +
  chevron" control that opens the manager drawer to its recents view (don't horizontally-scroll a tab
  strip on a phone).
- **Touch targets** — the manager's account/bucket rows and inline add/delete affordances need the
  44px-minimum treatment already applied to the file table at ≤640px.
- **Disclosure hit-area** — the whole account row toggles expand/collapse, not just the tiny triangle.

Extend the existing `max-width: 640px` block; no new breakpoint architecture.

---

## 13. Slice plan (each independently shippable + version-bumped)

Bug-fixers first; each slice carries its own version bump + CHANGELOG + passing build/tests per
project discipline.

- **Slice 1 — Account grouping in the picker.** `AccountsManager` renders `listResolvedConnections()`
  grouped by `credentialId`, in both splash and (new) sidebar mounts. Pure UI projection, zero
  data-model risk, unblocked today. Ships the "manager/tree" half + the vocabulary sweep (§10) +
  rename "Disconnect".
- **Slice 2 — Origin-tag the task store + fix download-job origin filtering (§5.5, §7).** Fixes the
  latent cross-account download bug and is the safety prerequisite for live switching. Adds the
  master-queue origin chip.
- **Slice 3 — Runtime bucket selection + `findOrCreateConnection` (§6).** Bucket flows from a runtime
  selection; optional-bucket at credential entry; lazy connection materialization. Small, self-contained.
- **Slice 4 — Quick-switch tab-strip, cold switch (§5.3–5.4).** MRU header strip + in-session
  multi-secret (Phase A, §9). Honest complete "Both" UX, no Browser.jsx surgery.
- **Independent cleanup (anytime) — SetupGuide/test "ListBuckets-on-init" misdiagnosis fix (§8).**
  Not part of the multi-bucket work; a standalone correctness fix to user-facing text + its test.
- **Slice 5 (gated follow-up) — Warm keep-alive tabs.** Requires the Browser.jsx decomposition pass
  first. Delivers true instant switching. Re-check bundle size before starting.
- **Phase B (separate effort) — Vault revival (§9 Phase B)** with all preconditions; unlocks
  returning-user login across accounts.

---

## 14. Reconciliation with prior art & GitLab

- **v1.14.0 v2.0-prereq #1 ("decouple bucket, make nullable, single-bucket-mode migration"):** right
  in spirit, **wrong in mechanism.** Under the bipartite model, keep `bucket` on the connection; make
  it optional only at credential-entry; materialize buckets lazily. The "156-ref heat map" counted a
  flat model that no longer exists — don't size the work from it.
- **v1.14.0 prereq #2 ("key capabilities by bucket name"):** **DONE, and the prescribed shape is now
  obsolete** — capabilities are per-connection since v1.39.0 (strictly better). Do not resurrect
  `s3b_capabilities`.
- **v1.14.0 prereq #3 (extract hooks from Browser.jsx):** still valid, and now specifically a
  **prerequisite for warm tabs (Slice 5)**.
- **GitLab #40 (declined "bucket list / admin console"):** design stays fully inside it — discovery is
  cut (§8), the manager only shows self-entered buckets, no create/delete/policy surface. No change to
  #40 needed.
- **GitLab #53 (editing a connection orphans the old credential):** closed; the same
  garbage-collection discipline (`saveConnectionRecord`'s credential GC) is the pattern the C2 vault
  fix and download-job fix both echo.
- **GitLab #41 (bundle-size pass):** not a blocker; re-check after Slice 4.
- **Missing decision record:** the bipartite connection model itself has no design record (it lives
  only in `connections.js` header comments). File a short one for "credential↔connection bipartite +
  lazy bucket connections" so the next session stops planning against two-models-stale prior art.

---

## 15. Open items to confirm on review

1. **D2 bucket model** — confirm 1:1 (recommended) vs. roaming (§5.6). Everything downstream follows.
2. **`UploadQueue` client-pinning** — QA must confirm its own queue captures client at enqueue time
   (architect lane did not audit it) before Slice 4 relies on transfers surviving a switch.
3. **"Account" wording** — optional word-test vs. "Provider"/"Key".
4. **Per-tab URL/hash state** — decide whether switching accounts rewrites the visible `#hash`
   (endpoint/bucket) or each tab owns its own, to avoid a shoulder-surf/screenshot leak of the
   previous account's endpoint (security lane §4).

---

## 16. Non-goals (YAGNI — explicitly cut)

- **Bucket discovery / `ListBuckets`** (D3, §8) — cut for now; no "enumerate all my buckets" flow,
  no disabled teaser control. Manual / `+ bucket` entry only.
- **Bucket create/delete/lifecycle/policy** — squarely #40's declined admin console.
- **Drag-to-reorder** tabs or tree rows (MRU + insertion order suffice).
- **Renaming an account** (bucket rename already exists via update-in-place). Follow-up if two
  same-provider accounts need custom names.
- **Cross-account bulk actions** (operating across two accounts at once). This redesign changes the
  *path to switch*, not the one-active-connection concurrency model.
- **A third full-page "Accounts" settings screen** — one component, two mount contexts is enough.
