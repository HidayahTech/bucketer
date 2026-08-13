# Prefix-Scoped Access Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connection-level optional Base folder (`basePrefix`) so prefix-scoped access keys (B2 namePrefix first) can connect and work via the normal screen and shared links.

**Architecture:** One pure helper module (`base-prefix.js`) provides normalize/floor primitives; `basePrefix` is stored on the connection record + flat credential mirror; `Browser.navigateTo()` is the single clamp choke point; Breadcrumb/MovePicker/Duplicates/UploadQueue get floor awareness; share links carry `basePrefix`; the e2e mock gains a `scopePrefix` standing constraint.

**Tech Stack:** Preact, AWS SDK v3, node --test, jsdom component tests, Playwright container e2e.

**Spec:** docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md

## Global Constraints

- Prefix contract everywhere: `''` = unscoped; non-empty prefixes end in `/`.
- `clampToFloor(x, '')` must be identity — unscoped behavior byte-for-byte unchanged; all existing tests pass unmodified.
- UI label: `Base folder`; internal + hash param name: `basePrefix`; mock config: `scopePrefix`.
- Unit/component tests per task; `npm test` and `npm run test:ui` green at every commit.
- No edits to `handleConnect`'s capability reset block (App.jsx ~215–235).
- Version: 1.50.0, CHANGELOG entry in bump commit with rebuilt dist + changelog.js.

---

### Task 1: `src/lib/base-prefix.js` helper module

**Files:** Create `src/lib/base-prefix.js`, `test/base-prefix.test.js`

**Produces:** `normalizeBasePrefix(raw) -> string`, `withinFloor(prefix, floor) -> bool`, `clampToFloor(prefix, floor) -> string`

- [ ] Failing tests: normalize (`'team/alice'`→`'team/alice/'`, `'/team//alice/'`→`'team/alice/'`, `'  '`→`''`, idempotent); withinFloor (`('', '')`→true, `('ab/', 'a/')`→false, `('a/b/', 'a/')`→true); clampToFloor identity on empty floor for all inputs, substitutes floor when outside.
- [ ] Implement; run `node --test test/base-prefix.test.js`; commit.

### Task 2: validation rule

**Files:** Modify `src/lib/credential-validation.js`; extend `test/credential-form-validation.test.js`

**Produces:** `credentialErrors` may return `{ basePrefix: 'Base folder can't contain ".." — use a plain folder path like team/alice/.' }` on `..` segment or `\`; empty/normal values → no error; leading `/` is NOT an error (normalized later).

- [ ] Failing tests → implement → green → commit.

### Task 3: storage flat mirror

**Files:** Modify `src/lib/storage.js` (`CREDENTIAL_KEYS.basePrefix = 's3b_base_prefix'`, load/save/migrate); extend `test/storage.test.js`

- [ ] Tests: round-trip persists; `clearCredentials()` wipes it; absent → `''`. Implement, green, commit.

### Task 4: connection record

**Files:** Modify `src/lib/connections.js` (`resolveConnection` returns `basePrefix: conn.basePrefix || ''`); extend `test/connections.test.js`

- [ ] Tests: round-trip via save/resolve; partial update omitting `basePrefix` leaves it; absent → `''`. Implement, green, commit.

### Task 5: url-params / share links

**Files:** Modify `src/lib/url-params.js`; extend `test/url-params.test.js`

**Produces:** `readUrlParams()` returns normalized `basePrefix` (reject `..`/`\`, cap 1024); `hasUrlParams()` recognizes it; `buildShareUrl` sets `basePrefix` param iff non-empty.

- [ ] Tests incl. "unscoped link has no basePrefix param at all" and "prefix and basePrefix params coexist". Implement, green, commit.

### Task 6: CredentialForm field

**Files:** Modify `src/components/CredentialForm.jsx`; extend `test/components/credential-form.test.jsx`

- [ ] Field after Bucket Name: label `Base folder`, id `cred-baseprefix`, placeholder `photos/2024/`, hint per spec; not required; submit passes `normalizeBasePrefix`; validation error renders; warning line gains Name Prefix pointer sentence. Tests → implement → `npm run test:ui` → commit.

### Task 7: Breadcrumb floor prop

**Files:** Modify `src/components/Breadcrumb.jsx`; extend `test/components/browser-internals.test.jsx`

**Produces:** `<Breadcrumb prefix floor='' onNavigate onMoveDrop?>`; default `floor=''` output byte-identical to today.

- [ ] Tests: no-floor cases pass unmodified; with floor: ancestors hidden, leftmost crumb = floor leaf with title tooltip, click → `onNavigate(floor)`; `prefix===floor` renders single current element; drop on floor crumb → floor not `''`. Defensive fallback when prefix doesn't start with floor. Implement, green, commit.

### Task 8: Browser floor enforcement

**Files:** Modify `src/components/Browser.jsx`; create `test/components/browser-base-prefix.test.jsx` (naming precedent: browser-download-entries.test.jsx)

- [ ] `basePrefix = normalizeBasePrefix(credentials.basePrefix)`; initial state clamped; `navigateTo` clamps first line; popstate path clamped; `floor` to Breadcrumb; `initialPrefix={basePrefix}` to MovePickerModal; clamped-initial info notice (dismissible, local state); `!canList` guidance sentence. Tests: initial hash prefix below floor → clamped; unscoped → unchanged. Implement, green, commit.

### Task 9: MovePickerModal floor

**Files:** Modify `src/components/MovePickerModal.jsx`; create/extend `test/components/move-picker-modal.test.jsx`

- [ ] `initialPrefix` seeds state (already does); pass `floor={initialPrefix}` to Breadcrumb; wrap `onNavigate` in clamp. Tests: scoped → first list uses `Prefix: floor` not `undefined`; unscoped → identical to today. Implement, green, commit.

### Task 10: DuplicatesModal + UploadQueue floors

**Files:** Modify `src/components/DuplicatesModal.jsx` (new `basePrefix` prop; `scope==='bucket'` → scan floor; relabel `Entire scope` when scoped), `src/components/App.jsx` (pass prop), `src/components/UploadQueue.jsx` (destination `withinFloor` validation, inline error + disabled action); extend `test/components/duplicates-modal.test.jsx` (create if absent), `test/components/upload-queue-ui.test.jsx`

- [ ] Tests: scoped bucket-scan never sends `prefix:''`; unscoped wording/behavior unchanged; out-of-scope destination blocks with error; unscoped destination free-text unchanged. Implement, green, commit.

### Task 11: App.jsx wiring + ErrorBlock hint + SetupGuide

**Files:** Modify `src/components/App.jsx` (disconnect fallback object, `handleSaveProfile` both objects, `handleAcceptVaultOffer` record), `src/components/ErrorBlock.jsx` (403 base-folder note when `basePrefix` empty — new optional prop; CORS-heuristic extra sentence), `src/components/SetupGuide.jsx` (B2 step-2 sentence); extend `test/components/error-block.test.jsx`, `test/components/setup-guide.test.jsx`, `test/components/app.test.jsx` as needed

- [ ] Tests: hint renders on 403 without basePrefix, absent with basePrefix set / non-403; B2 guide sentence present; save-profile carries basePrefix. Implement, green, commit.

### Task 12: e2e mock scopePrefix + self-tests

**Files:** Modify `test/e2e/mock-s3/server.mjs` (`scopePrefix` config + `inScope`/deny guards per spec §E2E, `logRequest` gains `isList`/`listPrefix`); extend `test/e2e/mock-s3/server.test.mjs`

- [ ] Self-tests: root list denied 403 AccessDenied; equal/nested prefix OK; object ops in/out; copy both sides; multipart initiate denied cascades; mixed batch delete per-key errors; reset clears; ListVersions parity. Run node e2e layer; commit.

### Task 13: e2e browser specs + not-inert evidence

**Files:** Create `test/e2e/browser/prefix-scope.test.mjs` (4 specs per spec §E2E: normal connect, shared link, clamped deep link, recovery hint)

- [ ] Write specs; run them against pre-feature main (stash/worktree) → record FAIL; against feature → PASS; then full `npm run test:e2e:container`; record results for MR. Commit.

### Task 14: bump + ship

- [ ] `npm version 1.50.0 --no-git-tag-version`; CHANGELOG entry; `npm run build`; commit bump with dist + changelog.js; push branch; MR "Addresses #60" with evidence; CI green; merge; verify live 1.50.0.
