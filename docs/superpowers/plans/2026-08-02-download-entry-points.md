# Download Entry Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the download entry points out of the sidebar (toolbar, folder-row, batch-bar) and generalize download jobs from one prefix to multi-root scope so arbitrary selections download through the existing durable pipeline.

**Architecture:** A new pure module `download-roots.js` defines the root vocabulary; `enumerateJob` walks roots with a `{rootIndex, continuationToken}` checkpoint (same atomic page commits); `DownloadJobPanel` takes a `scope` prop; `Browser` dispatches `onDownloadRequest` payloads the same way it dispatches `onDeleteRequest`. Everything downstream of the manifest is untouched.

**Tech Stack:** Preact, esbuild, `node --test`, fake-indexeddb, jsdom component tests via `npm run test:ui`, Playwright container e2e matrix.

**Spec:** `docs/superpowers/specs/2026-08-02-download-entry-points-design.md` — read it first.

## Global Constraints

- Branch: `download-entry-points`. Never push without operator confirmation; tests must pass before any push (pre-push hook builds + tests, and tags the **working-tree** `package.json` version — do not push with an unreleased version bumped).
- Unit/structural tests: `npm test`. Component tests: `npm run test:ui` (NOT `npm test`). E2E: container matrix only (`npm run test:e2e:container`) for any coverage claim.
- E2E evidence rules (project CLAUDE.md): baseline container run on the untouched tree before any change; one user-observable per feature; assertions of absence only next to assertions of presence.
- Component test files start with `import '../helpers/with-dom.js'` as the FIRST import.
- Copy style: sentence case, plain language, no exclamation marks (match existing panel copy).
- The toolbar and folder-row download buttons are **not** capability-gated (matches the old sidebar button; the panel discloses capability). Only the batch-bar button is `disabled={!canDownload}`.
- Version bump happens only in the final task, only after operator confirms the level, via `npm version <x.y.z> --no-git-tag-version`, with CHANGELOG entry + rebuilt `dist/index.html` + `src/lib/changelog.js` in the same commit.

---

### Task 0: E2E baseline on the untouched tree

**Files:** none changed.

- [ ] **Step 1: Confirm clean tree at the spec commit**

Run: `git status --short` — expect only pre-existing untracked docs, no modified files.

- [ ] **Step 2: Run the full container matrix**

Run: `npm run test:e2e:container`
Expected: green (or record exactly which lanes are red — a later red lane without this baseline cannot be attributed).

- [ ] **Step 3: Record the result**

Append engine/browser versions + pass counts to `.claude-scratch/e2e-baseline-2026-08-02.txt`. Do not commit this file.

---

### Task 1: `download-roots.js` — root vocabulary and normalization

**Files:**
- Create: `src/lib/download-roots.js`
- Test: `test/download-roots.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `ROOT_TYPES = { FILE: 'file', PREFIX: 'prefix' }`
  - `fileRoot(listingObj) -> { type:'file', key, size, etag, lastModified, storageClass }`
  - `prefixRoot(prefix) -> { type:'prefix', prefix }`
  - `normalizeRoots({ files, prefixes }) -> Root[]` — prefix roots first (given order), then file roots (given order) minus files under any selected prefix. `files` are raw listing objects (`Key`, `Size`, `ETag`, `LastModified`, `StorageClass`).
  - `rootsOfJob(job) -> Root[]` — `job.roots` if non-empty, else `[prefixRoot(job.prefix ?? '')]` (legacy shim).
  - `selectionLabel(count, bucket, capturedPrefix) -> string` — `"3 selected items in bkt/photos/"` / `"1 selected item in bkt"`.

- [ ] **Step 1: Write the failing tests**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/download-roots.js — the multi-root scope vocabulary.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_TYPES, fileRoot, prefixRoot, normalizeRoots, rootsOfJob, selectionLabel,
} from '../src/lib/download-roots.js';

const obj = (Key, Size = 10, StorageClass = null) =>
  ({ Key, Size, ETag: `"${Key}"`, LastModified: new Date(1700000000000), StorageClass });

describe('fileRoot', () => {
  test('captures everything the listing row knew', () => {
    assert.deepEqual(fileRoot(obj('a/b.txt', 42, 'GLACIER')), {
      type: ROOT_TYPES.FILE, key: 'a/b.txt', size: 42, etag: '"a/b.txt"',
      lastModified: 1700000000000, storageClass: 'GLACIER',
    });
  });
  test('tolerates missing size, date and class', () => {
    const r = fileRoot({ Key: 'x' });
    assert.equal(r.size, 0);
    assert.equal(r.lastModified, null);
    assert.equal(r.storageClass, null);
  });
});

describe('normalizeRoots', () => {
  test('prefixes come first, then files, order preserved', () => {
    const roots = normalizeRoots({ files: [obj('z.txt'), obj('a.txt')], prefixes: ['p2/', 'p1/'] });
    assert.deepEqual(roots.map(r => r.type === 'prefix' ? r.prefix : r.key),
      ['p2/', 'p1/', 'z.txt', 'a.txt']);
  });
  test('a file under a selected prefix is dropped — the crawl will produce it', () => {
    const roots = normalizeRoots({ files: [obj('photos/x.jpg'), obj('other.txt')], prefixes: ['photos/'] });
    assert.deepEqual(roots.map(r => r.type === 'prefix' ? r.prefix : r.key),
      ['photos/', 'other.txt']);
  });
  test('empty selection normalizes to no roots', () => {
    assert.deepEqual(normalizeRoots({ files: [], prefixes: [] }), []);
  });
});

describe('rootsOfJob', () => {
  test('prefers explicit roots', () => {
    const roots = [prefixRoot('p/')];
    assert.equal(rootsOfJob({ roots, prefix: 'ignored/' }), roots);
  });
  test('a legacy prefix-only job reads as one prefix root', () => {
    assert.deepEqual(rootsOfJob({ prefix: 'photos/' }), [{ type: ROOT_TYPES.PREFIX, prefix: 'photos/' }]);
  });
  test('a legacy job with no prefix at all reads as the bucket root', () => {
    assert.deepEqual(rootsOfJob({}), [{ type: ROOT_TYPES.PREFIX, prefix: '' }]);
  });
});

describe('selectionLabel', () => {
  test('pluralizes and names the capture location', () => {
    assert.equal(selectionLabel(3, 'bkt', 'photos/'), '3 selected items in bkt/photos/');
    assert.equal(selectionLabel(1, 'bkt', ''), '1 selected item in bkt');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/download-roots.test.js`
Expected: FAIL — `Cannot find module '../src/lib/download-roots.js'`.

- [ ] **Step 3: Implement**

```js
// Copyright (C) 2026 HidayahTech, LLC
// The multi-root scope vocabulary for download jobs.
//
// See docs/superpowers/specs/2026-08-02-download-entry-points-design.md.
//
// A job's scope is an ordered list of roots: prefixes to crawl, and files already fully
// known from the listing row the user ticked — enumerating a file root costs no request.
// Everything downstream of the manifest never sees roots at all.

export const ROOT_TYPES = { FILE: 'file', PREFIX: 'prefix' };

export function fileRoot(o) {
  return {
    type: ROOT_TYPES.FILE,
    key: o.Key,
    size: o.Size ?? 0,
    etag: o.ETag,
    lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null,
    storageClass: o.StorageClass ?? null,
  };
}

export function prefixRoot(prefix) {
  return { type: ROOT_TYPES.PREFIX, prefix };
}

// A ticked file under a ticked folder is dropped: the crawl will produce it, and keeping
// it would duplicate a manifest row.
export function normalizeRoots({ files = [], prefixes = [] }) {
  const roots = prefixes.map(prefixRoot);
  for (const o of files) {
    if (!prefixes.some(p => o.Key.startsWith(p))) roots.push(fileRoot(o));
  }
  return roots;
}

// Legacy read-path shim: jobs persisted before roots existed carry only a prefix.
// No migration write — the field is additive.
export function rootsOfJob(job) {
  if (job.roots?.length) return job.roots;
  return [prefixRoot(job.prefix ?? '')];
}

export function selectionLabel(count, bucket, capturedPrefix = '') {
  const where = capturedPrefix ? `${bucket}/${capturedPrefix}` : bucket;
  return `${count} selected item${count === 1 ? '' : 's'} in ${where}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/download-roots.test.js` — expect PASS. Then `npm test` — expect no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/download-roots.js test/download-roots.test.js
git commit -m "feat: root vocabulary for multi-root download scopes"
```

---

### Task 2: Multi-root `enumerateJob`

**Files:**
- Modify: `src/lib/download-manifest.js` (whole `enumerateJob` body)
- Test: `test/download-manifest.test.js` (extend; existing tests must keep passing untouched)

**Interfaces:**
- Consumes: `rootsOfJob`, `ROOT_TYPES` from Task 1; existing `crawlPrefix`, `appendManifestPage`, `flatNameForKey`, `isDirectoryMarker`, `isArchivedStorageClass`.
- Produces: `enumerateJob(client, job, opts)` — signature and return shape unchanged (`{ objects, bytes, archived, archivedBytes, cancelled, done }`). Checkpoint stored in `job.enumeration` becomes `{ rootIndex, continuationToken, done }`.

- [ ] **Step 1: Write the failing tests** (append to the existing `describe`; reuse its `mockClient`, `obj`, `job`, `keysOf` helpers)

```js
// Multi-prefix crawls need pages keyed by (Prefix, token), not token alone.
function mockClientByPrefix(byPrefix) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push({ ...cmd.input });
      const pages = byPrefix[cmd.input.Prefix ?? ''] || [{ contents: [] }];
      const idx = pages.findIndex(p => (p.token ?? undefined) === cmd.input.ContinuationToken);
      const page = pages[idx === -1 ? 0 : idx];
      return { Contents: page.contents, IsTruncated: !!page.next, NextContinuationToken: page.next };
    },
  };
}

const fRoot = (key, size = 10, storageClass = null) =>
  ({ type: 'file', key, size, etag: `"${key}"`, lastModified: 1700000000000, storageClass });
const pRoot = (prefix) => ({ type: 'prefix', prefix });

test('file roots enumerate with zero requests', async () => {
  await saveJob(job({ roots: [fRoot('a.txt', 5), fRoot('b.txt', 7)] }));
  const client = mockClient([{ token: undefined, contents: [] }]);
  const result = await enumerateJob(client, await loadJob('job-1'), {});
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await keysOf('job-1'), ['a.txt', 'b.txt']);
  assert.equal(result.objects, 2);
  assert.equal(result.bytes, 12);
  assert.equal((await loadJob('job-1')).enumeration.done, true);
});

test('mixed roots: prefixes crawl, files append, counts accumulate across all', async () => {
  await saveJob(job({ roots: [pRoot('p/'), fRoot('loose.txt', 100)] }));
  const client = mockClientByPrefix({ 'p/': [{ token: undefined, contents: [obj('p/one', 10), obj('p/two', 20)] }] });
  const result = await enumerateJob(client, await loadJob('job-1'), {});
  assert.deepEqual(await keysOf('job-1'), ['loose.txt', 'p/one', 'p/two']);
  assert.equal(result.objects, 3);
  assert.equal(result.bytes, 130);
});

test('an archived file root is recorded SKIPPED, never PENDING', async () => {
  await saveJob(job({ provider: 'aws', roots: [fRoot('cold.bin', 50, 'GLACIER'), fRoot('warm.bin', 5)] }));
  const result = await enumerateJob(mockClient([{ token: undefined, contents: [] }]), await loadJob('job-1'), {});
  assert.deepEqual(await keysOf('job-1', ITEM_STATUS.SKIPPED), ['cold.bin']);
  assert.deepEqual(await keysOf('job-1'), ['warm.bin']);
  assert.equal(result.archived, 1);
  assert.equal(result.archivedBytes, 50);
});

test('resumes between roots: a completed root is never re-crawled', async () => {
  await saveJob(job({
    roots: [pRoot('done/'), pRoot('todo/')],
    enumeration: { rootIndex: 1 },   // checkpoint says done/ already committed
  }));
  const client = mockClientByPrefix({ 'todo/': [{ token: undefined, contents: [obj('todo/x')] }] });
  await enumerateJob(client, await loadJob('job-1'), {});
  assert.ok(client.calls.every(c => c.Prefix === 'todo/'), 'done/ must not be re-listed');
  assert.deepEqual(await keysOf('job-1'), ['todo/x']);
});

test('resumes mid-prefix within a root using the stored token', async () => {
  await saveJob(job({
    roots: [pRoot('p/')],
    enumeration: { rootIndex: 0, continuationToken: 't2' },
  }));
  const client = mockClientByPrefix({
    'p/': [
      { token: undefined, contents: [obj('p/page1')], next: 't2' },
      { token: 't2', contents: [obj('p/page2')] },
    ],
  });
  await enumerateJob(client, await loadJob('job-1'), {});
  assert.deepEqual(await keysOf('job-1'), ['p/page2']);
  assert.equal(client.calls[0].ContinuationToken, 't2');
});

test('a legacy prefix-only job still enumerates (read-path shim)', async () => {
  await saveJob(job({ prefix: 'old/' }));  // no roots field at all
  const client = mockClientByPrefix({ 'old/': [{ token: undefined, contents: [obj('old/a')] }] });
  const result = await enumerateJob(client, await loadJob('job-1'), {});
  assert.deepEqual(await keysOf('job-1'), ['old/a']);
  assert.equal(result.done, true);
});

test('done commits only with the final root', async () => {
  await saveJob(job({ roots: [fRoot('a.txt'), pRoot('p/')] }));
  const client = mockClientByPrefix({ 'p/': [{ token: undefined, contents: [obj('p/x')] }] });
  await enumerateJob(client, await loadJob('job-1'), {});
  const j = await loadJob('job-1');
  assert.equal(j.enumeration.done, true);
  assert.equal(j.enumeration.rootIndex, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/download-manifest.test.js`
Expected: new tests FAIL (file roots ignored / wrong prefixes crawled); pre-existing tests PASS.

- [ ] **Step 3: Rewrite `enumerateJob`** (keep the file's header comments; extend them with the root walk)

```js
import { crawlPrefix } from './crawl-prefix.js';
import { appendManifestPage, ITEM_STATUS } from './download-records.js';
import { isDirectoryMarker, flatNameForKey, NAMING_MODES } from './download-naming.js';
import { isArchivedStorageClass } from './storage-class.js';
import { rootsOfJob, ROOT_TYPES } from './download-roots.js';

// enumerateJob(client, job, { onProgress, shouldCancel, maxKeys })
// Walks the job's roots in order. File roots commit straight from their captured listing
// data — no request. Prefix roots crawl as before. The checkpoint generalizes to
// { rootIndex, continuationToken, done }: a crash resumes from the last committed page
// of root i, and the items+checkpoint single-transaction invariant is unchanged.
export async function enumerateJob(client, job, { onProgress, shouldCancel, maxKeys } = {}) {
  const mode = job.mode || NAMING_MODES.LEAF;
  const roots = rootsOfJob(job);
  let objects = 0;
  let bytes = 0;
  let archived = 0;
  let archivedBytes = 0;

  const toItem = (o) => {
    const isArchived = isArchivedStorageClass(o.StorageClass, job.provider);
    if (isArchived) { archived += 1; archivedBytes += o.Size ?? 0; }
    return {
      key:          o.Key,
      size:         o.Size ?? 0,
      etag:         o.ETag,
      lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null,
      localName:    flatNameForKey(o.Key, mode),
      storageClass: o.StorageClass ?? null,
      status:       isArchived ? ITEM_STATUS.SKIPPED : ITEM_STATUS.PENDING,
      ...(isArchived ? { skipReason: 'archived' } : {}),
    };
  };

  const startIndex = job.enumeration?.rootIndex ?? 0;
  let i = startIndex;
  while (i < roots.length) {
    if (shouldCancel?.()) return { objects, bytes, archived, archivedBytes, cancelled: true, done: false };

    if (roots[i].type === ROOT_TYPES.FILE) {
      // Consecutive file roots batch into one page; the commit advances rootIndex past
      // the whole batch atomically. Directory markers cannot be ticked, but the filter
      // matches the crawl path so both routes into the manifest behave identically.
      const items = [];
      let j = i;
      while (j < roots.length && roots[j].type === ROOT_TYPES.FILE) {
        const r = roots[j];
        if (!isDirectoryMarker(r.key)) {
          items.push(toItem({
            Key: r.key, Size: r.size, ETag: r.etag,
            LastModified: r.lastModified != null ? new Date(r.lastModified) : null,
            StorageClass: r.storageClass,
          }));
        }
        j += 1;
      }
      objects += items.length;
      for (const it of items) bytes += it.size;
      await appendManifestPage(job.id, items, {
        rootIndex: j, continuationToken: null,
        ...(j >= roots.length ? { done: true } : {}),
      });
      onProgress?.({ objects, bytes });
      i = j;
      continue;
    }

    // The stored token belongs to the checkpointed root only.
    const startToken = i === startIndex ? job.enumeration?.continuationToken : undefined;
    const rootIdx = i;
    const result = await crawlPrefix(client, job.bucket, roots[i].prefix, {
      maxKeys, shouldCancel, startToken,
      onBatch: async (contents, { nextToken }) => {
        const items = contents.filter(o => !isDirectoryMarker(o.Key)).map(toItem);
        objects += items.length;
        for (const it of items) bytes += it.size;
        // Committed even when `items` is empty: a page of nothing but folder markers
        // still has to advance the token, or a resume would replay it forever.
        await appendManifestPage(job.id, items, nextToken
          ? { rootIndex: rootIdx, continuationToken: nextToken }
          : {
              rootIndex: rootIdx + 1, continuationToken: null,
              ...(rootIdx + 1 >= roots.length ? { done: true } : {}),
            });
        onProgress?.({ objects, bytes });
      },
    });
    if (result.cancelled) return { objects, bytes, archived, archivedBytes, cancelled: true, done: false };
    i += 1;
  }

  return { objects, bytes, archived, archivedBytes, cancelled: false, done: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/download-manifest.test.js` — all tests (old and new) PASS. Then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/download-manifest.js test/download-manifest.test.js
git commit -m "feat: enumerate download jobs over multiple roots with a resumable per-root checkpoint"
```

---

### Task 3: `DownloadJobPanel` scope prop (App render site updated in the same commit)

**Files:**
- Modify: `src/components/DownloadJobPanel.jsx`
- Modify: `src/components/App.jsx:831-841` (panel render site only — sidebar untouched here)
- Modify: `src/components/App.jsx:563-578` (`startJob` gains `roots`/`label`)
- Test: `test/components/download-job-panel.test.jsx` (update prop; add scope tests)

**Interfaces:**
- Consumes: `prefixRoot` from Task 1.
- Produces: `DownloadJobPanel({ bucket, scope, api, onStart, onClose, onUseTransferTool, capabilities })` where `scope` is `{ kind: 'folder', prefix }` or `{ kind: 'selection', roots, label }`. `api.startJob` is called as `startJob({ bucket, prefix, roots, mode, label })`. Job rows display `j.label || j.prefix || bucket`.

- [ ] **Step 1: Write the failing tests** (append to the existing describe; follow the file's existing fake-`api` pattern — read it first and reuse its helpers)

```jsx
// Selection scope: the label is the scope line, and the transfer-tool link is hidden
// because the Stage 1 command generator is prefix-scoped (spec decision 3).
test('selection scope shows its label and hides the transfer-tool link', async () => {
  const { text, query, cleanup } = mount(h(DownloadJobPanel, {
    bucket: 'bkt',
    scope: { kind: 'selection', roots: [{ type: 'file', key: 'a.txt', size: 1, etag: '"a"', lastModified: null, storageClass: null }], label: '1 selected item in bkt' },
    api: fakeApi(), onStart: () => {}, onClose: () => {},
    onUseTransferTool: () => {},
  }));
  await tick();
  assert.ok(text().includes('1 selected item in bkt'));
  assert.equal(query('[data-testid="use-transfer-tool"]'), null);
  cleanup();
});

test('folder scope still offers the transfer-tool link', async () => {
  const { query, cleanup } = mount(h(DownloadJobPanel, {
    bucket: 'bkt', scope: { kind: 'folder', prefix: 'p/' },
    api: fakeApi(), onStart: () => {}, onClose: () => {},
    onUseTransferTool: () => {},
  }));
  await tick();
  assert.ok(query('[data-testid="use-transfer-tool"]'));
  cleanup();
});

test('scan() passes the scope roots and label to startJob', async () => {
  let started = null;
  const api = fakeApi({ startJob: async (args) => { started = args; return { id: 'j1' }; } });
  const roots = [{ type: 'file', key: 'a.txt', size: 1, etag: '"a"', lastModified: null, storageClass: null }];
  const { query, cleanup } = mount(h(DownloadJobPanel, {
    bucket: 'bkt', scope: { kind: 'selection', roots, label: '1 selected item in bkt' },
    api, onStart: () => {}, onClose: () => {},
  }));
  await tick();
  fire(query('[data-testid="scan"]'), 'click');
  await tick();
  assert.equal(started.roots, roots);
  assert.equal(started.label, '1 selected item in bkt');
  assert.equal(started.prefix, '');
  cleanup();
});
```

Also update EVERY existing mount in this file from `prefix: <p>` to `scope: { kind: 'folder', prefix: <p> }` — behavior assertions stay identical.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:ui` — new tests FAIL (`scope` unknown), existing panel tests FAIL on the prop change until Step 3.

- [ ] **Step 3: Implement**

In `DownloadJobPanel.jsx`:

```js
import { prefixRoot } from '../lib/download-roots.js';

export function DownloadJobPanel({ bucket, scope, api, onStart, onClose, onUseTransferTool,
                                   capabilities = null }) {
  const isFolder = scope.kind === 'folder';
  const roots = isFolder ? [prefixRoot(scope.prefix || '')] : scope.roots;
  // The transfer-tool generator is prefix-scoped, so the link renders only when this
  // panel's scope is exactly one prefix root (spec decision 3).
  const showTransferTool = !!onUseTransferTool && isFolder;
```

- Replace the old `const scope = prefix ? ... : bucket;` line with:
  `const scopeText = isFolder ? (scope.prefix ? `${bucket}/${scope.prefix}` : bucket) : scope.label;`
- Modal title: `{isFolder ? 'Download this folder' : 'Download selection'}`.
- Scope sentence: folder keeps the current sentence with `{scopeText}`; selection renders `Downloading <code>{scopeText}</code>.` (no "everything beneath it").
- `scan()`: `created = await api.startJob({ bucket, prefix: isFolder ? (scope.prefix || '') : '', roots, mode, label: isFolder ? null : scope.label });`
- Both `use-transfer-tool` buttons: condition on `showTransferTool` instead of `onUseTransferTool`.
- All three job-row scope spans (`{u.prefix || bucket}` at the unfinished/sent/settled rows): change to `{u.label || u.prefix || bucket}`.

In `App.jsx`:
- Render site: `prefix={currentPrefix}` → `scope={{ kind: 'folder', prefix: currentPrefix }}` (Task 4 replaces this with real scope state).
- `startJob`: signature `async ({ bucket, prefix, roots, mode, label })`, job object gains `roots, label: label ?? null` next to `prefix`.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:ui` then `npm test`. All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/DownloadJobPanel.jsx src/components/App.jsx test/components/download-job-panel.test.jsx
git commit -m "feat: download panel takes a scope — folder or selection — and jobs carry roots and a label"
```

---

### Task 4: Browser entry points + App wiring + sidebar removal

**Files:**
- Modify: `src/components/Browser.jsx` (toolbar ~line 1025, folder-row actions ~line 1180, batch bar ~line 1057, props line 45, helper near line 687)
- Modify: `src/components/App.jsx` (remove sidebar `handoff-entry` block lines ~1025-1051; add scope state + handler; pass `onDownloadRequest`; transfer-handoff prefix)
- Test: Create `test/components/browser-download-entries.test.jsx`; extend `test/source-invariants.test.js`

**Interfaces:**
- Consumes: `normalizeRoots`, `selectionLabel` from Task 1; panel `scope` prop from Task 3.
- Produces: `Browser` prop `onDownloadRequest(payload)` with payloads
  `{ kind: 'folder', prefix }` (toolbar, folder row) or
  `{ kind: 'selection', files: listingObj[], prefixes: string[], capturedPrefix }` (batch bar).

- [ ] **Step 1: Write the failing component tests** (model on `browser-folder-rename.test.jsx` — same `listClient`/`mountBrowser` shape, but the client must also return one file so the batch bar can select it)

```jsx
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { Browser } from '../../src/components/Browser.jsx';

function listClient() {
  return {
    send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return Promise.resolve({
          Contents: [{ Key: 'a.txt', Size: 5, ETag: '"a"', LastModified: new Date(1700000000000) }],
          IsTruncated: false,
          CommonPrefixes: [{ Prefix: 'photos/' }],
        });
      }
      return Promise.reject(new Error('unexpected'));
    },
  };
}

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function mountBrowser(onDownloadRequest, capsOver = caps) {
  return mount(h(Browser, {
    client: listClient(), bucket: 'b', provider: 'generic', credentials: { bucket: 'b' },
    capabilities: capsOver, onCapabilityChange: () => {}, onDownloadRequest,
    onDeleteRequest: () => {}, onMoveRequest: () => {}, onUploadTargetChange: () => {},
    onInitialListFailed: () => {},
  }));
}

async function tick() { await new Promise(r => setTimeout(r, 20)); }

describe('Browser — download entry points', () => {
  test('toolbar button dispatches the current folder scope', async () => {
    let payload = null;
    const { query, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    fire(query('[data-testid="open-download-job"]'), 'click');
    assert.deepEqual(payload, { kind: 'folder', prefix: '' });
    cleanup();
  });

  test('folder-row button dispatches that subfolder without navigating', async () => {
    let payload = null;
    const { query, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    fire(query('[data-testid="download-folder:photos/"]'), 'click');
    assert.deepEqual(payload, { kind: 'folder', prefix: 'photos/' });
    cleanup();
  });

  test('batch bar dispatches the ticked files and folders with listing data intact', async () => {
    let payload = null;
    const { query, queryAll, cleanup } = mountBrowser(p => { payload = p; });
    await tick();
    // Tick the file and the folder via their row checkboxes.
    for (const cb of queryAll('.col-check input[type="checkbox"]')) fire(cb, 'change');
    const btn = Array.from(queryAll('.batch-bar button')).find(b => b.textContent.includes('Download'));
    fire(btn, 'click');
    assert.equal(payload.kind, 'selection');
    assert.deepEqual(payload.prefixes, ['photos/']);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].Key, 'a.txt');
    assert.equal(payload.files[0].Size, 5);          // raw listing object, not a projection
    assert.equal(payload.capturedPrefix, '');
    cleanup();
  });

  test('batch-bar download is disabled without download capability', async () => {
    const { queryAll, cleanup } = mountBrowser(() => {}, { ...caps, download: 'denied' });
    await tick();
    for (const cb of queryAll('.col-check input[type="checkbox"]')) fire(cb, 'change');
    const btn = Array.from(queryAll('.batch-bar button')).find(b => b.textContent.includes('Download'));
    assert.equal(btn.disabled, true);
    cleanup();
  });
});
```

And in `test/source-invariants.test.js`, add (follow the file's existing read-the-source pattern):

```js
test('the sidebar download entry is gone and lives in the browser toolbar (2026-08-02 relocation)', () => {
  const app = fs.readFileSync('src/components/App.jsx', 'utf8');
  assert.ok(!app.includes('handoff-entry'),
    'App.jsx must not reintroduce the sidebar handoff-entry block; download entry points live in Browser.jsx');
  const browser = fs.readFileSync('src/components/Browser.jsx', 'utf8');
  assert.ok(browser.includes('data-testid="open-download-job"'),
    'the toolbar download button must keep the open-download-job testid the e2e specs use');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:ui` (new component tests FAIL — no buttons) and `npm test` (invariant FAILS — `handoff-entry` still in App.jsx).

- [ ] **Step 3: Implement Browser.jsx**

Props (line 45): add `onDownloadRequest` after `onMoveRequest`.

Helper next to `selectedFilesWithSize()` (~line 687):

```js
// Raw listing objects for the ticked files — fileRoot() needs ETag/LastModified/
// StorageClass, which selectedFilesWithSize() discards.
function selectedFileObjects() {
  return [...selectedKeys].map(k => items.find(o => o.Key === k)).filter(Boolean);
}
```

Toolbar (`browser-toolbar-actions`, after the Refresh button):

```jsx
<button class="btn btn-ghost btn-sm" data-testid="open-download-job" style={{ marginRight: '.25rem' }}
  onClick={() => onDownloadRequest?.({ kind: 'folder', prefix })}
  title="Download this folder">
  ⤓ Download
</button>
```

Folder-row actions (before the ✎ rename button, same styling):

```jsx
<button
  class="btn btn-ghost btn-sm"
  style={{ marginRight: '.25rem' }}
  data-testid={`download-folder:${cp}`}
  onClick={e => { e.stopPropagation(); onDownloadRequest?.({ kind: 'folder', prefix: cp }); }}
  title="Download this folder"
>⤓</button>
```

Batch bar (before the Move button):

```jsx
<button
  class="btn btn-ghost btn-sm"
  style={selectedKeys.size === 0 ? { marginLeft: 'auto' } : undefined}
  onClick={() => onDownloadRequest?.({ kind: 'selection', files: selectedFileObjects(), prefixes: [...selectedPrefixes], capturedPrefix: prefix })}
  disabled={!canDownload}
  title={!canDownload ? 'Download not permitted with current credentials' : 'Download the selected files and folders'}
>
  Download {selectedKeys.size + selectedPrefixes.size}
</button>
```

Note: the `marginLeft: 'auto'` style currently sits on the Move button when no files are selected; it must move to whichever button is now first in that right-aligned group — put it on the new Download button and REMOVE it from Move (check rendering with both a files-only and a folders-only selection).

- [ ] **Step 4: Implement App.jsx**

1. Delete the whole sidebar `handoff-entry` `<div>` (both buttons + both hint `<p>`s) and the `<hr>` directly above it.
2. Add state next to the other modal state: `const [downloadScope, setDownloadScope] = useState(null);` and `const [handoffPrefix, setHandoffPrefix] = useState(null);`
3. Import `{ normalizeRoots, selectionLabel }` from `'../lib/download-roots.js'`.
4. Handler (near `handleDeleteRequest`):

```js
function handleDownloadRequest(payload) {
  if (payload.kind === 'selection') {
    const count = payload.files.length + payload.prefixes.length;
    setDownloadScope({
      kind: 'selection',
      roots: normalizeRoots(payload),
      label: selectionLabel(count, credentials.bucket, payload.capturedPrefix),
    });
  } else {
    setDownloadScope({ kind: 'folder', prefix: payload.prefix });
  }
  setDownloadOpen(true);
}
```

5. Panel render site:

```jsx
{downloadOpen && session === 'connected' && (
  <DownloadJobPanel
    bucket={credentials.bucket}
    scope={downloadScope ?? { kind: 'folder', prefix: currentPrefix }}
    api={downloadApi}
    capabilities={browserCapabilities}
    onStart={handleDownloadStart}
    onClose={() => { setDownloadOpen(false); setDownloadScope(null); }}
    onUseTransferTool={() => {
      // Only reachable from folder scope (the panel hides the link otherwise), so the
      // handoff targets the panel's folder — which may be a subfolder the user never
      // navigated into.
      setHandoffPrefix(downloadScope?.kind === 'folder' ? downloadScope.prefix : currentPrefix);
      setDownloadOpen(false); setDownloadScope(null); setHandoffOpen(true);
    }}
  />
)}
```

6. TransferHandoff render site: `currentPrefix={handoffPrefix ?? currentPrefix}` and `onClose={() => { setHandoffOpen(false); setHandoffPrefix(null); }}`.
7. Pass `onDownloadRequest={handleDownloadRequest}` to `<Browser>` (single render site, ~line 1117).

- [ ] **Step 5: Run to verify pass**

Run: `npm run test:ui`, `npm test`, and `npm run build` (build must stay green). All PASS.

- [ ] **Step 6: Eyeball it**

Run: `npm run serve`, connect to any profile, confirm: toolbar ⤓ Download; ⤓ on a folder row; "Download N" in the batch bar; sidebar has no download entries; panel from batch bar shows the selection label and no transfer-tool link.

- [ ] **Step 7: Commit**

```bash
git add src/components/Browser.jsx src/components/App.jsx test/components/browser-download-entries.test.jsx test/source-invariants.test.js
git commit -m "feat: download entry points move to the browser — toolbar, folder rows, and a batch-bar Download N"
```

---

### Task 5: E2E — selection download observable + full matrix

**Files:**
- Create: `test/e2e/browser/download-selection.test.mjs`
- Possibly modify: existing download specs ONLY if a lane shows they relied on the sidebar (e.g. opened the mobile sidebar first) — check with `rg -n "hamburger|sidebar" test/e2e/browser/download-*.mjs` before touching anything.

**Interfaces:**
- Consumes: harness exports exactly as used in `download-completion.test.mjs` (`startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage, collectDownloads, e2eTest, e2eEngineName`), plus the new testids from Task 4.

- [ ] **Step 1: Write the spec** (one observable: a `download` event fires for exactly the ticked files and no others; WebKit lanes use the server-side attachment-GET observable, as `download-completion.test.mjs` does)

```js
// Browser e2e: a batch-bar selection downloads exactly the ticked files — no more, no
// fewer. Presence observable: a Playwright `download` event (or, on WebKit, the mock's
// attachment GETs) per ticked file. The untouched sibling file is the "no others" half.
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage,
  collectDownloads, e2eTest, e2eEngineName,
} from '../harness.mjs';

let ctx, app, browser, context, page, downloads;

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  // Two loose files + a folder of two, plus one file that must NOT download.
  for (const [key, body] of [
    ['sel/a.txt', 'aaa'], ['sel/b.txt', 'bbb'],
    ['sel/sub/c.txt', 'ccc'], ['sel/sub/d.txt', 'ddd'],
    ['sel/untouched.txt', 'nope'],
  ]) {
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
  }
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

beforeEach(async () => {
  await context?.close().catch(() => {});
  context = await newE2EContext(browser);
  page = await newE2EPage(context);
  downloads = collectDownloads(page);
  ctx.mock.configure({ latencyMs: 0, faults: [] });
  ctx.mock.requestLog.reset();
});

const navGetPaths = () => new Set(ctx.mock.requestLog.list().filter(r => r.isNavGet).map(r => r.path));
const isWebKit = () => e2eEngineName() === 'webkit';

describe('browser e2e — selection download', () => {
  e2eTest('ticked files and folders download; unticked files do not', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:sel"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });

    // Tick a.txt, b.txt and the sub/ folder — leave untouched.txt alone.
    for (const row of ['file-row:a.txt', 'file-row:b.txt', 'folder-row:sub']) {
      await page.locator(`[data-testid="${row}"] .col-check input`).click();
    }
    await page.getByRole('button', { name: /^Download 3$/ }).click();
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 4 of 4/).first().waitFor({ timeout: 60000 });

    if (isWebKit()) {
      await downloads.settle(4000);
    } else {
      await downloads.waitForCount(4, 30000);
    }
    const paths = navGetPaths();
    assert.equal(paths.size, 4, 'exactly the four selected files must be requested');
    assert.ok(![...paths].some(p => p.includes('untouched')), 'the unticked file must never be requested');
  });

  e2eTest('the folder-row entry downloads that subfolder without navigating into it', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:sel"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
    await page.locator('[data-testid="download-folder:sel/sub/"]').click();
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="start"]').click();
    await page.getByText(/Sent 2 of 2/).first().waitFor({ timeout: 60000 });

    if (isWebKit()) { await downloads.settle(4000); } else { await downloads.waitForCount(2, 30000); }
    assert.equal(navGetPaths().size, 2);
  });
});
```

NOTE for the implementer: testid formats (`folder-row:sub` vs `folder-row:sel/sub/`, `.col-check input`, the exact "Sent N of N" copy) must be verified against the harness and Browser.jsx before running — adjust the selectors to what the DOM actually renders, keeping the assertions identical.

- [ ] **Step 2: Run the containerized matrix**

Run: `npm run test:e2e:container`
Expected: new spec green on all lanes; all pre-existing download specs green **unchanged** (that is the relocation's regression evidence). Compare against the Task 0 baseline; attribute any diff before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/browser/download-selection.test.mjs
git commit -m "test: e2e — a selection downloads exactly the ticked files, and a folder row downloads its subfolder"
```

---

### Task 6: Release gate (operator-in-the-loop)

**Files:**
- Modify: `CHANGELOG.md`, `package.json`/`package-lock.json` (via npm), regenerated `dist/index.html` + `src/lib/changelog.js`

- [ ] **Step 1: Present the summary and STOP for confirmation**

Present the change summary and the proposed bump (minor — new user-facing feature: selection download + relocated entry points) and **wait for the operator to confirm the level**. Do not proceed without it.

- [ ] **Step 2: Bump (after confirmation only)**

```bash
npm version <confirmed x.y.0> --no-git-tag-version
```

- [ ] **Step 3: CHANGELOG entry** (top of file, first line self-contained)

```markdown
## [<x.y.0>] — 2026-08-02 — Download where the files are

Download moved out of the sidebar: a toolbar button downloads the folder you are viewing, every folder row can be downloaded without opening it, and ticking files and folders offers Download N in the selection bar. A selection becomes one resumable job through the same pipeline as folder downloads. The transfer-tool option now lives inside the download panel and only for folder scopes.
```

- [ ] **Step 4: Build and verify**

Run: `npm run build` (regenerates `dist/index.html` + `src/lib/changelog.js`; CHANGELOG⇄package.json lockstep asserted), then `npm test` and `npm run test:ui`.

- [ ] **Step 5: Commit the bump (dist + changelog.js INCLUDED) and STOP before pushing**

```bash
git add package.json package-lock.json CHANGELOG.md dist/index.html src/lib/changelog.js
git commit -m "release: v<x.y.0> — download entry points relocated, selection download added"
```

Ask the operator before pushing (pre-push hook will tag v<x.y.0> from the working tree — intended here, but only after their go-ahead).

---

## Self-review notes

- Spec coverage: §1 entry points → Task 4; §2 scope model → Tasks 1, 3; §3 enumeration → Task 2; §4 panel → Task 3; §5 testing → every task's test steps + Tasks 0/5; transfer-tool gating (decision 3) → Tasks 3, 4.
- Deliberate deviations: none. Deliberate defaults carried from the spec discussion: toolbar/folder-row buttons not capability-gated; "Download selection" modal title.
- Known verify-before-run point: e2e selector details in Task 5 Step 1 (explicitly flagged in the spec file's NOTE).
