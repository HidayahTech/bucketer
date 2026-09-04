# Multi-bucket + Account Management — Architecture Lane

**Author:** ARCHITECT lane, 5-expert design panel
**Date:** 2026-09-04 · **Base:** v1.55.0 · **Status:** DESIGN & SPEC ONLY (no source touched)
**Reads grounded in:** `src/components/App.jsx`, `src/lib/connections.js`, `src/lib/storage.js`,
`src/lib/task-store.js`, `src/lib/queue-tasks.js`, `src/lib/move-jobs.js`,
`src/lib/download-records.js`, `src/lib/indexeddb-core.js`, `src/components/MasterQueue.jsx`,
`docs/intent/action-plan-v1.14.0-review.md`, `docs/review-v1.14.0/05-roadmap-ux.md`.

---

## 0. The one fact that decides everything

Before any recommendation, one existing property of the codebase is load-bearing and must be
named, because every option below either exploits it or fights it:

**Transfers already run detached from the session, each pinned to the client it started with.**

- The task store is a **module-level singleton** bound to `requestAnimationFrame`, not React
  session state (`src/lib/task-store.js:82`). It outlives any reconnect, remount, or session
  transition. `MasterQueue` subscribes to it directly and renders every task regardless of the
  live connection (`src/components/MasterQueue.jsx:82-84`).
- Every engine receives its `client` **as an argument captured at call time**, not by reading
  live state during the run: `runOperation(client, task.bucket, op, …)` (`App.jsx:973`),
  `presign` closes over `client` (`App.jsx:759`, `App.jsx:853`), `runZipJob(fresh, { … })`
  (`App.jsx:861`). A later `setClient(newClient)` re-render does **not** reach into a
  still-running engine — its `client` is frozen in the closure that launched it.

So the substrate for "transfers survive a switch and run in the background" **already exists**.
What does *not* exist is the connection-attribution to make that safe when two connections are
in play at once. That gap, not the tab bar, is the real architectural work. Everything in §2
follows from it.

---

## 1. Target state model — accounts ↔ buckets ↔ live connection(s)

### 1.1 What the data model already gives us for free

The bipartite model (`src/lib/connections.js:1-20`) is **the account manager**, already built:

- **Credential** = `{id, label, endpoint, keyId, provider, regionOverride}` — this *is* an
  "account". Secret never stored (`connections.js:122-130`).
- **Connection** = `{id, credentialId, bucket, basePrefix, name, capabilities}` — the
  (account, bucket) pairing (`connections.js:11-14`).
- One credential backs many connections (`connections.js:5-9`); `findOrCreateCredential`
  already de-dupes credentials by fingerprint so N buckets on one key store the key once
  (`connections.js:244-260`).

The "accounts organize buckets in a tree" mental model therefore needs **zero schema change**:
it is a pure UI projection — `groupBy(listResolvedConnections(), c => c.credentialId)`
(`connections.js:290-295`). The flat `ProfilePicker` (`App.jsx:1273`) has never grouped these,
but the grouping key has been in the record since v1.39.0. This is the cheapest, highest-value
slice in the whole redesign and it is already unblocked (see §5, Slice 1).

### 1.2 One live client, or several?

**Recommendation: ONE live S3 client + ONE mounted `Browser` at a time. Background transfers
each pin their own client. Tabs are a lightweight switch UI, not N live sessions.**

Options considered:

| Option | What it means | Verdict |
|---|---|---|
| **A. One live client, transfers pin their own** (recommend) | `client`/`Browser`/`session` stay singular and describe the *foreground* tab only. Switching swaps the live client + remounts `Browser` (the existing `browserKey++` motion, `App.jsx:259`). In-flight engines keep their captured client and finish in the background against the task store. | **Chosen.** Reuses the frozen-closure property (§0). Smallest change to the state machine. One listing cache, one memory footprint. |
| **B. N live clients, N mounted Browsers** (tab = kept-alive pane) | Each tab holds a mounted `Browser` with its own listing cache/preview state; hidden panes stay warm for instant switching. | **Rejected.** Multiplies moving parts: N listing caches, N preview `useEffect` keyboard handlers, N sets of `browserActionsRef`. `Browser.jsx` is already the codebase's heaviest component (the v1.14.0 review flagged 1326 lines / 53 state vars, `05-roadmap-ux.md:258`). Mounting it N times is the opposite of "prefer boring", and buys only sub-second switch latency. |
| **C. Stateless — no persistent client** | Recreate the client per operation from stored creds + recalled secret. | **Rejected.** `createS3Client` is cheap, but the secret lives in `sessionStorage`/vault, not in the connection record — a stateless model would have to recall on every op, and it maps badly onto a "live browsing" pane that holds a listing cache. |

Under Option A, "several kept alive at once" is answered precisely: **exactly one interactive
client is alive; zero-or-more *transfer* clients are alive**, each owned by a running task and
discarded when that task settles. There is never a second *interactive* session.

### 1.3 How tabs/quick-switch map onto the singular `session` machine

The five states — `locked | disconnected | connecting | connected | failed`
(`App.jsx:122-127`) — stay exactly as they are and **continue to describe only the foreground
tab.** They are not multiplied per tab. A tab bar is a control that drives the *existing*
`handleSelectProfile` → connect motion; it does not add states.

Concretely, selecting a tab is the current `handleSelectProfile` (`App.jsx:1033-1042`) followed
by an automatic connect, instead of only pre-filling the form. The one honest new requirement:
a tab can only "instantly" switch if its secret is already available — from `sessionStorage`
(same tab, already connected this session) or the vault (if revived). When it is not, selecting
the tab lands in `disconnected`/`connecting` with the secret field focused — the *same* screen
we show today, just reached via a tab instead of the picker. **The tab bar must degrade to the
credential form; it must never imply a live switch it cannot perform.** (This is the tab-bar
analogue of the master-queue "never claim what you can't observe" rule,
`MasterQueue.jsx:22-26`.)

A background transfer belonging to a *non-foreground* connection needs **no session state at
all** — it already has per-task status in the store (`running/paused/done/cancelled`,
`queue-tasks.js:18-100`). The session machine and the task lifecycle are orthogonal today and
must stay orthogonal; conflating them is the trap.

---

## 2. In-flight work across a switch — THE make-or-break question

Today there is no true "switch a live connection out from under running work" path — `handleSelectProfile`
only rewrites the disconnected form (`App.jsx:1033-1042`), and `handleDisconnect` is a
deliberate teardown. The redesign *introduces* the hazard. Here is the honest failure analysis
and the design that survives it.

### 2.1 What breaks if we do nothing

If a tab switch simply calls `setClient(newClient)` + `browserKey++` while a move/download/zip
is running, the running engine keeps its old client (good, §0) **but its progress callbacks
reach into foreground refs that now point at the wrong connection:**

- `runDeleteOperation`'s callback calls `browserActionsRef.current?.removeItems(...)` and
  `invalidateCache(...)` (`App.jsx:551-557`). After a switch, `browserActionsRef.current`
  is the *new* connection's `Browser` (remounted, `App.jsx:1442`). The old job would mutate the
  wrong bucket's on-screen listing. **Cross-connection view corruption.**
- `moveProgress` does the same (`App.jsx:936-939`).
- `handleCapabilityChange` writes capabilities against `selectedConnectionId`
  (`App.jsx:204-211`) — which is now the *new* connection. A move finishing under connection A
  would stamp `upload: permitted` onto connection B (`App.jsx:941-943`). **Capability
  attribution corruption.**
- `MasterQueue` shows all tasks globally with no connection label
  (`MasterQueue.jsx:82-84`), so the user cannot tell which bucket a row belongs to.

### 2.2 The design: transfers survive, run in the background, bound to their origin

**Recommendation: a switch never blocks and never cancels in-flight work. Each task is tagged
with the connection it was launched under, and its side effects are routed to that connection —
which is a no-op when that connection is not the foreground one.**

Three mechanical requirements:

1. **Tag every task with its origin.** Extend the task factories
   (`queue-tasks.js:18-100`) so each task carries `connectionId` (and the full origin
   `{bucket, provider, endpoint}` — some already carry `bucket`; downloads must gain `endpoint`,
   see §3.3). This is the single enabling change; everything else keys off it.

2. **Route view-refresh side effects by origin, not by live ref.** The engine progress callbacks
   must ask "is my task's `connectionId` the foreground one?" before touching
   `browserActionsRef`/capabilities. When it is not:
   - `removeItems`/`invalidateCache` become **deferred cache invalidations** recorded against
     the origin, replayed when that connection next becomes foreground (its `Browser` remounts
     and re-lists anyway via `browserKey`, so in practice "record that this prefix is stale" is
     enough — and a full remount already invalidates everything, so the *simplest* correct
     implementation is: foreground → live refresh; background → nothing, because the eventual
     remount re-lists). **Boring wins here: background completion does no live DOM surgery; the
     next foreground visit re-lists from the network.**
   - capability writes go to the **task's** `connectionId` via
     `saveConnectionCapabilities(task.connectionId, …)` (`connections.js:426-432`), never to
     `selectedConnectionId`.

3. **Give the queue an origin label.** `MasterQueue` renders every task (keep that — hiding
   background work re-introduces the postmortem "invisible job" class, `App.jsx:616-618`). Add
   a per-row connection chip sourced from the task's `connectionId`. Optionally group by
   connection when >1 origin is present.

Under this design the answer to "do transfers survive a switch, run in background, or block it?"
is: **survive + background, never block.** The user switches to another bucket instantly; the
move/download/zip keeps running against its own pinned client; its row stays in the master queue
with the origin bucket named; on completion it refreshes the view only if the user is looking at
that bucket, otherwise silently, and the next visit re-lists.

### 2.3 The IndexedDB records are already origin-scoped — mostly

The durable job stores are **not** keyed by connection, but they carry origin fields and are
filtered at load time:

- **Move jobs** filter by *full origin* on connect: `j.bucket === credentials.bucket &&
  j.provider === … && j.endpoint === …` (`App.jsx:602`). Correct. The record stores
  `provider`+`endpoint` (`App.jsx:971`, `move-jobs.js` inline list).
- **Download jobs** filter by **bucket name only**: `j.bucket === credentials.bucket`
  (`App.jsx:621`), and the record stores only `bucket`+`provider`, **not endpoint**
  (`App.jsx:650-652`). This is a latent bug *today* and a correctness bug *the moment two
  accounts share a bucket name* (extremely common: `backups`, `media`, `assets`). See §3.3 —
  this must be fixed before multi-account ships, and it is the clearest "the proposer didn't
  mention it" landmine.

Items are keyed `<jobId>:<key>` (`indexeddb-core.js:38-42`), jobId is a UUID
(`App.jsx:648`), so items never collide across jobs/origins. No change needed there.

### 2.4 A blocking case that must stay blocking

One operation genuinely cannot be backgrounded across a switch: **an interactive
`showDirectoryPicker`/save-dialog handoff mid-flight.** Folder-verify and zip-export need a
directory handle obtained under a user gesture in the *foreground* (`App.jsx:661-666`,
`downloadApi.verify`). If a running job is awaiting the user's directory choice, switching away
should either (a) leave that job paused-for-input in the queue (preferred — matches the existing
"DONE, no exportedAt → save it again" recoverable state, `MasterQueue.jsx:50-52`), or (b) be
disallowed with a one-line explainer. Recommend (a): never trap the switch; convert the pending
interactive step into a resumable queue row.

---

## 3. Bucket decoupling — schema, migration, backward-compat

### 3.1 What "decouple bucket" actually means under the bipartite model (correcting prior art)

The v1.14.0 plan (`action-plan…:338`, `05-roadmap-ux.md:31,254`) predates the bipartite model.
It framed decoupling as "make `bucket` optional/nullable on the profile and store null."
**Given the current model, that framing is wrong.** The connection record *is* the
`(credential, bucket)` unit and should **keep** its bucket. What must change is narrower:

- **`bucket` becomes optional at *credential-entry* time**, not on the persisted connection.
  A user can save/connect an *account* (credential) without first naming a bucket.
- **Buckets become connections lazily**, via the same find-or-create idiom already proven for
  credentials: `findOrCreateConnection({credentialId, bucket})` mirrors
  `findOrCreateCredential` (`connections.js:244-260`). Picking a bucket under an account
  materializes (or re-selects) its `(credential, bucket)` connection.

This is strictly more boring than "nullable bucket everywhere": `Browser`/`UploadQueue` keep a
non-null `bucket` prop at all times (`App.jsx:1400,1431`), capabilities stay per-connection
(already correct, §3.4), and the 156-ref bucket coupling the heat map worried about
(`05-roadmap-ux.md:14-27`) never has to learn about null.

### 3.2 Exact schema deltas

**`connections.js` / connection record:** no shape change to a *saved* connection. Add one
constructor `findOrCreateConnection({credentialId, bucket, basePrefix})` alongside the existing
find-or-create (new function, not a schema field). `CONNECTIONS_VERSION` stays `2`
(`connections.js:50`).

**`storage.js` credential form path:** `bucket` in `CREDENTIAL_KEYS`
(`storage.js:24-31`, key `s3b_bucket`) becomes tolerated-empty. `saveCredentials` already
writes `''` happily (`storage.js:86-94`). `CredentialForm`'s required-bucket validation is the
real gate to relax (UX/frontend lane owns the form; this lane only asserts the storage layer
imposes no barrier — it doesn't).

**Runtime state in `App.jsx`:** introduce an explicit `activeBucket` derived value **only if**
the account-connect path is built. For single-bucket connections `activeBucket === connection.bucket`
at connect and nothing observable changes. For an account-connect, `activeBucket` is chosen
post-connect and drives `findOrCreateConnection`, after which the app is in the ordinary
"a connection is selected" state. Prefer *not* to thread a separate `activeBucket` prop
through Browser/UploadQueue — instead, selecting a bucket resolves to a connection and re-drives
the existing connect motion, so `credentials.bucket` remains the single source the props read
from (`App.jsx:1400,1431`). This keeps the Browser↔App contract byte-identical.

### 3.3 Download-job record: add `endpoint` (contract change, additive)

`startJob` records `{bucket, provider}` but not `endpoint` (`App.jsx:645-657`), and `listJobs`
filters on `bucket` alone (`App.jsx:621`). To make download jobs origin-safe across accounts:

- **Add** `endpoint` (and, recommended, `connectionId`) to the job record at creation
  (`App.jsx:648-657`).
- **Change** `listJobs`/`handleDownloadStart`/`handleZipStart`/`downloadApi.verify` bucket
  checks (`App.jsx:621,738,818,668`) from bucket-name equality to full-origin (or
  `connectionId`) equality — matching how move jobs already do it (`App.jsx:602`).
- **Migration:** legacy jobs lack `endpoint`/`connectionId`. Match them by `bucket`+`provider`
  as a fallback (what happens today), and surface them under the current connection only when
  provider matches. No IndexedDB version bump — the fields are additive and readers already
  tolerate absent counters (`App.jsx:626-635`). `DB_VERSION` stays `6` (`indexeddb-core.js:15`).

This is the one contract change with real consumers; §7 lists them.

### 3.4 Capabilities: already done, prior-art instruction now WRONG

v1.14.0 prereq #2 says "key `s3b_capabilities` by bucketName"
(`action-plan…:340`, `05-roadmap-ux.md:256`). **That instruction is stale and must not be
followed:** the global `s3b_capabilities` key was retired in v1.39.0
(`storage.js:54-59`) and capability state now lives **on each connection record**
(`connections.js:413-432`). Since a connection is `(credential, bucket)`, capabilities are
already per-bucket-per-account with zero cross-contamination — which is *better* than the
by-bucket-name map the prereq proposed (two accounts with the same bucket name would have
collided under the old plan). **Prereq #2 is DONE; the specific key-shape it prescribed is
obsolete.** The only residual: if a future lane lets one connection span buckets (rejected in
§3.1), capability-on-connection would break — another reason to keep bucket on the connection.

---

## 4. Contracts between App ↔ Browser ↔ UploadQueue ↔ MasterQueue

The runtime-changing-bucket concern touches four seams. Stated as promises with their migration
order (a consumer must never be broken mid-deploy):

| Seam | Today | Under the redesign | Break risk |
|---|---|---|---|
| **App → Browser** | `bucket`, `client`, `credentials`, `capabilities`, `onCapabilityChange` props; remount on `browserKey` (`App.jsx:1427-1444`) | Unchanged shape. `bucket` still non-null (§3.1). Switch = new client + `browserKey++` (existing motion). | Low — contract preserved by design. |
| **App → UploadQueue** | `client`, `bucket`, `provider`, `credentials`, `capabilities` (`App.jsx:1398-1415`) | Unchanged. An in-flight upload belongs to its launching connection; UploadQueue's own queue is not the master task store — confirm its transfers also pin their client (verify in the UploadQueue lane). | Medium — UploadQueue has its own queue not audited in this lane; flag for QA. |
| **App/engines → taskStore** | tasks carry `bucket`; no `connectionId`; store is a global singleton (`task-store.js`, `queue-tasks.js`) | tasks gain `connectionId` + full origin; capability writes routed by task origin (§2.2) | **This is the contract that changes.** Additive fields; old in-memory tasks don't survive reload anyway (the store is not persisted), so no migration — only the factories and the two callback sites (`App.jsx:551,936`). |
| **taskStore → MasterQueue** | renders all tasks, no origin label (`MasterQueue.jsx:82-104`) | renders all tasks + origin chip from `connectionId`; optional group-by-origin | Low — purely additive render; a task without `connectionId` (none, post-change) would just show no chip. |

**Migration order for the contract change (§4 row 3):** (1) add the fields to the factories
(readers tolerate their absence, so this is safe alone); (2) switch the two callback sites to
route by origin; (3) add the MasterQueue chip. Each step is independently shippable and never
leaves a consumer reading a field that isn't written.

---

## 5. Sequencing — shippable slices

Each slice is independently valuable, low-risk, and carries its own version bump + tests per
project discipline (`CLAUDE.md` — bump-every-code-change, tests-before-push). Ordered so no
slice depends on an unbuilt one.

**Slice 1 — Account grouping in the picker (UI projection, no schema).**
Group `listResolvedConnections()` by `credentialId` in `ProfilePicker` (`App.jsx:1273`,
`connections.js:290`). Renders the accounts→buckets tree from data that has existed since
v1.39.0. Zero data-model risk. Ships the "manager/tree" half of the target mental model on its
own. *Unblocked today.*

**Slice 2 — Origin-tag the task store + fix download-job origin filtering.**
Add `connectionId`+`endpoint` to task factories (`queue-tasks.js`) and to the download-job
record (`App.jsx:648`); route capability writes and view refreshes by task origin
(`App.jsx:551,936,204`); switch download-job filters to full-origin (`App.jsx:621,738,818,668`).
Fixes a *latent bug that exists today* (same-bucket-name cross-surfacing) and is the safety
prerequisite for any live switching. Add the MasterQueue origin chip. *Depends on nothing;
do it before Slice 3.*

**Slice 3 — Quick-switch tab bar (live switching, one client, background transfers).**
A tab strip over recently-used connections that drives `handleSelectProfile` → auto-connect,
reusing the `sessionStorage` secret when present and degrading to the credential form when not
(§1.3). Switching never blocks in-flight work (Slice 2 made that safe). This is the big one and
the make-or-break §2 design lands here. *Depends on Slice 2.*

**Slice 4 — Optional bucket at credential entry + lazy connection creation.**
Relax `CredentialForm` required-bucket; add `findOrCreateConnection`; on connecting an account
without a bucket, enter a bucket-selection step (ListBuckets if that lane green-lights it, else
manual bucket entry). Materializes `(credential, bucket)` connections on demand. *Depends on
Slice 1 for the tree UI; independent of the ListBuckets decision — degrades to manual entry.*

This ordering deliberately front-loads the two zero-new-dependency, bug-fixing slices (1 and 2)
and defers the two that depend on an open question (Slice 4 / ListBuckets) or carry the most UX
surface (Slice 3).

---

## 6. Reconcile prior art (v1.14.0 v2.0-prereqs)

| Prereq (`action-plan…:334-347`, `05-roadmap-ux.md:252-263`) | Verdict now |
|---|---|
| **#1 Decouple `bucket` from credential/profile; make it nullable; "single-bucket mode" migration** | **Right in spirit, wrong in mechanism.** The "non-empty bucket → single-bucket mode, no version bump" migration is exactly right and still holds. But "make bucket nullable on the persisted record" is superseded by the bipartite model: keep bucket on the connection, make it optional only at credential-entry, materialize buckets as connections lazily (§3.1). |
| **#2 Key `s3b_capabilities` by bucket name** | **DONE, and the prescribed shape is now WRONG.** Capabilities moved onto the connection record in v1.39.0 (`connections.js:413`, `storage.js:54-59`); per-`(credential,bucket)` is strictly better than the by-bucket-name map, which would have collided across accounts sharing a bucket name. Do not resurrect the retired key. |
| **#3 Extract hooks from `Browser.jsx`** | **Still valid, still not done for the general case.** `Browser.jsx` remains the heaviest component; any Slice-3 live-switch work that touches it inherits the risk the review flagged (`05-roadmap-ux.md:258`). Not a blocker for Slices 1–2; a real risk multiplier for anything mounting/altering Browser. |
| **#4 Responsive layout skeleton** | Out of this lane (UX/frontend). Tab bar (Slice 3) adds a new header surface that must be designed responsive from the start rather than retrofitted — flag to the UX lane. |
| **#5 Document the `file://` stance** | Still relevant: the id generator deliberately avoids `crypto.randomUUID` for `file://` (`connections.js:62-80`) — **but download jobs already use `crypto.randomUUID()` (`App.jsx:648`), so download-manager features are already `file://`-fragile.** Not introduced by this redesign; worth a gap note. |

**156-ref bucket heat map (`05-roadmap-ux.md:14-27`):** the counts were taken against the flat
profile model that the bipartite refactor has since replaced. The *structural* claim survives —
`bucket` is passed as a prop to `Browser`/`UploadQueue`, which is the right interface pattern
(`05-roadmap-ux.md:39`) — but the numbers are stale and should not be used to size the work.

**Recorded-decision honored:** GitLab #40 (declined admin/bucket-lifecycle console). This design
stays inside it — no ListBuckets *governance* (create/delete/policy); bucket *selection* for
browsing is not administration. The account "manager/tree" is a view over the user's own saved
connections, not a server-side account console. If Slice 4 adopts ListBuckets, that is discovery
(read), not administration — but it is the ListBuckets lane's call, and this design accommodates
either outcome (Slice 4 degrades to manual bucket entry).

**Gap worth filing:** there is no knowledge-repo decision record for the bipartite connection
model itself (it lives only in `connections.js` header comments). Before this redesign lands, a
short design record for "credential↔connection bipartite model + lazy bucket connections" should
be written so the *next* session doesn't re-derive it from prior art that is now two models out
of date.

---

## RECOMMENDATION

1. **One live client, one `Browser`, one `session` machine — describing the foreground tab
   only.** Tabs are a switch UI over saved connections, not N live sessions. Reject kept-alive
   multi-Browser panes (multiplies the codebase's heaviest component for sub-second latency).

2. **Transfers survive a switch, run in the background, never block it.** This exploits an
   existing property: the task store is a session-independent singleton
   (`task-store.js:82`) and engines pin their client at call time (`App.jsx:759,973`). The
   switch is safe *once tasks are attributed to their origin connection.*

3. **The single enabling change is origin-tagging.** Add `connectionId` + full origin
   `{bucket, provider, endpoint}` to every task (`queue-tasks.js`), route capability writes and
   view-refresh callbacks by the *task's* origin rather than the live `selectedConnectionId` /
   `browserActionsRef` (`App.jsx:204,551,936`). Background completions do no live DOM surgery;
   the next foreground visit re-lists (boring and correct).

4. **Fix the download-job origin filter before multi-account ships.** Download jobs filter by
   bucket *name* only and don't record `endpoint` (`App.jsx:621,650`), unlike move jobs which
   match full origin (`App.jsx:602`). Two accounts sharing a bucket name will cross-surface each
   other's downloads. Add `endpoint`/`connectionId` to the record; switch filters to full
   origin. Additive, no DB-version bump.

5. **Bucket stays on the connection; only credential-entry-time bucket becomes optional.**
   Materialize `(credential, bucket)` connections lazily via a `findOrCreateConnection` mirroring
   the proven `findOrCreateCredential` (`connections.js:244`). Keeps `Browser`/`UploadQueue`'s
   `bucket` prop non-null and their contract unchanged. Migration: existing connections = single-
   bucket mode, `CONNECTIONS_VERSION` unchanged. This corrects the v1.14.0 "nullable bucket"
   framing, which predates the bipartite model.

6. **Capabilities are already per-`(credential,bucket)` (v1.39.0) — v1.14.0 prereq #2 is DONE and
   its "key by bucket name" instruction is obsolete.** Do not resurrect `s3b_capabilities`.

7. **Ship in four slices, bug-fixers first:** (1) account grouping in the picker — pure UI
   projection, unblocked today; (2) origin-tag the task store + fix download-job filtering —
   fixes a latent bug and unlocks safe switching; (3) the quick-switch tab bar — the live-switch
   design of §2; (4) optional bucket + lazy connection creation — accommodates whatever the
   ListBuckets/vault lanes decide. Each slice: version bump + tests per project discipline.

8. **File the missing decision record** for the bipartite model + lazy bucket connections, so the
   next session stops planning against a two-models-stale prior art.
