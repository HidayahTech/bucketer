# Frontend Feasibility — Multi-Bucket + Account Management ("Both" model)

Lane: FRONTEND-FEASIBILITY. Design/assessment only — no source changes made. Repo state
reviewed at v1.55.0 (`package.json`), `dist/index.html` 760,220 bytes (build tripwire
`SIZE_LIMIT_BYTES = 1024*1024`, `build.mjs:217`).

Target per the brief: an accounts manager/tree **plus** a quick-switch tab-bar, both
backed by instant live switching between connections.

---

## 1. Multi-client / keep-alive cost

**What `createS3Client` actually allocates** (`src/lib/s3-client.js:7-29`): a plain
`new S3Client({ endpoint, region, credentials, forcePathStyle, requestChecksumCalculation })`.
No socket, no connection pool, no persistent handle — browser `fetch` is stateless per
call, so an `S3Client` instance is a config object plus the SDK's middleware stack
closures. **This is cheap.** Holding N `S3Client` instances (one per open connection/tab)
is a non-issue — tens of KB of JS objects at most, not a scaling concern even at N=20.

Note also: **`bucket` is destructured in `createS3Client`'s signature but never used in
its body.** The client is bucket-agnostic; `Bucket:` is supplied per-command by
`Browser.jsx`/`UploadQueue.jsx` at call time (confirmed by grep: every `Bucket: bucket`
site in both components reads a prop, not something baked into the client). This means:

- Switching **buckets under the same credential/endpoint** needs no new client at all —
  only a new `bucket` value flowing to the same `client`. This is the cheapest form of
  "switch" in scope and should be treated as structurally distinct from switching
  **accounts** (different endpoint/credential), which does need a new `S3Client`.
- The real cost of "keep tabs alive" is **not** the client — it's the mounted
  `Browser`/`UploadQueue` component trees: listing state (`items`, `commonPrefixes`),
  refs (`cacheRef`, per Browser.jsx:42-45 comment — "cacheRef and abortRef are Refs...to
  avoid triggering re-renders"), and DOM (one `<tr>` per listed object, uncapped by
  virtualization). `loadMaxKeys()` (`src/lib/storage.js:173`) bounds a single page, but
  a user who has paged through a large prefix can accumulate many pages in that
  `cacheRef`. For a handful of tabs (single digits) this is trivial; it is not
  unbounded-safe if the tab-bar allows unlimited pinned tabs against large buckets.

**Verdict: keep-alive is feasible**, with a cap. Recommendation: keep the *N most
recently used* tabs mounted-but-hidden (`hidden` attribute / hooked into the existing
Preact tree, not `display:none` via inline style per project CSS conventions), tear down
anything beyond a small cap (propose 6-8, matching typical browser tab-bar UX
expectations, not a hard technical ceiling). Full re-mount (current `browserKey`
increment pattern) remains correct for **switching connection** (different credential),
since that is not a "live-tabs" case in the same sense — see §2.

**Is teardown-and-rebuild fast enough to feel instant?** No, not for *first* activation
of an evicted/never-opened tab — that requires a fresh `ListObjectsV2` round trip
(network-latency dependent, typically 100-500ms against most S3-compatible providers,
worse on high-RTT connections). This directly conflicts with "instant live switching" if
switching always means a full remount. **The tab-bar's "instant" promise is only
deliverable for tabs kept warm** (§1's keep-alive pool); switching into a cold/evicted
tab should show the existing `listing` spinner state (`Browser.jsx` already has this)
rather than pretend to be instant. This is a UX-contract clarification the design lane
should confirm, not purely an engineering constraint.

---

## 2. Runtime bucket selection

Today `bucket` originates at exactly one place: `credentials.bucket`, read at
`App.jsx:1400` (`<UploadQueue bucket={credentials.bucket} .../>`) and `App.jsx:1431`
(`<Browser bucket={credentials.bucket} .../>`). It is *not* baked into `client` (§1), so
lifting it to a runtime selection is a **prop-origin change, not a data-flow redesign**.
Concretely, what has to change:

1. **New App-level state**: a `selectedBucket` (or equivalent) distinct from
   `credentials.bucket`. `credentials.bucket` remains the *connection's stored/default*
   bucket (unchanged shape — no profile-schema migration needed, unlike the old v1.14.0
   roadmap assessment which assumed bucket was still credential-mandatory; today it's
   already a per-*connection* field, see `connections.js` — `saveConnectionRecord`
   accepts `bucket` on the connection record directly, not the shared credential).
   `selectedBucket` seeds from `credentials.bucket` on connect/switch and is what
   actually flows to `Browser`/`UploadQueue`.
2. **Prop origin at `App.jsx:1400` and `:1431`**: change `bucket={credentials.bucket}`
   to `bucket={selectedBucket}` in both places. `UploadQueue`'s `currentPrefix` prop
   (`App.jsx:1402`, fed by `onUploadTargetChange={setCurrentPrefix}` from `Browser`,
   `App.jsx:1437`) is bucket-scoped already only in the sense that it's whatever prefix
   `Browser` is currently looking at — it does not itself need bucket-awareness beyond
   riding the same `selectedBucket`.
3. **`browserKey` remount semantics under a bucket switch**: `browserKey` today means
   "reconnect happened, discard the listing cache" (`App.jsx` top comment, lines 18-20).
   A same-credential bucket switch is a *different kind of invalidation* — the client
   and capabilities-per-connection state are still valid, only the object listing is
   stale. Reusing `browserKey` for this works mechanically (increment forces remount →
   fresh `ListObjectsV2`) but conflates two semantically different events under one
   counter. If tabs are kept warm (§1), a bucket switch inside one already-open tab
   should NOT force a remount of *other* tabs — so `browserKey` as a single App-global
   counter is the wrong shape for a multi-tab world; it needs to become **per-tab**
   (keyed by connection+bucket identity), not a single incrementing int.
4. **Listing-cache invalidation**: `Browser`'s `cacheRef` is presently populated per
   mount and discarded on unmount/remount. With bucket now a runtime prop rather than a
   remount trigger, cache keys inside `Browser` (e.g. `` `${bucket}:${Key}:${lastModifiedMs}` ``
   used for the file-mtime cache, `Browser.jsx:221`) already correctly namespace by
   `bucket`, which is promising — but the *listing* cache itself (`items`,
   `commonPrefixes`, `continuationToken`) is prefix-keyed, not bucket-keyed, and is
   reset via the `useEffect` at `Browser.jsx:172-177` ("Reset file-mtime state when the
   user switches buckets" — note this effect *already exists* and depends on `[bucket]`,
   confirming Browser was written expecting `bucket` to someday change under it without
   a remount). **The listing state itself still needs an equivalent bucket-keyed reset
   effect** — currently there isn't one for `items`/`commonPrefixes`, because until now
   `bucket` never changed without a full remount. This is a small, well-precedented
   addition (mirror the existing mtime-reset effect shape).
5. **Capability state**: already keyed per-*connection* (`loadConnectionCapabilities(id)`
   / `saveConnectionCapabilities(id, ...)`, `connections.js:419-433`, called from
   `App.jsx:143-146`, `1038`). Since a connection already includes `bucket`, this is
   already correctly scoped for the "one connection = one bucket" case. **It is not yet
   scoped for "multiple buckets under one connection browsed via runtime selection"** —
   if a single saved connection can now browse buckets other than its stored `bucket`
   field (e.g. via a bucket picker inside an open tab, not just via distinct saved
   connections), capabilities need a second keying dimension
   (`connectionId` × `bucket`), not just `connectionId`. Whether that mode is in scope
   depends on the accounts-manager design (does "switch bucket" always mean "switch to a
   different saved connection," or can one connection browse arbitrary buckets its
   credential can reach?) — this is a product decision this lane can't resolve, but
   it materially changes the effort of this item (small if bucket stays 1:1 with
   connection identity; moderate if not).

**Net assessment**: the mechanical plumbing (prop origin, cache namespacing) is
small-to-moderate. The `browserKey` semantics collision (per-connection vs. per-tab) is
the one piece that needs an actual design decision before coding, not just typing.

---

## 3. State-management home

App.jsx is 1,547 lines and already the single largest state owner in the app (session,
credentials, client, capabilities, connections list, all modal-open flags, vault-offer
flow, download/move/delete request plumbing). It already delegates two slices out via
plain-hook extraction: `useModalStates.js` (32 lines, 5 modal-open booleans) and
`useWindowDragDrop.js` (74 lines). This is the established, and only, pattern in this
codebase for shrinking App.jsx — there is no context/state-library precedent to draw on
(project constraint: plain Preact hooks only), and this fleet's convention (per
`CLAUDE.md` §3) is to match that, not introduce one.

Proposed split, following the existing convention exactly (a `use*` hook per concern,
same as `useModalStates`/`useWindowDragDrop`, living in `src/hooks/`):

- **`useConnections.js`** — owns `connections`, `selectedConnectionId`,
  `handleSelectProfile`, `handleSaveProfile`, `handleDeleteProfile` (currently
  `App.jsx:1033-1140`). This is a clean lift: these five things already form one
  cohesive concern and touch no other App state directly except `credentials`/
  `liveFormData`/`capabilities`, which can be passed in as setters.
- **`useConnectionTabs.js`** (new) — the actual multi-bucket/multi-account addition:
  owns the *set* of live/warm connections (§1's keep-alive pool), which tab is active,
  per-tab `client`/`capabilities`/`selectedBucket`, and the eviction policy. This
  hook is where `client`/`capabilities`/`browserKey`'s replacement (per-tab identity,
  §2 point 3) belongs — today those are flat `useState` calls in App.jsx
  (`App.jsx:141-148`); under "both" they become entries in a map/array this hook owns.
  This is new state shape, not an extraction of existing code, and is the piece with
  actual design risk (getting the tab-identity key and LRU eviction right).
- **Module-level pub-sub for cross-cutting concerns, matching `task-store.js`'s
  pattern** (not a hook) if any part of the new surface needs to be read from
  *outside* the component tree without prop drilling — e.g. if `MasterQueue.jsx`
  (currently bucket/client-agnostic by design: it reads only `taskStore`, confirmed —
  no `bucket` or `client` references anywhere in `MasterQueue.jsx`) needs to label
  tasks by which account/bucket they belong to for a multi-account queue view. This
  is a real finding worth flagging: **task engines already capture `client`/`bucket`
  by JS closure at the moment the task is created** (e.g. `handleDeleteConfirm`,
  `App.jsx:543-575`, calls `runDeleteOperation(client, task.bucket, task, ...)` where
  `client`/`credentials.bucket` are whatever App's *own* closure held at invocation
  time). Because Preact state is immutable per render, an in-flight operation is
  **already immune to the user switching connections mid-run** — it keeps running
  against the client it was started with. This is good news for the "operations must
  survive switching" requirement and needs no new work; it only becomes a real
  problem once a *new* operation must be started **against a tab that is not the
  active one** (background tab action), which requires that tab's own client to be
  reachable from wherever the action originates — motivating the `useConnectionTabs`
  hook being the source of truth for per-tab clients, not just App's single `client`.

App.jsx after this split still owns: session state machine, vault flow, credential
form wiring, download/move/delete request orchestration, and render. That's still a
large file, but the multi-bucket-specific growth is contained in the two new hooks
rather than added inline to the existing 1,547 lines.

---

## 4. Component decomposition prereqs

The prior "extract hooks from `Browser.jsx` first" advice (`docs/review-v1.14.0/05-roadmap-ux.md`
item 3 under "v2.0 Prerequisites") was written against a 1,326-line, 33-`useState`
Browser.jsx. Today's `Browser.jsx` is 1,408 lines with **65 hook call sites** (`useState`/
`useEffect`/`useCallback`/`useRef`/`useMemo` combined) — it has grown, not shrunk, though
one extraction has already happened: `usePreview(client, bucket)` (`src/lib/usePreview.js`,
173 lines) was pulled out and is consumed at `Browser.jsx:75-82`. Notably it already
takes `bucket` as a parameter rather than closing over a module-level value — i.e. the
one hook extraction that exists is already written in a bucket-as-runtime-value shape,
which is a good sign for §2's plumbing (no rework needed there) but also means it's the
*only* piece of Browser.jsx proven to survive a runtime-changing `bucket` without
surprise.

**Is the prereq still warranted? Yes, more so than in the v1.14.0 assessment**, for a
different reason than before. The old rationale was generic maintainability. The
concrete new rationale: §1's keep-alive design needs *N* `Browser` instances mounted
simultaneously (one per warm tab), each independently re-rendering on its own state
changes. A 1,408-line component with 65 hook sites, most of them `useState` (meaning
Preact must diff a large state object graph per instance, per render) multiplies real
work by N tabs. It doesn't have to be fully modularized before multi-bucket ships, but
**the delete/rename/preview/drag-drop slices are the load-bearing candidates to extract
before adding tab-multiplexing**, not after — extracting them after N instances already
exist means debugging the extraction against N live copies instead of one, which is
strictly worse. Preview is already done. Rename (`renamingKey`/`renameValue`/
`renameError`/`renameSaving`, `Browser.jsx:93-96`) and new-folder
(`newFolderOpen`/`newFolderName`/`newFolderError`/`newFolderSaving`, :97-100) are the
next cleanest lifts — each is a self-contained 4-state-variable cluster with no
cross-dependency on the listing/selection state, following the same shape `usePreview`
already proved out.

**Scope call**: this is a *should-precede*, not a hard blocker for the accounts-manager
half of the work (§6 build order reflects this — the manager/tab-bar chrome and the
runtime-bucket-selection plumbing in §2 can land before Browser.jsx decomposition;
keep-alive/multi-mount should not).

---

## 5. Bundle / deps

**Zero new runtime deps are needed for anything in §1-4.** Tab-bar UI, an accounts-tree
panel, per-tab state, and bucket-as-runtime-prop are all buildable in vanilla
Preact/CSS — no virtualized-list library, no state-management package, no tabs
component library needed given the project's existing hand-rolled component style
(Modal.jsx, Breadcrumb.jsx, etc. are all plain Preact).

**Bundle-size risk**: real but bounded. Current `dist/index.html` is 760,220 bytes
raw against a 1,048,576-byte (1 MB) build tripwire (`build.mjs:217`) — **~288 KB of
headroom (~28%)**. GitLab #41 (open, `priority::low`, "Bundle size optimization pass")
notes the tripwire was deliberately raised from 600 KB to 1 MB specifically to stop
blocking feature growth, and that the served (gzip/brotli) size is ~150-170 KB over the
wire versus the raw figure — the tripwire measures raw bytes, so headroom should be read
conservatively (raw, not wire). A new accounts-manager panel + tab-bar (markup, CSS, a
few hundred lines of hook logic) is a small fraction of that headroom — low risk in
isolation. The compounding risk is **this landing alongside other roadmap items that
also grow the bundle** (mobile responsive pass, UI refresh, dedup iteration 2, etc., all
listed as open backlog) — none individually alarming, but #41's own scope item ("dependency-weight
audit — which `@aws-sdk/*` modules dominate") is the actual lever if headroom gets tight,
not blocking this feature. **Recommendation: no bundle action required to start this
work; re-check raw size against the tripwire after the first landed increment (accounts
manager + tab-bar chrome) before starting the keep-alive/multi-mount phase**, since that
phase is the one most likely to add non-trivial JS (per-tab lifecycle/eviction logic).

---

## 6. Feasibility verdict + rough sequence

| Element | Verdict | Why |
|---|---|---|
| Bucket picker / runtime bucket selection (same connection) | **Easy** | `bucket` already flows as a prop, not baked into the client (§1, §2); needs a new App/hook-level `selectedBucket` state, prop-origin swap at two call sites, and one new bucket-keyed reset effect in Browser.jsx mirroring the existing mtime-reset effect. |
| Accounts manager (tree/list of saved connections, CRUD) | **Easy-Moderate** | Almost entirely already built: `connections.js` (454 lines) is a complete bipartite credential/connection CRUD layer; `ProfilePicker.jsx` is an existing (if splash-screen-scoped) selector UI. Moderate, not Easy, because the manager needs a *persistent, always-reachable* UI surface (not gated to the disconnected splash, per `feedback-trust-checks-pre-auth` memory precedent about not gating things behind places users don't visit) — that's new chrome, not new data plumbing. |
| Quick-switch tab-bar (cold switch — remount per tab) | **Easy-Moderate** | Mechanically close to today's `browserKey` remount pattern, generalized from a single global counter to a per-tab identity (§2 point 3). The design risk is entirely in getting tab identity/eviction right, not the remount mechanism itself, which already exists and works. |
| Live keep-alive (warm tabs, instant switch, no refetch) | **Moderate-Hard** | Client cost is negligible (§1) but requires: Browser.jsx decomposition first-ish (§4) to make N-simultaneous-mounts tractable; a genuinely new `useConnectionTabs` hook with real design work (LRU cap, per-tab client/capabilities map); and an honest UX contract that "instant" only holds for tabs already warm, not cold ones (§1) — that's a product-facing nuance the design lane needs to bless, not just an engineering task. |
| Capability-state correctness across bucket switches | **Easy** (if bucket stays 1:1 with saved connection) / **Moderate** (if one connection can browse arbitrary buckets at runtime) | Already keyed per-connection today; the swing factor is a product decision this lane flagged in §2 point 5, not an engineering unknown. |

**Suggested build order** (each step independently shippable/bumpable per repo
convention, not one big branch):

1. Runtime bucket selection plumbing (§2) — smallest, self-contained, immediately
   valuable even without the rest of the redesign (lets one connection browse >1
   bucket today).
2. Accounts-manager UI surface, built on the already-complete `connections.js` CRUD
   layer (§6 row 2) — no new data model, just new persistent chrome.
3. Browser.jsx decomposition pass (§4: rename + new-folder extraction, following the
   `usePreview` precedent) — done *before* step 4, not after.
4. Tab-bar as cold-switch (remount-per-tab, generalized `browserKey`) — ships a
   real, honest "switch accounts/buckets" UX without yet promising instant warm
   switching.
5. Keep-alive/warm-tab pool (`useConnectionTabs`, LRU cap) — the genuinely new,
   highest-design-risk piece; do last, once 1-4 have proven the runtime-bucket and
   per-tab-identity plumbing under real use.

---

## RECOMMENDATION

Multi-bucket + account management is **feasible entirely within the existing stack** —
zero new runtime dependencies, no framework change, and the codebase already has more
of the needed shape than the last (v1.14.0-era) roadmap review assumed: `bucket` is
**not** baked into the S3 client (only ever a per-command `Bucket:` param), the
credential/connection model is **already bipartite** with `bucket` living on the
connection record (not the shared credential) and capabilities already keyed per
connection, and one hook (`usePreview`) is already written in a bucket-as-runtime-prop
shape that proves the pattern works. The old "decouple bucket from credentials" v2.0
prerequisite is **substantially already done**.

The real remaining work splits cleanly into a cheap tier and an expensive tier. Cheap:
runtime bucket selection under one connection, and an accounts-manager surface built on
the existing CRUD layer — both mechanical, low-risk, no design-time unknowns. Expensive:
true instant live-switching via warm/kept-alive tabs — not because holding multiple
`S3Client`s or making multiple `ListObjectsV2` calls is costly (it isn't), but because
Browser.jsx is a 1,408-line, 65-hook-site component that was never built to be
instantiated N times concurrently, and because "instant" is a UX promise the engineering
can only honor for tabs already warmed, not cold ones — that distinction needs to be a
blessed part of the design, not discovered during implementation.

**Sequence this as cold-switch-first, warm-switch-second.** Ship runtime bucket
selection, the accounts manager, and a remount-based tab-bar as an honest, complete
version of "both" — this alone is a large usability win over the current single-active-
connection model and needs no Browser.jsx surgery. Treat the keep-alive/instant-switch
layer as a distinct follow-up phase gated on a Browser.jsx decomposition pass (rename +
new-folder extraction at minimum, following the `usePreview` precedent already in the
codebase) — do that decomposition *before* multi-mounting, not after, or the extraction
work has to be debugged against N live tab instances instead of one.

Bundle size is not a blocker (~28% raw headroom against the 1 MB tripwire, GitLab #41
tracks the long-term compressed-size/dependency-audit follow-up) but should be
re-checked after the cold-switch phase lands, before starting the warm-tab phase, since
that phase is the one most likely to add non-trivial JS.

One open product question this lane cannot resolve and flags upstream: **can a single
saved connection browse buckets other than the one stored on its connection record, or
does "switch bucket" always mean "switch to a different saved connection"?** This
determines whether capability-state keying needs a second dimension (§2 point 5) and
materially changes that item's effort from Easy to Moderate — worth pinning down before
implementation starts, not during.
