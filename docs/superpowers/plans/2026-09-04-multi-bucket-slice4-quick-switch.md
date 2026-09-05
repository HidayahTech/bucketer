# Slice 4 — Quick-Switch & Origin-Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a connected user switch buckets/accounts without going through the splash — instantly when the secret is already held this session, via an inline prompt otherwise — while in-flight transfers keep running, labeled by the origin they belong to.

**Architecture:** Keep ONE live client + ONE Browser (the foreground tab); a header MRU tab-strip and the sidebar accounts tree drive the existing `handleSelectProfile → connect` motion. Secrets for connections used this session are held in an in-memory map (keyed by credentialId) so a switch back doesn't re-prompt; the active secret still lives in sessionStorage for reload-survival. Every task is tagged with its origin (`connectionId` + `{bucket, provider, endpoint}`) so a background transfer's callbacks route to *its* connection, never the foreground one.

**Tech Stack:** Preact + hooks (no state library), esbuild single-file build, `node --test`, jsdom component tests, container Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-04-multi-bucket-account-management-design.md` (§5.1, §5.3–5.5, §9 Phase A, §10). This plan implements that spec's Slice 4 under the operator-confirmed **1:1 model** (switch = saved connection).

## Global Constraints

- No new runtime dependencies. Single self-contained `dist/index.html`.
- Secret key never written to `localStorage`; in-memory + `sessionStorage` (active only) only.
- Every source change: version bump (`npm version <x.y.z> --no-git-tag-version`) + `CHANGELOG.md` top entry matching, `npm run build` committed (dist + `src/lib/changelog.js`), pre-push hook runs build+test+tag.
- **ALWAYS run `npm run test:e2e:container` (full matrix) before pushing any phase.** Never "let CI gate it."
- Vocabulary: user-facing "account"/"bucket"; retire "profile".
- TDD: no production code without a failing test first.

---

## Phase A — De-dup saved buckets (ship as v1.57.1, patch/fix)

Deferred from Slice 3. Now reachable: "+ bucket" lets a user re-add a bucket already saved under an account, which today creates a **duplicate row**. Fix: when saving a bucket that isn't the currently-selected connection, reuse an existing same-origin connection instead of minting a new id.

### Task A1: handleSaveProfile de-dups by (credential, bucket, base folder)

**Files:**
- Modify: `src/components/App.jsx` — `handleSaveProfile` (currently ~1044-1130; the `existing`/`id`/`cred` computation near the top).
- Test: `test/components/app.test.jsx`.

**Interfaces:**
- Consumes: `findOrCreateCredential`, `listResolvedConnections`, `normalizeBasePrefix` (already imported).
- Produces: no new exports; behavior change only.

- [ ] **Step 1 — failing test.** In `app.test.jsx`, add a describe "App — re-adding a saved bucket does not duplicate it": set up one credential + one connection (bucket `photos`) in localStorage (as in the "+ bucket" test). Mount App. Click `.account-add-bucket`, `setInput('#cred-bucket','photos')`, click `.bucket-save-trigger`, submit `.bucket-save-form` (name defaults). Assert `JSON.parse(localStorage.s3b_connections).connections.length === 1`.

```jsx
test('re-adding an existing bucket under an account updates in place, not a duplicate', () => {
  clearAppStorage();
  localStorage.setItem('s3b_credentials', JSON.stringify({ version: 1, credentials: [
    { id: 'credA', endpoint: 'https://s3.us-west-002.backblazeb2.com', keyId: 'K1', provider: 'b2', regionOverride: 'us-west-002', label: 'B2 — K1' }] }));
  localStorage.setItem('s3b_connections', JSON.stringify({ version: 2, connections: [
    { id: 1, name: 'B2 — photos', credentialId: 'credA', bucket: 'photos', capabilities: null }] }));
  localStorage.setItem('s3b_connections_migrated', '1');
  const { query, cleanup } = mount(h(App, {}));
  try {
    fire(query('.account-add-bucket'), 'click');
    setInput(query('#cred-bucket'), 'photos');
    setInput(query('#cred-secretkey'), 'sekret');
    fire(query('.bucket-save-trigger'), 'click');
    fire(query('.bucket-save-form button[type="submit"]'), 'click');
    const { connections } = JSON.parse(localStorage.getItem('s3b_connections'));
    assert.equal(connections.length, 1, 're-adding the same bucket must not create a duplicate connection');
  } finally { cleanup(); clearAppStorage(); }
});
```

- [ ] **Step 2 — run, expect FAIL** (`connections.length === 2`). `node --test --loader ./test/helpers/jsx-loader.mjs test/components/app.test.jsx`.

- [ ] **Step 3 — implement.** In `handleSaveProfile`, reorder so `trimmedBucket`, `cred` (findOrCreateCredential), and `basePrefix` are computed BEFORE `existing`, then widen `existing`:

```jsx
const trimmedBucket = (liveFormData.bucket || '').trim();
const basePrefix = normalizeBasePrefix(liveFormData.basePrefix);
const cred = findOrCreateCredential({ endpoint: ep, keyId: (liveFormData.keyId || '').trim(), provider, regionOverride: (liveFormData.regionOverride || '').trim() });
// Update in place for the selected connection, OR an already-saved bucket on this exact
// account+base folder (the "+ bucket" re-add path) — otherwise a fresh row.
const existing = selectedConnectionId
  ? connections.find(c => c.id === selectedConnectionId)
  : listResolvedConnections().find(c =>
      c.credentialId === cred.id && c.bucket === trimmedBucket && (c.basePrefix || '') === basePrefix);
const id = existing ? existing.id : Date.now();
```
Delete the now-duplicated later `const cred = …` / `const trimmedBucket = …` lines. Everything downstream (`conn`, capabilities, read-back `creds`) is unchanged.

- [ ] **Step 4 — run, expect PASS**, and run the whole `app.test.jsx` + `npm test` to confirm no regression to the existing handleSaveProfile tests (trimming, capabilities, localStorage-throw).

- [ ] **Step 5 — ship v1.57.1.** CHANGELOG entry (fix), `npm version 1.57.1 --no-git-tag-version`, `npm run build`, **container e2e matrix (all 10 lanes)**, commit + push.

---

## Phase B — Quick-switch (ship as v1.58.0, minor/feature)

One coherent feature: switch buckets/accounts from the header or sidebar without the splash, with in-session secret retention and origin-safe background transfers. Built bottom-up: secret cache → origin tags → callback routing → tab-bar → switch wiring → sidebar mount → rename.

### Task B1: In-memory secret cache

**Files:**
- Create: `src/lib/secret-cache.js`
- Test: `test/secret-cache.test.js`

**Interfaces:**
- Produces: `cacheSecret(credentialId, secret)`, `getCachedSecret(credentialId) → string|null`, `forgetCachedSecret(credentialId)`, `clearSecretCache()`. A module-level `Map`, NOT persisted. Never stores empty/nullish secrets.

- [ ] **Step 1 — failing tests** (`test/secret-cache.test.js`): caching then getting returns the secret; getting an unknown id returns null; caching an empty string does NOT store (get returns null); forget removes one; clear empties all.
- [ ] **Step 2 — run, expect FAIL** (module missing).
- [ ] **Step 3 — implement** a `Map`-backed module; `cacheSecret` ignores falsy secrets; `getCachedSecret` returns `map.get(id) ?? null`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** (no version bump yet; Phase B ships as one version at B7).

### Task B2: Origin fields on task factories

**Files:**
- Modify: `src/lib/queue-tasks.js` — `createDeleteTask`, `createTransferTask`, `createDownloadTask`, `createResumableMoveTask`.
- Test: `test/queue-tasks.test.js`.

**Interfaces:**
- Produces: each factory accepts and returns `connectionId`, `provider`, `endpoint` (alongside the existing `bucket`). `createResumableMoveTask` reads `provider`/`endpoint` from the record and `connectionId` from `record.connectionId ?? null`.

- [ ] **Step 1 — failing tests**: each factory, given `{…, connectionId:'c1', provider:'b2', endpoint:'https://e'}`, returns a task carrying those three fields.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement**: add the three params to each factory signature and spread them into the returned object (mirror how `bucket` is already threaded).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit.**

### Task B3: Populate origin at every task-creation site

**Files:**
- Modify: `src/components/App.jsx` — every `create*Task({…})` call (`handleDeleteConfirm` ~547, `handleMoveRequest` transfer task, `handleDownloadStart` ~753, `handleZipStart`, and `createResumableMoveTask` at ~606 — the record already has provider/endpoint; add `connectionId: selectedConnectionId` to the record path where available).
- Test: covered structurally + by B4's routing tests; add a `source-invariants` check that no `create*Task(` call in App.jsx omits `connectionId`.

**Interfaces:**
- Consumes: `selectedConnectionId`, `credentials.provider`, `credentials.endpoint`.

- [ ] **Step 1 — failing test** (`source-invariants.test.js`): every `createDeleteTask(`/`createTransferTask(`/`createDownloadTask(` call in App.jsx source includes `connectionId`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement**: add `connectionId: selectedConnectionId, provider: credentials.provider, endpoint: credentials.endpoint` to each call.
- [ ] **Step 4 — run, expect PASS** + `npm test`.
- [ ] **Step 5 — commit.**

### Task B4: Route capability writes & view-refresh by task origin

**Files:**
- Modify: `src/components/App.jsx` — the delete callback (~550-568), move progress callback (~936), and `handleCapabilityChange` (~204) so they act on the **task's** connectionId, not live `selectedConnectionId`, and skip `browserActionsRef` refreshes when the task is not the foreground one.
- Test: `test/components/app.test.jsx` (a delete task tagged with a non-foreground connectionId writes capabilities to THAT connection, and does not call the foreground Browser's removeItems).

**Interfaces:**
- Produces: a helper `applyCapabilityForTask(task, op, state)` that writes to `saveConnectionCapabilities(task.connectionId, …)` and only updates the live `capabilities` state when `task.connectionId === selectedConnectionId`.

- [ ] **Step 1 — failing test**: create a delete via the engine mock with a task whose `connectionId` ≠ the selected one; assert `loadConnectionCapabilities(otherId).delete === 'permitted'` and the live capability state for the selected connection is untouched. (Test at the App level, or extract the routing into a pure helper and unit-test that helper — prefer the pure helper for a clean RED.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the routing guard. Today `task.connectionId === selectedConnectionId` always, so live behavior is unchanged; the guard becomes load-bearing under B6.
- [ ] **Step 4 — run, expect PASS** + `npm test` + `npm run test:ui`.
- [ ] **Step 5 — commit.**

### Task B5: MasterQueue origin chip

**Files:**
- Modify: `src/components/MasterQueue.jsx` — task row header (~199-205), add a `queue-op-origin` chip from `task.bucket`.
- Modify: `src/styles/main.css` — `.queue-op-origin` style.
- Test: `test/components/master-queue-*.test.jsx` (or the main master-queue test) — a task with `bucket:'photos'` renders a chip containing "photos".

- [ ] **Step 1 — failing test.**
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the chip (render `task.bucket` in a `<span class="queue-op-origin">`).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit.**

### Task B6: Header MRU tab-strip + switch flow + sidebar mount + secret retention

**Files:**
- Create: `src/hooks/useConnectionTabs.js` — owns the MRU list (recent connectionIds) + active id; derived from the connections list, capped ~6.
- Create: `src/components/ConnectionTabs.jsx` — the header strip (provider · bucket per tab, active accent, overflow "⊕ Switch…").
- Modify: `src/components/App.jsx` — on connect, `cacheSecret(cred.id, secret)`; a `switchToConnection(id)` that recalls the cached secret and, if present, connects instantly (re-derives the FULL `{endpoint,region,provider,bucket,secret}` atomically from the target connection and asserts the recalled secret's credentialId matches — spec §9), else lands on an inline secret prompt; mount `ConnectionTabs` in the header and `AccountsManager` in the sidebar drawer (wire onSelect → switchToConnection).
- Test: `test/components/connection-tabs.test.jsx` + `test/components/app.test.jsx` (switch flow: with a cached secret, clicking a tab connects without showing the splash form; without one, an inline secret field appears).

- [ ] **Step 1 — failing tests** (component: ConnectionTabs renders recents, click calls onSwitch; App: switch-with-cached-secret goes straight to connected).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the hook, component, and App wiring. Reuse the existing `handleSelectProfile` + `handleConnect` motion; the tab bar only chooses the target and supplies the cached secret. Rename the header "Disconnect" button to "Sign out" (leave-the-app), distinct from switching.
- [ ] **Step 4 — run, expect PASS** + `npm test` + `npm run test:ui`.
- [ ] **Step 5 — commit.**

### Task B7: Ship v1.58.0

- [ ] CHANGELOG entry (feature): quick-switch between buckets/accounts + origin-labeled background transfers + "Sign out".
- [ ] `npm version 1.58.0 --no-git-tag-version`; `npm run build`.
- [ ] **Container e2e matrix — all 10 lanes.** Add/confirm an e2e observable: a download/move started under one connection continues to completion after switching to another (the spec's "one observable per feature": a transfer survives a switch). If the harness cannot drive a two-connection switch, state "no e2e coverage: harness cannot represent an in-session connection switch" and rely on the unit/component routing tests.
- [ ] Commit + push.

---

## Self-Review

**Spec coverage:** §5.5 origin-tagging → B2/B3/B4; MasterQueue chip → B5; §5.3–5.4 tab-strip + switch flow → B6; §9 Phase A in-memory secret + switch-boundary binding → B1/B6; §10 "Disconnect" rename + sidebar mount → B6; §6 de-dup → A1. `findOrCreateConnection` as a named export is intentionally NOT built — under 1:1 + inline de-dup (A1) nothing consumes it; recorded here so a reader doesn't think it was missed.

**Placeholder scan:** none — every task has concrete files, code, and a runnable command. B4/B6 name a pure helper to keep RED clean.

**Type consistency:** `cacheSecret`/`getCachedSecret`/`forgetCachedSecret`/`clearSecretCache` (B1) used verbatim in B6; task origin fields `connectionId`/`provider`/`endpoint` (B2) populated in B3, read in B4/B5.

**Scope:** Phase A and Phase B each produce a shipped, tested version. Phase B is one feature; its tasks are sequential (B1→B6) because each consumes the prior. Warm keep-alive tabs and the vault (Slice 5 / Phase B-vault) remain out of scope.
