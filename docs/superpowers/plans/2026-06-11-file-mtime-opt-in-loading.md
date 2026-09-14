# File Modified Column — Opt-In Loading Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-loading File Modified column with an opt-in design: default off, click the column header to load, IntersectionObserver-based viewport loading, two-level cache (session ref + localStorage keyed by `bucket:key:lastModifiedMs`), single spinner in the column header, and a setting to auto-enable.

**Architecture:** A new `mtimeLoadEnabled` boolean state (initialised from a new storage setting, default `false`) gates all HeadObject requests. When enabled (by click or setting), an `IntersectionObserver` watches cells with `data-mtime-key` attributes and enqueues HeadObject calls only for visible rows (concurrency=3). Results write to an L1 session ref and an L2 localStorage cache; the cache key includes the S3 `LastModified` timestamp so replaced files automatically miss. The column header renders three states: idle (clickable ↓ affordance), loading (single spinner), done (plain text).

**Tech Stack:** Preact, AWS SDK v3 `HeadObjectCommand`, `IntersectionObserver` API, `localStorage`, Node `--test`, jsdom + `preact/test-utils`

---

## Files to Create or Modify

| File | Change |
|------|--------|
| `src/lib/storage.js` | Add `fileMtimeAutoLoad` key + accessor + exports |
| `src/components/Browser.jsx` | Rework mtime column: opt-in state, IntersectionObserver, two-level cache, header states |
| `src/components/SettingsPanel.jsx` | Add "Automatically load file modification times" checkbox |
| `test/storage.test.js` | Add 3 tests for `loadFileMtimeAutoLoad` / `saveFileMtimeAutoLoad` |
| `test/components/settings-panel.test.jsx` | Add test for the new checkbox rendering |
| `test/source-invariants.test.js` | Add 3 invariants for opt-in gate, IntersectionObserver, and header onClick (written before Browser.jsx changes so they fail first — TDD) |

---

## Task 1: Add `fileMtimeAutoLoad` setting to storage.js

**Files:**
- Modify: `src/lib/storage.js`
- Test: `test/storage.test.js`

The storage module uses a `makeSettingAccessors` factory (around line 98). New settings follow the same pattern: add a key to `SETTINGS_KEYS`, create an accessor with `makeSettingAccessors`, export the pair. The new setting defaults to `false` (opt-in, not auto-load).

- [ ] **Step 1: Write the failing tests**

Add at the end of `test/storage.test.js` (after the last `describe` block):

```javascript
describe('loadFileMtimeAutoLoad / saveFileMtimeAutoLoad', () => {
  test('defaults to false when no value is stored', () => {
    assert.equal(loadFileMtimeAutoLoad(), false);
  });

  test('returns true after saveFileMtimeAutoLoad(true)', () => {
    saveFileMtimeAutoLoad(true);
    assert.equal(loadFileMtimeAutoLoad(), true);
  });

  test('returns false after saveFileMtimeAutoLoad(false)', () => {
    saveFileMtimeAutoLoad(true);
    saveFileMtimeAutoLoad(false);
    assert.equal(loadFileMtimeAutoLoad(), false);
  });
});
```

Also add `loadFileMtimeAutoLoad, saveFileMtimeAutoLoad` to the import at the top of the test file (where `loadAdaptiveMode, saveAdaptiveMode` are imported).

- [ ] **Step 2: Run to confirm failure**

```bash
node --test test/storage.test.js 2>&1 | grep -A3 'loadFileMtimeAutoLoad'
```
Expected: FAIL — `loadFileMtimeAutoLoad is not a function`

- [ ] **Step 3: Add the key, accessor, and exports to storage.js**

In `SETTINGS_KEYS` (around line 29), add one entry:
```javascript
  fileMtimeAutoLoad: 's3b_file_mtime_auto_load',
```

After the `_adaptiveMode` accessor block (around line 141), add:
```javascript
const _fileMtimeAutoLoad = makeSettingAccessors(
  LS_KEYS.fileMtimeAutoLoad,
  v => v === '' ? false : v === 'true',   // default false
);
```

After `export const saveAdaptiveMode` (around line 160), add:
```javascript
export const loadFileMtimeAutoLoad = _fileMtimeAutoLoad.load;
export const saveFileMtimeAutoLoad = _fileMtimeAutoLoad.save;
```

- [ ] **Step 4: Run to confirm pass**

```bash
node --test test/storage.test.js 2>&1 | grep -A3 'loadFileMtimeAutoLoad'
```
Expected: all 3 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.js test/storage.test.js
git commit -m "feat: add fileMtimeAutoLoad storage setting (default false)"
```

---

## Task 2: Write source invariants for opt-in behavior (failing first — TDD)

**Files:**
- Modify: `test/source-invariants.test.js`

Write these invariants **before** the Browser.jsx changes in Task 3 so they fail against the current code. They verify the three structural properties of the opt-in design.

- [ ] **Step 1: Add the failing invariant tests**

Add to `test/source-invariants.test.js` (after the existing "File Modified column" describe block near the end):

```javascript
describe('Browser.jsx — file-mtime loading is opt-in (default off)', () => {
  const source = src('components/Browser.jsx');

  test('declares mtimeLoadEnabled state initialized from loadFileMtimeAutoLoad', () => {
    assert.ok(
      source.includes('mtimeLoadEnabled') && source.includes('loadFileMtimeAutoLoad'),
      'Browser.jsx must declare mtimeLoadEnabled state initialised from loadFileMtimeAutoLoad — ' +
      'the File Modified column must be opt-in; HeadObject requests must not fire until ' +
      'the user clicks the column header or enables the setting'
    );
  });

  test('HeadObject mtime effect is gated on mtimeLoadEnabled', () => {
    assert.ok(
      /if\s*\(!mtimeLoadEnabled/.test(source),
      'Browser.jsx mtime loading useEffect must bail with `if (!mtimeLoadEnabled ...) return` — ' +
      'without this guard, HeadObject calls fire automatically for every listed file, ' +
      'incurring one API call per file per page load without user consent'
    );
  });

  test('col-file-modified header has onClick to enable loading', () => {
    assert.ok(
      /col-file-modified[\s\S]{0,300}onClick|onClick[\s\S]{0,100}setMtimeLoadEnabled/.test(source),
      'Browser.jsx must wire an onClick to the col-file-modified header — clicking it ' +
      'is the primary way to opt in to loading file modification times'
    );
  });
});
```

- [ ] **Step 2: Run to confirm all three fail**

```bash
node --test test/source-invariants.test.js 2>&1 | grep -A2 'opt-in'
```
Expected: all 3 FAIL — `mtimeLoadEnabled` and `loadFileMtimeAutoLoad` are not yet in Browser.jsx.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/source-invariants.test.js
git commit -m "test: add failing invariants for opt-in file-mtime loading (pre-implementation)"
```

---

## Task 3: Rework Browser.jsx File Modified column

**Files:**
- Modify: `src/components/Browser.jsx`

This task makes the three failing invariants from Task 2 pass. It replaces the current auto-loading behavior with opt-in viewport-based loading.

**Before editing**, read lines 96–153 (mtime state and effects) and lines 887–965 (column header and cell render) carefully to understand the current code.

### What to remove

- The current `useEffect([bucket])` that resets `fileMtimeCacheRef` (lines 113–117) — replaced below.
- The current `useEffect([items, bucket])` that auto-loads HeadObject (lines 124–153) — replaced below.

### Changes (apply in order A → F)

**A. Add `loadFileMtimeAutoLoad` to the storage import**

Find the line that imports from `'../lib/storage.js'` (search for `loadMaxKeys`). Add `loadFileMtimeAutoLoad` to it — keep all existing imports, just append this one.

**B. Change the L1 cache ref and add new state**

Replace lines 96–97:
```javascript
const fileMtimeCacheRef = useRef(new Map()); // Key → ISO string | null
const [, setMtimeCacheVer] = useState(0);
```
With:
```javascript
// cacheKey = `${bucket}:${Key}:${lastModifiedMs}` — includes LastModified for auto-invalidation on file replace
const fileMtimeCacheRef = useRef(new Map());
const [, setMtimeCacheVer] = useState(0);
const [mtimeLoadEnabled, setMtimeLoadEnabled] = useState(() => loadFileMtimeAutoLoad());
const [isMtimeLoading, setIsMtimeLoading] = useState(false);
```

**C. Replace the bucket-change effect (was lines 113–117)**

```javascript
useEffect(() => {
  fileMtimeCacheRef.current = new Map();
  setMtimeCacheVer(0);
  setIsMtimeLoading(false);
}, [bucket]);
```

**D. Replace the HeadObject auto-load effect (was lines 124–153)**

```javascript
// File-mtime opt-in loading via IntersectionObserver.
// Only active when mtimeLoadEnabled is true (user clicked header or setting is on).
// Observes [data-mtime-key] cells; IntersectionObserver fires immediately for visible ones.
// Two-level cache: L1 session ref, L2 localStorage (key includes S3 LastModified for
// automatic invalidation when a file is replaced).
useEffect(() => {
  if (!mtimeLoadEnabled || !client || !bucket) return;
  let cancelled = false;
  const queue = [];
  let active = 0;

  function flush() {
    while (queue.length && active < 3) {
      const { Key, cacheKey } = queue.shift();
      active++;
      client.send(new HeadObjectCommand({ Bucket: bucket, Key }))
        .then(head => {
          const mtime = head.Metadata?.[FILE_MTIME_KEY] ?? null;
          fileMtimeCacheRef.current.set(cacheKey, mtime);
          try { localStorage.setItem('bucketer:mtime:' + cacheKey, mtime ?? ''); } catch {}
        })
        .catch(() => {
          fileMtimeCacheRef.current.set(cacheKey, null);
          try { localStorage.setItem('bucketer:mtime:' + cacheKey, ''); } catch {}
        })
        .finally(() => {
          active--;
          if (!cancelled) {
            flush();
            setMtimeCacheVer(v => v + 1);
            if (active === 0 && queue.length === 0) setIsMtimeLoading(false);
          }
        });
    }
  }

  function enqueue(Key, lastModifiedMs) {
    const cacheKey = `${bucket}:${Key}:${lastModifiedMs}`;
    if (fileMtimeCacheRef.current.has(cacheKey)) return; // L1 hit
    let stored = null;
    try { stored = localStorage.getItem('bucketer:mtime:' + cacheKey); } catch {}
    if (stored !== null) {
      // L2 hit — warm L1 and trigger a re-render without a HeadObject call
      fileMtimeCacheRef.current.set(cacheKey, stored === '' ? null : stored);
      setMtimeCacheVer(v => v + 1);
      return;
    }
    if (!queue.some(e => e.cacheKey === cacheKey)) {
      queue.push({ Key, cacheKey });
      if (active === 0 && queue.length === 1) setIsMtimeLoading(true);
      flush();
    }
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const Key = entry.target.dataset.mtimeKey;
      const lastModifiedMs = Number(entry.target.dataset.mtimeLm);
      if (Key && lastModifiedMs) enqueue(Key, lastModifiedMs);
    }
  }, { rootMargin: '100px 0px' });

  document.querySelectorAll('[data-mtime-key]').forEach(el => observer.observe(el));

  return () => {
    cancelled = true;
    observer.disconnect();
  };
}, [mtimeLoadEnabled, items, bucket]);
```

**E. Update the column header (find `<th class="col-file-modified">File Modified</th>`)**

Replace:
```jsx
<th class="col-file-modified">File Modified</th>
```
With:
```jsx
<th
  class="col-file-modified"
  onClick={!mtimeLoadEnabled ? () => setMtimeLoadEnabled(true) : undefined}
  title={!mtimeLoadEnabled ? 'Click to load file modification times' : undefined}
  style={!mtimeLoadEnabled ? { cursor: 'pointer' } : undefined}
>
  File Modified
  {!mtimeLoadEnabled && <span style={{ opacity: .5, marginLeft: '.3rem' }}>↓</span>}
  {mtimeLoadEnabled && isMtimeLoading && <span class="spinner" style={{ marginLeft: '.4rem' }} />}
</th>
```

**F. Update file row cells (find the `<td class="col-file-modified">` with the has/get cache lookup)**

Replace:
```jsx
<td class="col-file-modified">
  {fileMtimeCacheRef.current.has(obj.Key)
    ? (fileMtimeCacheRef.current.get(obj.Key)
        ? formatDate(fileMtimeCacheRef.current.get(obj.Key))
        : '—')
    : null}
</td>
```
With:
```jsx
<td
  class="col-file-modified"
  data-mtime-key={obj.Key}
  data-mtime-lm={new Date(obj.LastModified).getTime()}
>
  {mtimeLoadEnabled && (() => {
    const cacheKey = `${bucket}:${obj.Key}:${new Date(obj.LastModified).getTime()}`;
    const cached = fileMtimeCacheRef.current.get(cacheKey);
    if (cached === undefined) return null;
    return cached ? formatDate(cached) : '—';
  })()}
</td>
```

- [ ] **Step 1: Apply changes A–F to Browser.jsx**

- [ ] **Step 2: Verify the build passes**

```bash
npm run build 2>&1 | tail -5
```
Expected: exits 0. Fix any syntax error and re-run if not.

- [ ] **Step 3: Confirm the Task 2 invariants now pass**

```bash
node --test test/source-invariants.test.js 2>&1 | grep -A2 'opt-in'
```
Expected: all 3 PASS.

- [ ] **Step 4: Run the full unit + build test suite**

```bash
npm test 2>&1 | tail -10
```
Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/components/Browser.jsx
git commit -m "feat: make File Modified column opt-in with IntersectionObserver and two-level cache"
```

---

## Task 4: Add file-mtime auto-load toggle to SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.jsx`
- Test: `test/components/settings-panel.test.jsx`

The checkbox follows the same pattern as "Background update checks" (around line 259 of SettingsPanel.jsx): a wrapping `<label>` with an inline `<input type="checkbox">`. The setting is self-contained state inside SettingsPanel (same as `adaptiveMode` at line 40).

- [ ] **Step 1: Write the failing test**

Add to `test/components/settings-panel.test.jsx` (after the last test):

```javascript
describe('SettingsPanel — file-mtime auto-load setting', () => {
  test('renders "automatically load file modification times" label', () => {
    const { text, cleanup } = mount(h(SettingsPanel, defaultProps()));
    assert.ok(
      text().toLowerCase().includes('file modification') || text().toLowerCase().includes('modification time'),
      'SettingsPanel must render a label for the file modification time auto-load toggle'
    );
    cleanup();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test:ui -- --test-name-pattern="file-mtime auto-load" 2>&1 | tail -10
```
Expected: FAIL

- [ ] **Step 3: Add `loadFileMtimeAutoLoad` and `saveFileMtimeAutoLoad` to the storage import in SettingsPanel.jsx**

Find line 4 (the storage import). Keep all existing imports; append `loadFileMtimeAutoLoad, saveFileMtimeAutoLoad`.

- [ ] **Step 4: Add state inside `SettingsPanel`**

After the `adaptiveMode` state (around line 40):
```javascript
const [fileMtimeAutoLoad, setFileMtimeAutoLoad] = useState(() => loadFileMtimeAutoLoad());
```

- [ ] **Step 5: Add the checkbox UI**

Add this block immediately before the "Background update checks" `<div class="form-group">` (around line 259):

```jsx
<div class="form-group" style={{ marginTop: '.75rem' }}>
  <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
    <input
      type="checkbox"
      checked={fileMtimeAutoLoad}
      onChange={e => { saveFileMtimeAutoLoad(e.target.checked); setFileMtimeAutoLoad(e.target.checked); }}
    />
    Automatically load file modification times
  </label>
  <span class="hint">
    When enabled, fetches the original file modification time for each listed file in the
    background. Adds one request per file per session (results are cached). Off by default
    — click the "File Modified" column header to load on demand instead.
  </span>
</div>
```

- [ ] **Step 6: Run to confirm pass**

```bash
npm run test:ui -- --test-name-pattern="file-mtime auto-load" 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/SettingsPanel.jsx test/components/settings-panel.test.jsx
git commit -m "feat: add 'automatically load file modification times' setting to SettingsPanel"
```

---

## Task 5: Full test suite verification

- [ ] **Step 1: Run unit + structural + build tests**

```bash
npm test 2>&1 | tail -10
```
Expected: all tests pass, 0 failures.

- [ ] **Step 2: Run component tests**

```bash
npm run test:ui 2>&1 | tail -10
```
Expected: all component tests pass, 0 failures.

- [ ] **Step 3: Manual smoke test**

```bash
npm run serve
```

Verify:
1. Open the browser table — "File Modified" column header shows a faint `↓` and `cursor: pointer`. No HeadObject calls in DevTools Network tab.
2. Click the column header — spinner appears in the header, cells fill in as responses arrive (files with the `x-amz-meta-file-mtime` metadata get dates; files without get `—`).
3. Navigate to a subfolder and back — previously-loaded values appear instantly (no new network requests for unchanged files).
4. Hard-reload — values from localStorage appear instantly (no HeadObject calls for cached files).
5. Open Settings → confirm "Automatically load file modification times" checkbox is present and unchecked.
6. Check the setting → reload → column starts loading automatically without a click.

---

## Verification Summary

| Behavior | Passes if |
|----------|-----------|
| Default off | Column header shows `↓` icon, no HeadObject calls on page load (DevTools: Network tab empty of HeadObject) |
| Click to load | Header click sets `mtimeLoadEnabled = true`, observer fires, cells fill in progressively |
| Single spinner | Only column header shows a spinner; individual cells show no loading state |
| Viewport-only | Rows outside viewport show blank cells until scrolled to |
| L1 cache | Navigating back to a visited prefix: instant render, no new network requests |
| L2 cache | Page reload: cached values load instantly from localStorage for unchanged files |
| Auto-invalidation | Replace a file → its `S3 LastModified` changes → new cacheKey → cache miss → fresh HeadObject |
| Setting on | Check "Automatically load..." in Settings → reload → column auto-loads without click |
| All tests | `npm test` and `npm run test:ui` both exit 0 |
