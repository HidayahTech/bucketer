# In-place Offset Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download store-only ZIP files by writing each file's bytes directly into its pre-computed slot in the staging archive via a worker-owned `FileSystemSyncAccessHandle`, eliminating the OPFS temp read-back cycle (and the Firefox process-memory leak, GitLab #59) and the serial writer.

**Architecture:** The store-only format + manifest-known sizes make every byte offset deterministic before download. A pure `computeZipLayout` produces per-entry offsets on the main thread. A Web Worker owns one exclusive `SyncAccessHandle` on the staging ZIP and does positioned writes as chunks arrive over `postMessage` (zero-copy transferables) from the existing main-thread concurrent-fetch machinery. `runInPlaceJob` is an additive engine chosen at runtime only when the worker + sync handle are available; the shipped `runPrefetch` serial path stays as the fallback so no browser regresses.

**Tech Stack:** Preact + esbuild single-file build; OPFS `FileSystemSyncAccessHandle` (worker-only, exclusive); Web Worker inlined as a Blob URL; `node --test`; Playwright container matrix (Chromium/Firefox/WebKit).

## Global Constraints

- **Bump with `npm version 1.49.0 --no-git-tag-version`** — never hand-edit `package.json`; the pre-push hook owns tagging.
- **A version-bump commit includes rebuilt `dist/index.html` + `src/lib/changelog.js`.** Run `npm run build` after bumping.
- **CHANGELOG.md top entry must match `package.json`** — build invariant fails otherwise. Format: `## [1.49.0] — 2026-08-04 — Title`.
- **`@anthropic-ai/claude-code` must never enter `package.json`/`package-lock.json`.**
- **Single self-contained `dist/index.html`** — everything inlined, including the worker (as a Blob-URL string). No external asset fetches.
- **Store-only (method 0), descriptor-based ZIP format** — byte-identical output to `createZipWriter` **for the same entry order**. In-place uses key-sorted order (`takeItemsPage`), deterministic across resume runs.
- **Container matrix is authoritative for e2e** — run all engines via `npm run test:e2e:container`, babysat in the foreground. Record image tag + browser versions. Scope with `E2E_ENGINES` only for a labelled control run.
- **E2E evidence rules:** baseline first; one observable per feature (the produced ZIP's bytes match a reference AND the mock request log shows the GETs — never a counter); matched-pair evidence for the #59 fix and any bug-fix.

---

## Task 0: Container e2e baseline

**Files:** none (records only).

- [ ] **Step 1: Run the full container matrix on the current (design-only) tree.**

Run: `npm run test:e2e:container`
Babysit in the foreground. If output is 0 bytes for 5+ minutes, kill and re-run (known stall mode).

- [ ] **Step 2: Record the result.**

Capture: image tag (from locked playwright version), per-engine pass/fail counts, and the browser versions printed by the run. Save to `docs/superpowers/plans/inplace-baseline.md`. This is the untouched-tree baseline every later e2e claim is attributed against.

- [ ] **Step 3: Commit the baseline record.**

```bash
git add docs/superpowers/plans/inplace-baseline.md
git commit -m "test: container e2e baseline before in-place composition work"
```

---

## Task 1: OPFS positioned-write fidelity probe (THE GATE)

**Files:**
- Create: `test/e2e/opfs-sync-fidelity.e2e.mjs`

**Interfaces:**
- Produces: a container-matrix e2e spec proving (or disproving) that worker `SyncAccessHandle` positioned, out-of-order writes are byte-faithful per engine. Its result decides which engines get the in-place engine (D6/D8). No production code depends on it; it is the empirical gate.

This spec does NOT use the built app bundle — it exercises raw browser capability. It navigates to the app origin (a secure context, required for OPFS), then runs a worker built from a Blob inside `page.evaluate`.

- [ ] **Step 1: Write the probe spec.**

```javascript
// test/e2e/opfs-sync-fidelity.e2e.mjs
// GATE: worker SyncAccessHandle positioned-write fidelity across engines.
// Result decides which engines get the in-place ZIP engine (design D6/D8).
import { test, expect } from '@playwright/test';
import { startApp } from './harness.mjs'; // reuse the harness's static server + page

// The worker source, as a string (this probe deliberately does NOT go through the
// production build — it measures the raw browser primitive the design rests on).
const WORKER_SRC = `
self.onmessage = async (e) => {
  const { fileName, total, ops } = e.data; // ops: [{at, bytes:[...]}] out of order, with gaps
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName, { create: true });
    const sync = await handle.createSyncAccessHandle();
    sync.truncate(total);
    for (const op of ops) {
      const buf = new Uint8Array(op.bytes);
      sync.write(buf, { at: op.at });
    }
    sync.flush();
    const size = sync.getSize();
    // read the whole file back through the SAME handle
    const readBack = new Uint8Array(size);
    sync.read(readBack, { at: 0 });
    sync.close();
    self.postMessage({ ok: true, size, bytes: Array.from(readBack) });
  } catch (err) {
    self.postMessage({ ok: false, name: err?.name, message: err?.message });
  }
};
`;

test('worker SyncAccessHandle: out-of-order positioned writes are byte-faithful', async ({ page }, testInfo) => {
  const app = await startApp(page); // serves the app origin; secure context for OPFS
  const engine = testInfo.project.name;

  const result = await page.evaluate(async ({ src }) => {
    if (typeof Worker === 'undefined') return { skipped: 'no Worker' };
    const proto = self.FileSystemFileHandle?.prototype;
    if (typeof proto?.createSyncAccessHandle !== 'function') return { skipped: 'no createSyncAccessHandle' };
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    // Build an expected buffer: three regions written OUT OF ORDER (C, A, B), gap at [15,20).
    const total = 30;
    const expected = new Array(total).fill(0);
    const regionA = { at: 0,  bytes: [1, 2, 3, 4, 5] };
    const regionB = { at: 5,  bytes: [6, 7, 8, 9, 10] };
    const regionC = { at: 20, bytes: [21, 22, 23, 24, 25] };
    for (const r of [regionA, regionB, regionC]) r.bytes.forEach((b, i) => { expected[r.at + i] = b; });
    const done = new Promise((res) => { worker.onmessage = (e) => res(e.data); });
    worker.postMessage({ fileName: 'fidelity-probe.bin', total, ops: [regionC, regionA, regionB] });
    const msg = await done;
    worker.terminate();
    return { msg, expected };
  }, { src: WORKER_SRC });

  await app.close();

  if (result.skipped) {
    testInfo.annotations.push({ type: 'fidelity', description: `${engine}: UNSUPPORTED (${result.skipped})` });
    test.skip(true, `${engine}: ${result.skipped}`);
    return;
  }
  expect(result.msg.ok, `${engine} worker error: ${result.msg.name} ${result.msg.message}`).toBe(true);
  expect(result.msg.size).toBe(30);
  expect(result.msg.bytes).toEqual(result.expected);
  testInfo.annotations.push({ type: 'fidelity', description: `${engine}: PASS` });
});
```

- [ ] **Step 2: Confirm the harness exposes `startApp`.**

Read `test/e2e/harness.mjs`. If the app-server export has a different name (e.g. `serveApp`, `launchApp`), adapt the import and the `startApp`/`app.close()` calls to the real API. Do NOT invent a server — reuse the existing one.

- [ ] **Step 3: Run the probe across the container matrix.**

Run: `npm run test:e2e:container -- opfs-sync-fidelity`
(If the container script does not accept a spec filter, run the full `npm run test:e2e:container` and read this spec's result out of the report.)
Babysit in the foreground.

- [ ] **Step 4: Record the gate decision.**

Write per-engine PASS / UNSUPPORTED / FAIL to `docs/superpowers/plans/inplace-baseline.md` under a "Fidelity gate" heading, with the image tag and browser versions.
**DECISION GATE (chronicle the persona ruling):**
- All three PASS → in-place ships for all three; proceed.
- Any engine UNSUPPORTED/FAIL → that engine is gated to the serial fallback (Task 6 caps handle this). Proceed for the passing engines. **Do not** block the whole feature on one engine — the fallback exists for exactly this.
- All three FAIL → STOP and report to the operator; the design's premise is wrong.

- [ ] **Step 5: Commit.**

```bash
git add test/e2e/opfs-sync-fidelity.e2e.mjs docs/superpowers/plans/inplace-baseline.md
git commit -m "test: OPFS worker positioned-write fidelity probe (in-place gate) + gate decision"
```

---

## Task 2: `zip-layout.js` — pure deterministic layout + extracted byte-builders

**Files:**
- Modify: `src/lib/zip-writer.js` — extract `localHeaderBytes`, `dataDescriptorBytes`, `centralDirectoryBytes`, and export `dosDateTime`; have `createZipWriter` call them (no behavior change; existing tests must still pass).
- Create: `src/lib/zip-layout.js`
- Test: `test/zip-layout.test.js`

**Interfaces:**
- Produces (from `zip-writer.js`, all pure):
  - `localHeaderBytes(path, { time, date }) -> Uint8Array` (30 + name bytes; local layout never depends on zip64 — see zip-writer's own note).
  - `dataDescriptorBytes({ crc, size, zip64 }) -> Uint8Array` (16 if not zip64, 24 if zip64).
  - `centralDirectoryBytes(entries, { zip64Limit, maxEntries, cdStart }) -> Uint8Array` (the central directory + optional ZIP64 EOCD + EOCD; `entries` = `[{path, zipOffset, size, crc, time, date}]`).
  - `dosDateTime(mtime) -> { time, date }`.
- Produces (from `zip-layout.js`):
  - `computeZipLayout(items, prefix, { zip64Limit = 0xFFFFFFFF, startOffset = 0 }) -> { entries, centralDirOffset, totalDataEnd }` where each entry is
    `{ key, path, headerOffset, headerBytes, dataOffset, declaredSize, descriptorOffset, descriptorBytes, entryEnd, zip64, time, date }`.
    `items` is an ORDERED array of `{ key, size, lastModified }`. `path = zipEntryPath(key, prefix)`. `centralDirOffset === totalDataEnd === last entry.entryEnd` (or `startOffset` if empty).

- [ ] **Step 1: Write failing tests for the extracted builders + layout.**

```javascript
// test/zip-layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHeaderBytes, dataDescriptorBytes, dosDateTime, createZipWriter } from '../src/lib/zip-writer.js';
import { computeZipLayout } from '../src/lib/zip-layout.js';

test('localHeaderBytes: 30 + name length, independent of size', () => {
  const b = localHeaderBytes('a/b.txt', { time: 0, date: 0x21 });
  assert.equal(b.length, 30 + new TextEncoder().encode('a/b.txt').length);
  assert.equal(new DataView(b.buffer).getUint32(0, true), 0x04034b50); // SIG_LOCAL
});

test('dataDescriptorBytes: 16 non-zip64, 24 zip64', () => {
  assert.equal(dataDescriptorBytes({ crc: 1, size: 10, zip64: false }).length, 16);
  assert.equal(dataDescriptorBytes({ crc: 1, size: 10, zip64: true }).length, 24);
});

test('computeZipLayout: offsets chain, gapless, key order preserved', () => {
  const items = [
    { key: 'p/a.txt', size: 3, lastModified: 0 },
    { key: 'p/b.bin', size: 5, lastModified: 0 },
  ];
  const { entries, centralDirOffset, totalDataEnd } = computeZipLayout(items, 'p/', {});
  assert.equal(entries[0].headerOffset, 0);
  assert.equal(entries[0].dataOffset, entries[0].headerOffset + entries[0].headerBytes);
  assert.equal(entries[0].descriptorOffset, entries[0].dataOffset + 3);
  assert.equal(entries[0].entryEnd, entries[0].descriptorOffset + 16);
  assert.equal(entries[1].headerOffset, entries[0].entryEnd); // gapless chain
  assert.equal(entries[1].descriptorOffset, entries[1].dataOffset + 5);
  assert.equal(centralDirOffset, entries[1].entryEnd);
  assert.equal(totalDataEnd, centralDirOffset);
  assert.equal(entries[0].path, 'a.txt'); // prefix stripped
});

test('computeZipLayout: >4GiB entry is zip64 with a 24-byte descriptor', () => {
  const items = [{ key: 'big', size: 0x100000000, lastModified: 0 }];
  const { entries } = computeZipLayout(items, '', {});
  assert.equal(entries[0].zip64, true);
  assert.equal(entries[0].descriptorBytes, 24);
});

// Cross-check: in-place layout + a manual assemble must equal createZipWriter's bytes
// for the SAME order. Proven fully in Task 3; here just assert the layout's data offsets
// match where a serial append writer would place each entry's data.
test('computeZipLayout matches serial writer entry offsets for same order', async () => {
  const items = [
    { key: 'a.txt', size: 2, lastModified: 0 },
    { key: 'b.txt', size: 4, lastModified: 0 },
  ];
  const { entries } = computeZipLayout(items, '', {});
  const chunks = [];
  const w = createZipWriter({ write: (u8) => { chunks.push(u8.slice()); } }, {});
  const recs = [];
  for (const it of items) {
    const off = w.offset;
    await w.beginEntry(it.key, { declaredSize: it.size });
    await w.update(new Uint8Array(it.size).fill(65));
    recs.push({ ...(await w.endEntry()), start: off });
  }
  assert.equal(recs[0].start, entries[0].headerOffset);
  assert.equal(recs[1].start, entries[1].headerOffset);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `node --test test/zip-layout.test.js`
Expected: FAIL (`computeZipLayout`/`localHeaderBytes` not exported).

- [ ] **Step 3: Extract builders in `zip-writer.js` and implement `zip-layout.js`.**

In `zip-writer.js`, factor the local-header byte assembly out of `beginEntry` into `export function localHeaderBytes(path, { time, date })`, the descriptor out of `endEntry` into `export function dataDescriptorBytes({ crc, size, zip64 })`, and the central-directory + EOCD assembly out of `finish` into `export function centralDirectoryBytes(entries, { zip64Limit = 0xFFFFFFFF, maxEntries = 0xFFFF, cdStart })`. Export `dosDateTime`. Rewrite `beginEntry`/`endEntry`/`finish` to call these (identical output — the existing `build.test.js` and any zip round-trip tests must still pass). Then:

```javascript
// src/lib/zip-layout.js
// Copyright (C) 2026 HidayahTech, LLC
// Pure, deterministic byte layout for a store-only ZIP whose entry sizes are known up
// front (the manifest records them). This is the whole premise of in-place composition:
// every offset is fixed before any byte is downloaded. See
// docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.
import { localHeaderBytes, dosDateTime } from './zip-writer.js';
import { zipEntryPath } from './zip-job.js';

export function computeZipLayout(items, prefix = '', { zip64Limit = 0xFFFFFFFF, startOffset = 0 } = {}) {
  const entries = [];
  let offset = startOffset;
  for (const it of items) {
    const path = zipEntryPath(it.key, prefix);
    const { time, date } = dosDateTime(it.lastModified);
    const headerBytes = localHeaderBytes(path, { time, date }).length;
    const declaredSize = it.size || 0;
    const zip64 = declaredSize >= zip64Limit;
    const descriptorBytes = zip64 ? 24 : 16;
    const headerOffset = offset;
    const dataOffset = headerOffset + headerBytes;
    const descriptorOffset = dataOffset + declaredSize;
    const entryEnd = descriptorOffset + descriptorBytes;
    entries.push({ key: it.key, path, headerOffset, headerBytes, dataOffset, declaredSize, descriptorOffset, descriptorBytes, entryEnd, zip64, time, date });
    offset = entryEnd;
  }
  return { entries, centralDirOffset: offset, totalDataEnd: offset };
}
```

Note: `zip-layout.js` importing `zipEntryPath` from `zip-job.js` is fine — `zip-job.js` already imports from `zip-writer.js`, and `zip-layout.js` does not import `zip-job`'s job engine. If a circular-import lint fails, move `zipEntryPath`/`zipFileName` into a tiny `zip-naming.js` and re-export from `zip-job.js`.

- [ ] **Step 4: Run tests to verify pass; run the full unit suite for the zip-writer refactor.**

Run: `node --test test/zip-layout.test.js`
Expected: PASS
Run: `npm test`
Expected: PASS (zip-writer refactor did not change any output).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/zip-writer.js src/lib/zip-layout.js test/zip-layout.test.js
git commit -m "feat: computeZipLayout + extracted zip-writer byte-builders (in-place foundation)"
```

---

## Task 3: `zip-assemble.js` — pure positioned-write assembler core

**Files:**
- Create: `src/lib/zip-assemble.js`
- Test: `test/zip-assemble.test.js`

**Interfaces:**
- Consumes: `computeZipLayout` (Task 2); `crc32`, `dataDescriptorBytes`, `localHeaderBytes`, `centralDirectoryBytes` (Task 2).
- Produces: `createAssembler(sink, layout)` where `sink = { write(u8, at), truncate(n), flush() }` (all sync-or-async tolerated via `await`). Returns:
  - `async writeHeaders()` — writes every entry's local header at its `headerOffset`; truncates the sink to `layout.totalDataEnd`.
  - `async writeChunk(key, u8)` — writes `u8` at the entry's running data offset; accumulates CRC + size; throws if it would exceed `declaredSize`.
  - `async endEntry(key) -> { crc, size }` — asserts `size === declaredSize`, writes the data descriptor at `descriptorOffset`.
  - `async finish(records)` — writes the central directory + EOCD at `layout.centralDirOffset` from `records` = `[{path, zipOffset, size, crc, time, date}]` (in layout/key order); returns `{ totalBytes }`.
  This is the worker's entire logic, kept pure and sink-agnostic so it is unit-tested against an in-memory sink with zero browser APIs.

- [ ] **Step 1: Write failing tests (round-trip against an in-memory sink + parity with serial writer).**

```javascript
// test/zip-assemble.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeZipLayout } from '../src/lib/zip-layout.js';
import { createAssembler } from '../src/lib/zip-assemble.js';
import { createZipWriter } from '../src/lib/zip-writer.js';

function memSink(size = 0) {
  let buf = new Uint8Array(size);
  return {
    write(u8, at) {
      if (at + u8.length > buf.length) { const n = new Uint8Array(at + u8.length); n.set(buf); buf = n; }
      buf.set(u8, at);
    },
    truncate(n) { const nb = new Uint8Array(n); nb.set(buf.subarray(0, Math.min(n, buf.length))); buf = nb; },
    flush() {},
    bytes: () => buf,
  };
}

test('assembler: out-of-order entries produce the same bytes as the serial writer', async () => {
  const items = [
    { key: 'a.txt', size: 3, lastModified: 0 },
    { key: 'b.txt', size: 5, lastModified: 0 },
    { key: 'c.txt', size: 2, lastModified: 0 },
  ];
  const data = { 'a.txt': [65, 66, 67], 'b.txt': [1, 2, 3, 4, 5], 'c.txt': [9, 8] };
  const layout = computeZipLayout(items, '', {});
  const sink = memSink();
  const asm = createAssembler(sink, layout);
  await asm.writeHeaders();
  // feed entries in a DIFFERENT order than layout (c, a, b) — the whole point
  const recs = {};
  for (const key of ['c.txt', 'a.txt', 'b.txt']) {
    await asm.writeChunk(key, new Uint8Array(data[key]));
    const r = await asm.endEntry(key);
    recs[key] = r;
  }
  const records = layout.entries.map((e) => ({ path: e.path, zipOffset: e.headerOffset, size: recs[e.key].size, crc: recs[e.key].crc, time: e.time, date: e.date }));
  await asm.finish(records);

  // Reference: serial writer, SAME (layout/key) order
  const ref = [];
  const w = createZipWriter({ write: (u8) => ref.push(u8.slice()) }, {});
  const refRecs = [];
  for (const it of items) {
    await w.beginEntry(it.key, { declaredSize: it.size });
    await w.update(new Uint8Array(data[it.key]));
    refRecs.push(await w.endEntry());
  }
  await w.finish(refRecs);
  const refBytes = Buffer.concat(ref.map(Buffer.from));
  assert.deepEqual(Buffer.from(sink.bytes()), refBytes);
});

test('assembler: chunked writes accumulate; oversize throws; undersize endEntry throws', async () => {
  const items = [{ key: 'x', size: 4, lastModified: 0 }];
  const layout = computeZipLayout(items, '', {});
  const asm = createAssembler(memSink(), layout);
  await asm.writeHeaders();
  await asm.writeChunk('x', new Uint8Array([1, 2]));
  await asm.writeChunk('x', new Uint8Array([3, 4]));
  const r = await asm.endEntry('x');
  assert.equal(r.size, 4);

  const asm2 = createAssembler(memSink(), layout);
  await asm2.writeHeaders();
  await assert.rejects(async () => { await asm2.writeChunk('x', new Uint8Array([1, 2, 3, 4, 5])); });

  const asm3 = createAssembler(memSink(), layout);
  await asm3.writeHeaders();
  await asm3.writeChunk('x', new Uint8Array([1, 2]));
  await assert.rejects(async () => { await asm3.endEntry('x'); }); // size 2 != 4
});
```

- [ ] **Step 2: Run to verify failure.** Run: `node --test test/zip-assemble.test.js` — Expected: FAIL (`createAssembler` not defined).

- [ ] **Step 3: Implement `zip-assemble.js`.**

```javascript
// src/lib/zip-assemble.js
// Copyright (C) 2026 HidayahTech, LLC
// Pure positioned-write ZIP assembler. Given a precomputed layout (zip-layout.js), it writes
// each entry's local header, streams its data straight to the entry's slot (any order), writes
// the data descriptor once the entry completes, and finally the central directory at the known
// offset. Sink-agnostic (an OPFS SyncAccessHandle in the worker; an in-memory sink in tests).
// See docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.
import { crc32, localHeaderBytes, dataDescriptorBytes, centralDirectoryBytes } from './zip-writer.js';

export function createAssembler(sink, layout) {
  const byKey = new Map(layout.entries.map((e) => [e.key, e]));
  const state = new Map(); // key -> { written, crc }

  return {
    async writeHeaders() {
      for (const e of layout.entries) {
        await sink.write(localHeaderBytes(e.path, { time: e.time, date: e.date }), e.headerOffset);
      }
      await sink.truncate(layout.totalDataEnd);
    },

    async writeChunk(key, u8) {
      const e = byKey.get(key);
      if (!e) throw new Error(`unknown entry ${key}`);
      const s = state.get(key) || { written: 0, crc: 0 };
      if (s.written + u8.length > e.declaredSize) {
        throw new Error(`entry ${key}: overflow (${s.written + u8.length} > ${e.declaredSize})`);
      }
      await sink.write(u8, e.dataOffset + s.written);
      s.written += u8.length;
      s.crc = crc32(u8, s.crc);
      state.set(key, s);
    },

    async endEntry(key) {
      const e = byKey.get(key);
      const s = state.get(key) || { written: 0, crc: 0 };
      if (s.written !== e.declaredSize) {
        throw new Error(`entry ${key}: wrote ${s.written} but declared ${e.declaredSize}`);
      }
      await sink.write(dataDescriptorBytes({ crc: s.crc, size: s.written, zip64: e.zip64 }), e.descriptorOffset);
      return { crc: s.crc, size: s.written };
    },

    async finish(records) {
      const cd = centralDirectoryBytes(records, { cdStart: layout.centralDirOffset });
      await sink.write(cd, layout.centralDirOffset);
      await sink.flush();
      return { totalBytes: layout.centralDirOffset + cd.length };
    },
  };
}
```

Note: `centralDirectoryBytes` must accept `cdStart` (the central dir's absolute offset) so its internal ZIP64-EOCD self-reference and the EOCD's cd-offset field are correct even though nothing was appended to reach it. Verify this while extracting it in Task 2 — the serial `finish` used `offset` (== cdStart at that moment); pass it explicitly here.

- [ ] **Step 4: Run tests to verify pass.** Run: `node --test test/zip-assemble.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/zip-assemble.js test/zip-assemble.test.js
git commit -m "feat: pure positioned-write ZIP assembler core (in-place)"
```

---

## Task 4: The worker + main-thread client bridge

**Files:**
- Create: `src/worker/zip-assembler.worker.js`
- Create: `src/lib/assembler-client.js`
- Test: `test/assembler-client.test.js`

**Interfaces:**
- Consumes: `createAssembler` (Task 3), `computeZipLayout` output (the `layout`).
- Produces:
  - Worker protocol. Main→worker: `{type:'init', stagingName, layout, freshKeys}` (freshKeys = keys to (re)write this run; headers are written for all, data only expected for freshKeys), `{type:'chunk', key, buffer}` (buffer transferred), `{type:'entryEnd', key}`, `{type:'finish', records}`, `{type:'abort'}`. Worker→main: `{type:'ready'}`, **`{type:'unsupported', reason}`** (createSyncAccessHandle absent IN THE WORKER — the only place it can be detected; see design D8), `{type:'written', key, crc, size}`, `{type:'entryError', key, name, message}`, `{type:'finished', totalBytes}`, `{type:'fatal', name, message}`.
  - `createAssemblerClient(worker) -> { init(stagingName, layout, freshKeys) -> {supported}, writeChunk(key, u8) (transfers), endEntry(key) -> {crc,size}, finish(records) -> {totalBytes}, abort(), onFatal(cb) }` — a promise-based wrapper over the message protocol, so `runInPlaceJob` never touches raw messages. **`init` resolves `{supported:true}` on `ready` or `{supported:false, reason}` on `unsupported`** (never rejects for unsupported — that is an expected fallback, not an error). `writeChunk` resolves when posted (fire-and-forward — ordering is per-key via `endEntry`'s await); `endEntry` resolves on the matching `written`/`entryError`.

- [ ] **Step 1: Write failing tests for the client using a fake worker.**

```javascript
// test/assembler-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblerClient } from '../src/lib/assembler-client.js';

// A fake worker that echoes the protocol deterministically.
function fakeWorker() {
  const listeners = [];
  const w = {
    postMessage(msg) {
      queueMicrotask(() => {
        if (msg.type === 'init') emit({ type: 'ready' });
        else if (msg.type === 'entryEnd') emit({ type: 'written', key: msg.key, crc: 123, size: 4 });
        else if (msg.type === 'finish') emit({ type: 'finished', totalBytes: 999 });
      });
    },
    addEventListener(_e, fn) { listeners.push(fn); },
    terminate() {},
  };
  function emit(data) { for (const fn of listeners) fn({ data }); }
  return { w, emit };
}

test('client: init resolves {supported:true} on ready; endEntry resolves with written record', async () => {
  const { w } = fakeWorker();
  const c = createAssemblerClient(w);
  const initRes = await c.init('s.zip', { entries: [] }, ['x']);
  assert.deepEqual(initRes, { supported: true });
  c.writeChunk('x', new Uint8Array([1, 2, 3, 4]));
  const rec = await c.endEntry('x');
  assert.deepEqual(rec, { crc: 123, size: 4 });
  const fin = await c.finish([]);
  assert.deepEqual(fin, { totalBytes: 999 });
});

test('client: init resolves {supported:false} when the worker reports unsupported', async () => {
  const { w, emit } = fakeWorker();
  w.postMessage = (msg) => { if (msg.type === 'init') queueMicrotask(() => emit({ type: 'unsupported', reason: 'no createSyncAccessHandle in worker' })); };
  const c = createAssemblerClient(w);
  const initRes = await c.init('s.zip', { entries: [] }, []);
  assert.equal(initRes.supported, false);
  assert.match(initRes.reason, /createSyncAccessHandle/);
});

test('client: entryError rejects the matching endEntry', async () => {
  const { w, emit } = fakeWorker();
  // override entryEnd to error
  const orig = w.postMessage;
  w.postMessage = (msg) => { if (msg.type === 'entryEnd') queueMicrotask(() => emit({ type: 'entryError', key: msg.key, name: 'Bad', message: 'nope' })); else orig(msg); };
  const c = createAssemblerClient(w);
  await c.init('s.zip', { entries: [] }, ['x']);
  await assert.rejects(() => c.endEntry('x'), /nope/);
});

test('client: onFatal fires on a fatal message', async () => {
  const { w, emit } = fakeWorker();
  const c = createAssemblerClient(w);
  let fatal = null;
  c.onFatal((f) => { fatal = f; });
  await c.init('s.zip', { entries: [] }, []);
  emit({ type: 'fatal', name: 'QuotaExceededError', message: 'full' });
  assert.equal(fatal.name, 'QuotaExceededError');
});
```

- [ ] **Step 2: Run to verify failure.** Run: `node --test test/assembler-client.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement the client and the worker.**

```javascript
// src/lib/assembler-client.js
// Copyright (C) 2026 HidayahTech, LLC
// Promise-based bridge over the zip-assembler worker's message protocol, so runInPlaceJob
// never touches raw postMessage. See the design doc (D1, D7).
export function createAssemblerClient(worker) {
  const pendingEnd = new Map(); // key -> {resolve, reject}
  let readyResolve, finishResolve, finishReject;
  let fatalCb = null;
  worker.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'ready') readyResolve?.({ supported: true });
    else if (m.type === 'unsupported') readyResolve?.({ supported: false, reason: m.reason });
    else if (m.type === 'written') pendingEnd.get(m.key)?.resolve({ crc: m.crc, size: m.size });
    else if (m.type === 'entryError') pendingEnd.get(m.key)?.reject(Object.assign(new Error(m.message), { name: m.name }));
    else if (m.type === 'finished') finishResolve?.({ totalBytes: m.totalBytes });
    else if (m.type === 'fatal') { fatalCb?.({ name: m.name, message: m.message }); finishReject?.(Object.assign(new Error(m.message), { name: m.name })); }
  });
  return {
    init(stagingName, layout, freshKeys) {
      return new Promise((res) => { readyResolve = res; worker.postMessage({ type: 'init', stagingName, layout, freshKeys }); });
    },
    writeChunk(key, u8) {
      const buffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      worker.postMessage({ type: 'chunk', key, buffer }, [buffer]);
    },
    endEntry(key) {
      return new Promise((resolve, reject) => { pendingEnd.set(key, { resolve, reject }); worker.postMessage({ type: 'entryEnd', key }); })
        .finally(() => pendingEnd.delete(key));
    },
    finish(records) {
      return new Promise((res, rej) => { finishResolve = res; finishReject = rej; worker.postMessage({ type: 'finish', records }); });
    },
    abort() { worker.postMessage({ type: 'abort' }); },
    onFatal(cb) { fatalCb = cb; },
  };
}
```

```javascript
// src/worker/zip-assembler.worker.js
// Copyright (C) 2026 HidayahTech, LLC
// Owns the single exclusive SyncAccessHandle on the staging ZIP and does positioned writes.
// Bundled + inlined as a Blob URL by build.mjs (single-file guarantee). Runtime imports none.
import { createAssembler } from '../lib/zip-assemble.js';

let asm = null;
let handle = null;

function syncSink(sync) {
  return {
    write(u8, at) { sync.write(u8, { at }); },
    truncate(n) { sync.truncate(n); },
    flush() { sync.flush(); },
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      // Worker-scope OPFS may be absent even where the window has it (WebKit exposes
      // navigator.storage on the window but not in a DedicatedWorker) — report unsupported
      // so runInPlaceJob falls back to serial, never fatals (design D8, proven by the probe).
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
        self.postMessage({ type: 'unsupported', reason: 'no OPFS in worker' });
        return;
      }
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.stagingName, { create: true });
      // The ONLY place createSyncAccessHandle can be detected (worker scope). If absent,
      // report unsupported so runInPlaceJob falls back to the serial engine (design D8).
      if (typeof fh.createSyncAccessHandle !== 'function') {
        self.postMessage({ type: 'unsupported', reason: 'no createSyncAccessHandle in worker' });
        return;
      }
      handle = await fh.createSyncAccessHandle();
      asm = createAssembler(syncSink(handle), m.layout);
      await asm.writeHeaders();
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'chunk') {
      await asm.writeChunk(m.key, new Uint8Array(m.buffer));
    } else if (m.type === 'entryEnd') {
      try { const r = await asm.endEntry(m.key); self.postMessage({ type: 'written', key: m.key, crc: r.crc, size: r.size }); }
      catch (err) { self.postMessage({ type: 'entryError', key: m.key, name: err?.name || 'Error', message: err?.message || String(err) }); }
    } else if (m.type === 'finish') {
      const r = await asm.finish(m.records);
      try { handle.close(); } catch { /* best effort */ }
      self.postMessage({ type: 'finished', totalBytes: r.totalBytes });
    } else if (m.type === 'abort') {
      try { handle?.flush(); handle?.close(); } catch { /* best effort */ }
    }
  } catch (err) {
    self.postMessage({ type: 'fatal', name: err?.name || 'Error', message: err?.message || String(err) });
  }
};
```

- [ ] **Step 4: Run tests to verify pass.** Run: `node --test test/assembler-client.test.js` then `npm test` — Expected: PASS. (The worker file itself is not node-testable — it is validated by the e2e in Task 8; the client bridge and assembler core carry the unit coverage.)

- [ ] **Step 5: Commit.**

```bash
git add src/worker/zip-assembler.worker.js src/lib/assembler-client.js test/assembler-client.test.js
git commit -m "feat: zip-assembler worker + promise client bridge (in-place)"
```

---

## Task 5: `zip-inplace.js` — the in-place orchestrator

**Files:**
- Create: `src/lib/zip-inplace.js`
- Test: `test/zip-inplace.test.js`

**Interfaces:**
- Consumes: `computeZipLayout` (T2); `createAssemblerClient` (T4); `takeItemsPage`, `updateItem`, `countItemsByStatus`, `ITEM_STATUS` (download-records.js); `runPool` (upload-queue.js); `PROBE_KIND` (download-preflight.js); `zipEntryPath` (zip-job.js).
- Produces: `runInPlaceJob(job, { presign, probe, fetchImpl = fetch, root, concurrency, makeWorker, onProgress, shouldCancel = () => false }) -> { issued, failed, cancelled, errors, blocked, finished }` — the SAME return shape as `runZipJob`, so `runZipJob`'s caller is unchanged. `makeWorker()` returns a fresh `Worker` (injectable so tests pass a fake). Order of entries = key-sorted (`takeItemsPage`), deterministic across resume.

- [ ] **Step 1: Write a failing orchestrator test with a fake worker + in-memory records.**

Use `fake-indexeddb` (as `indexeddb-storage.test.js` does) to back the records, seed a job's items (all PENDING), inject a fake `presign`/`probe`/`fetchImpl`, and a fake worker whose `postMessage` drives a real in-memory `createAssembler` so the produced bytes can be validated as a real ZIP. Assert: all items become DONE, `finished === true`, and the assembled bytes round-trip (central directory present, entry count correct). Then a second arm: mark one item's fetch to fail once → it lands FAILED, `finished === false`; re-run (resetFailed→pending externally) → completes.

```javascript
// test/zip-inplace.test.js  (skeleton — fill the fakes analogously to zip-prefetch tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { appendManifestPage, saveJob, countItemsByStatus, ITEM_STATUS } from '../src/lib/download-records.js';
import { computeZipLayout } from '../src/lib/zip-layout.js';
import { createAssembler } from '../src/lib/zip-assemble.js';
import { runInPlaceJob } from '../src/lib/zip-inplace.js';

// A fake worker that runs the REAL assembler over an in-memory sink, so the orchestrator's
// output is validated as real ZIP bytes without a browser.
function inMemoryWorker(captured) {
  let buf = new Uint8Array(0), asm = null, listeners = [];
  const sink = { write(u8, at){ if(at+u8.length>buf.length){const n=new Uint8Array(at+u8.length);n.set(buf);buf=n;} buf.set(u8,at); }, truncate(n){ const nb=new Uint8Array(n); nb.set(buf.subarray(0,Math.min(n,buf.length))); buf=nb; }, flush(){} };
  const emit = (data) => { for (const fn of listeners) fn({ data }); };
  return {
    addEventListener(_e, fn){ listeners.push(fn); },
    terminate(){ captured.bytes = buf; },
    async postMessage(m /*, transfer */){
      if (m.type==='init'){ asm=createAssembler(sink,m.layout); await asm.writeHeaders(); emit({type:'ready'}); }
      else if (m.type==='chunk'){ await asm.writeChunk(m.key, new Uint8Array(m.buffer)); }
      else if (m.type==='entryEnd'){ try{ const r=await asm.endEntry(m.key); emit({type:'written',key:m.key,crc:r.crc,size:r.size}); }catch(err){ emit({type:'entryError',key:m.key,name:err.name,message:err.message}); } }
      else if (m.type==='finish'){ const r=await asm.finish(m.records); captured.bytes=buf; emit({type:'finished',totalBytes:r.totalBytes}); }
    },
  };
}

test('runInPlaceJob: all items DONE, finished, valid central directory', async () => {
  const job = { id: 'j1', prefix: 'p/', status: 'running', counters: {} };
  await saveJob(job);
  const items = [
    { key: 'p/a.txt', size: 3, lastModified: 0, status: ITEM_STATUS.PENDING },
    { key: 'p/b.txt', size: 5, lastModified: 0, status: ITEM_STATUS.PENDING },
  ];
  await appendManifestPage('j1', items, { done: true });
  const bodies = { 'p/a.txt': [65,66,67], 'p/b.txt': [1,2,3,4,5] };
  const captured = {};
  const res = await runInPlaceJob(job, {
    presign: async (key) => `https://x/${key}`,
    probe: null,
    fetchImpl: async (url) => ({ ok: true, body: streamOf(bodies[url.split('/x/')[1]]) }),
    root: {}, concurrency: 2,
    makeWorker: () => inMemoryWorker(captured),
    onProgress: () => {},
  });
  assert.equal(res.finished, true);
  assert.equal(await countItemsByStatus('j1', ITEM_STATUS.DONE), 2);
  // EOCD signature present at the tail
  const dv = new DataView(captured.bytes.buffer);
  // find EOCD 0x06054b50 near the end
  let found = false;
  for (let i = captured.bytes.length - 22; i >= 0 && i > captured.bytes.length - 200; i--) { if (dv.getUint32(i, true) === 0x06054b50) { found = true; break; } }
  assert.equal(found, true);
});

function streamOf(arr) {
  const u8 = new Uint8Array(arr); let sent = false;
  return { getReader(){ return { read(){ if(sent) return Promise.resolve({done:true}); sent=true; return Promise.resolve({done:false,value:u8}); } }; } };
}
```

- [ ] **Step 2: Run to verify failure.** Run: `node --test test/zip-inplace.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement `runInPlaceJob`.**

Structure (mirror `runZipJob`'s resume/records/cancel/quota, but drive the worker):
1. Gather ALL non-SKIPPED items in key order via `takeItemsPage` pagination → `allItems`. Build `layout = computeZipLayout(allItems, prefix)`.
2. Resume guard — runs BEFORE the worker inits (the worker's init truncates/creates the file, which would mask an eviction). Only when DONE items exist: `const fh = await root.getFileHandle(stagingName(job.id)).catch(() => null); const size = fh ? (await fh.getFile()).size : 0;` if `size < layout.totalDataEnd` (missing/evicted/short) → reset every DONE item to PENDING (`updateItem` clearing `zipOffset/zipEnd/crc`) and treat as fresh. With **no** DONE items it is a fresh job — skip this entirely (so a unit test passing `root:{}` never touches OPFS). `freshKeys` = keys currently PENDING after the guard.
3. Spawn the worker via `makeWorker()`; `client = createAssemblerClient(worker)`; `const { supported } = await client.init(stagingName(job.id), layout, freshKeys)`. **If `!supported`** (createSyncAccessHandle absent in this worker — design D8): `worker.terminate()` and `return { unsupported: true }` immediately, before any fetch. `runZipJob` (Task 6) sees this sentinel and runs the serial engine instead — a clean runtime fallback with nothing fetched. Otherwise wire `client.onFatal` → set `quotaBlocked = { kind:'STORAGE', ... }` if `name==='QuotaExceededError'`, else a generic block; then request cancel.
4. `pendingItems` = PENDING items. Run them through `runPool(pendingItems, processItem, concurrency)`:
   - `processItem(item)`: `noteCancel`; presign; optional `probe` (NETWORK → job-wide block+abort, DENIED streak → block, other non-OK → push failed); `fetch`; read the body reader loop; for each chunk `client.writeChunk(item.key, chunk)` and `bump(chunk.length)` for progress + active tracking; on stream end `const rec = await client.endEntry(item.key)`; `await updateItem(job.id, item.key, { status: DONE, zipOffset: layoutEntry.headerOffset, zipEnd: layoutEntry.entryEnd, crc: rec.crc, size: rec.size, time: layoutEntry.time, date: layoutEntry.date })`; `completed++`; `emitProgress()`. Catch: AbortError under cancel/block → leave untouched; else push `{item, message}` to failed.
   - Reuse the rolling-DENIED and NETWORK-block logic from `zip-prefetch.js` (copy the small breaker; it is ~15 lines). Active-file tracking + progress mirror `zip-prefetch`'s `activeState`/`emitProgress` so the existing progress UI keeps working unchanged.
5. After the pool: compute `cancelled`/`blocked` exactly as `runZipJob` does. Mark FAILED items, accumulate capped `errors` (MAX_ERROR_SAMPLE = 50).
6. Finish: `pending = countItemsByStatus(PENDING)`, `failed = countItemsByStatus(FAILED)`. If `!cancelled && !blocked && pending===0 && failed===0`: build `records` from ALL items in layout order — read each DONE item's persisted `{crc,size,time,date}` and the layout's `headerOffset` → `records = layout.entries.map(e => ({ path: e.path, zipOffset: e.headerOffset, size: doneByKey.get(e.key).size, crc: doneByKey.get(e.key).crc, time: e.time, date: e.date }))`; `await client.finish(records)`; `finished = true`. Else `client.abort()`.
7. `worker.terminate()`. Return `{ issued: completed - priorCompleted, failed, cancelled, errors, blocked, finished }`.

Keep `stagingName`, `MAX_ERROR_SAMPLE`, and the progress payload shape identical to `zip-job.js` (import/duplicate the tiny constants as needed; prefer importing `stagingName` by exporting it from `zip-job.js`).

- [ ] **Step 4: Run tests to verify pass.** Run: `node --test test/zip-inplace.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/zip-inplace.js test/zip-inplace.test.js
git commit -m "feat: runInPlaceJob orchestrator — concurrent fetch → worker positioned writes"
```

---

## Task 6: Capability detection + engine selection in `runZipJob`

**Files:**
- Modify: `src/lib/browser-capability.js` — add `webWorker` to `detectCapabilities`; add `inPlaceSupported(caps)`.
- Modify: `src/lib/zip-job.js` — `runZipJob` selects the engine and handles the runtime-fallback sentinel.
- Modify: `src/components/App.jsx` — pass a `makeWorker` factory (and the caps) into the zip start path.
- Test: `test/browser-capability.test.js` (or wherever caps are tested) + a `zip-job` selection unit test.

**IMPORTANT correction (design D8, proven by the Task 1 fidelity probe): `createSyncAccessHandle` is exposed ONLY in worker global scope and canNOT be feature-detected from the main thread** — `window.FileSystemFileHandle.prototype.createSyncAccessHandle` is `undefined` even on engines that support it in a worker. So there is NO `syncAccessHandle` main-thread capability. Selection is **optimistic**: gate on what IS detectable (`opfs && streamingFetch && webWorker`), then let `runInPlaceJob`'s worker `init` self-report support and fall back at runtime (T5 returns `{ unsupported: true }`).

**Interfaces:**
- Consumes: `runInPlaceJob` (T5), which may return `{ unsupported: true }` (worker lacks the sync handle → fall back).
- Produces: `inPlaceSupported(caps) -> boolean` (`caps.opfs && caps.streamingFetch && caps.webWorker` — NO syncAccessHandle term). `selectZipEngine(caps, makeWorker) -> 'inplace' | 'serial'`. `runZipJob(job, opts)` gains `makeWorker` + `caps` in `opts`; when `selectZipEngine === 'inplace'`, it calls `runInPlaceJob` and — if that returns `{ unsupported: true }` — transparently runs the serial body instead; otherwise it runs the serial body directly. All return the same shape, so callers are unchanged.

- [ ] **Step 1: Write failing tests.**

```javascript
// in test/browser-capability.test.js (add)
import { detectCapabilities, inPlaceSupported } from '../src/lib/browser-capability.js';
test('webWorker feature-detected; inPlaceSupported gates on opfs+streamingFetch+webWorker', () => {
  const win = {
    navigator: { storage: { getDirectory(){} } },
    Response: { prototype: { body: 1 } },
    FileSystemFileHandle: { prototype: { createWritable(){} } },
    Worker: function(){},
  };
  const caps = detectCapabilities(win);
  assert.equal(caps.webWorker, true);
  assert.equal(inPlaceSupported(caps), true);
  assert.equal(inPlaceSupported({ ...caps, webWorker: false }), false);
  assert.equal(inPlaceSupported({ ...caps, opfs: false }), false);
});
```

```javascript
// test/zip-job-engine.test.js (new) — selection helper (worker-scope caps can't be tested on main thread)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectZipEngine } from '../src/lib/zip-job.js';
test('selectZipEngine returns in-place only when caps support it AND a worker factory is given', () => {
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:1 }, () => ({})), 'inplace');
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:0 }, () => ({})), 'serial');
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:1 }, null), 'serial');
});
```

- [ ] **Step 2: Run to verify failure.** Run: `node --test test/browser-capability.test.js test/zip-job-engine.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement.**

In `browser-capability.js` `detectCapabilities`, add just:
```javascript
    webWorker:        typeof win?.Worker === 'function',
```
(Do NOT add a `syncAccessHandle` cap — it cannot be detected here and a false value would be misleading.) Then export:
```javascript
export function inPlaceSupported(caps) {
  return !!(caps?.opfs && caps?.streamingFetch && caps?.webWorker);
}
```

In `zip-job.js`, add `export function selectZipEngine(caps, makeWorker) { return (inPlaceSupported(caps) && makeWorker) ? 'inplace' : 'serial'; }` (import `inPlaceSupported`). Extract the current serial body into a local `runSerialZipJob(job, opts)` (same code, moved). Then:
```javascript
export async function runZipJob(job, opts) {
  if (selectZipEngine(opts.caps, opts.makeWorker) === 'inplace') {
    const r = await runInPlaceJob(job, opts);
    if (!r || !r.unsupported) return r;      // in-place ran (or is running): done
    // else: worker lacked the sync handle at runtime — fall through to serial (design D8)
  }
  return runSerialZipJob(job, opts);
}
```
`runInPlaceJob` and the serial body share the same `opts` and return shape, so callers are untouched. Import `runInPlaceJob` from `./zip-inplace.js` (note: `zip-inplace.js` imports `zipEntryPath`/`stagingName` from `zip-job.js` — keep the import direction one-way by having `zip-job.js` import only `runInPlaceJob`; if a circular-init error appears, move `zipEntryPath`/`stagingName` to a small `zip-naming.js` both import).

In `App.jsx`, where `handleZipStart` calls `runZipJob(...)`, pass `caps` (already detected in the app) and `makeWorker: () => makeAssemblerWorker()` where `makeAssemblerWorker` comes from the build-inlined blob (Task 7 provides `src/lib/assembler-worker-url.js` exporting `makeAssemblerWorker()`); import it. On a browser without support, `makeWorker` is still passed but `inPlaceSupported` is false, so the serial path runs.

- [ ] **Step 4: Run tests to verify pass.** Run: `node --test test/browser-capability.test.js test/zip-job-engine.test.js` then `npm test` and `npm run test:ui` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/browser-capability.js src/lib/zip-job.js src/components/App.jsx test/browser-capability.test.js test/zip-job-engine.test.js
git commit -m "feat: gate + select in-place engine; serial path is the fallback"
```

---

## Task 7: Build integration — inline the worker as a Blob URL

**Files:**
- Modify: `build.mjs` — bundle `src/worker/zip-assembler.worker.js` separately; inject the source as a string into the app bundle via a generated module; add a build invariant.
- Create: `src/lib/assembler-worker-url.js` — a thin module the app imports; at build time its `__WORKER_SRC__` placeholder is replaced with the bundled worker source.
- Test: `test/build.test.js` (add an assertion) + a source-invariant.

**Interfaces:**
- Produces: `makeAssemblerWorker() -> Worker` (from `assembler-worker-url.js`) — creates the worker from an inlined Blob URL; single-file guarantee preserved.

- [ ] **Step 1: Add the placeholder module + a failing build assertion.**

```javascript
// src/lib/assembler-worker-url.js
// Copyright (C) 2026 HidayahTech, LLC
// The zip-assembler worker, inlined by build.mjs as a Blob URL (single-file build).
// __WORKER_SRC__ is replaced at build time with the bundled worker IIFE source.
const WORKER_SRC = '__WORKER_SRC__';
let cachedUrl = null;
export function makeAssemblerWorker() {
  if (!cachedUrl) cachedUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  return new Worker(cachedUrl);
}
export const workerInlined = () => WORKER_SRC !== '__WORKER_SRC__' && WORKER_SRC.length > 0;
```

In `test/build.test.js` add: after a prod build, assert `dist/index.html` contains the worker's signature string (e.g. `createSyncAccessHandle`) proving the worker source was inlined, and does NOT contain the literal `'__WORKER_SRC__'` placeholder.

```javascript
test('worker source is inlined into the single-file bundle', () => {
  const html = readFileSync('dist/index.html', 'utf8');
  assert.ok(html.includes('createSyncAccessHandle'), 'worker source must be inlined');
  assert.ok(!html.includes('__WORKER_SRC__'), 'placeholder must be replaced at build');
});
```

- [ ] **Step 2: Run to verify failure.** Run: `npm run build && node --test test/build.test.js` — Expected: FAIL (placeholder not replaced yet).

- [ ] **Step 3: Implement the build step.**

In `build.mjs`, before the main `esbuild.build` of `src/main.jsx`: bundle the worker to a string —
```javascript
const workerBuild = await esbuild.build({
  entryPoints: ['src/worker/zip-assembler.worker.js'],
  bundle: true, format: 'iife', write: false,
  minify: mode.minify, sourcemap: false, target: 'es2020',
});
const workerSrc = workerBuild.outputFiles[0].text;
```
Then make the app bundle substitute it. Use an esbuild `define` won't work for a large string cleanly; instead use a `banner`/plugin OR the simplest robust approach: an esbuild plugin that resolves `assembler-worker-url.js` and returns its source with `'__WORKER_SRC__'` replaced by `JSON.stringify(workerSrc)`'s inner content. Concretely, a plugin:
```javascript
const inlineWorker = {
  name: 'inline-worker',
  setup(b) {
    b.onLoad({ filter: /assembler-worker-url\.js$/ }, async (args) => {
      const src = readFileSync(args.path, 'utf8').replace("'__WORKER_SRC__'", JSON.stringify(workerSrc));
      return { contents: src, loader: 'js' };
    });
  },
};
```
Add `plugins: [inlineWorker]` to the main `esbuild.build`. This replaces the placeholder with a proper JS string literal of the worker source, which esbuild then bundles/minifies + inlines into the single HTML as usual.
Add a build invariant (prod only), next to the existing ones:
```javascript
if (!html.includes('createSyncAccessHandle')) { console.error('INVARIANT: assembler worker source missing from bundle'); process.exit(1); }
```

- [ ] **Step 4: Run to verify pass.** Run: `npm run build && node --test test/build.test.js` — Expected: PASS. Also `npm test` (full).

- [ ] **Step 5: Commit.**

```bash
git add build.mjs src/lib/assembler-worker-url.js test/build.test.js
git commit -m "build: inline the zip-assembler worker as a Blob URL + invariant"
```

---

## Task 8: E2E — in-place engine produces a valid ZIP; resume; fallback lane

**Files:**
- Create/modify: `test/e2e/zip-inplace.e2e.mjs` (new) and/or extend the existing ZIP e2e spec.

**Interfaces:**
- Consumes: the built app (Task 7); the stateful mock S3 server + harness (`test/e2e/harness.mjs`, `collectDownloads`, `mock.requestLog`).

- [ ] **Step 1: Write the e2e spec (observable = byte-valid ZIP + request log).**

Arms (Chromium/Firefox lanes assert in-place path; WebKit lane asserts fallback still yields a valid ZIP if unsupported):
1. **Happy path:** connect to the mock, select a folder of N mixed-size files (include ≥1 medium 4–64 MiB and ≥1 tiny), start a ZIP download. Observe: the staged file downloads; unzip the resulting bytes in-page (or pull from OPFS) and assert every entry's bytes match what the mock served (`mock.requestLog` shows the GETs). This is the presence observable.
2. **Resume:** use the mock's `killAtByte` fault mid-job; assert the job pauses/retries; resume; assert the final ZIP is byte-valid and complete.
3. **Engine identity:** assert (via a `window.__lastZipEngine` test hook set in `runZipJob`, or a console log) that Chromium/Firefox used `'inplace'` and the fallback lane used `'serial'`. Add the hook minimally in `runZipJob` behind the existing test-only surface if one exists; otherwise expose `window.__lastZipEngine`.

- [ ] **Step 2: Run across the container matrix.**

Run: `npm run test:e2e:container`
Babysit in the foreground. Record image tag + browser versions.

- [ ] **Step 3: Record results (matched to the baseline from Task 0).**

Append per-engine pass/fail to `docs/superpowers/plans/inplace-baseline.md`. Note which engines ran in-place vs fallback.

- [ ] **Step 4: Commit.**

```bash
git add test/e2e/zip-inplace.e2e.mjs docs/superpowers/plans/inplace-baseline.md src/lib/zip-job.js
git commit -m "test: e2e — in-place ZIP downloads byte-valid; resume; fallback lane"
```

---

## Task 9: #59 memory verification (matched pair)

**Files:**
- Create: `test/e2e/inplace-memory.e2e.mjs` (Firefox lane) or a probe under `docs/review-download-parity/probe/`.

**Interfaces:** Consumes the built app + mock. Proves the primary motivation: Firefox process memory is flat on the in-place path where it grew on the serial path.

- [ ] **Step 1: Write the matched-pair memory probe.**

Firefox lane: run a many-medium-file ZIP twice — once forcing the serial engine (temporarily pass `makeWorker: null` or a `?engine=serial` test hook), once in-place. Sample process memory (via the harness's existing memory sampling used for the earlier #59 probe — reuse `docs/review-download-parity/probe/` tooling). Assert in-place peak RSS growth is materially below the serial path's (the serial path reproduces the ≈48 MiB/file growth; in-place should be flat — no temp cycle).

- [ ] **Step 2: Run on Firefox in the container; record both curves.**

Run: `E2E_ENGINES=firefox npm run test:e2e:container` (labelled control run — record image + version). This is the one legitimate `E2E_ENGINES` scoping: a labelled memory control, not a coverage claim.

- [ ] **Step 3: Record the matched pair in the BUG-LOG entry source and the probe dir.**

- [ ] **Step 4: Commit.**

```bash
git add test/e2e/inplace-memory.e2e.mjs docs/review-download-parity/probe/
git commit -m "test: matched-pair memory probe — in-place is flat where serial leaked (#59)"
```

---

## Task 10: Release v1.49.0

**Files:** `package.json`, `CHANGELOG.md`, `BUG-LOG.md`, `dist/index.html`, `src/lib/changelog.js`.

- [ ] **Step 1: BUG-LOG entry for #59.** Add an entry: Symptom (Firefox tab OOM on many-medium-file ZIP), Root cause (OPFS temp write→read-back→delete cycle triggers Gecko process-memory growth), Fix (in-place composition removes the temp cycle entirely), Why not caught earlier (on-disk OPFS stayed flat; only process RSS grew, invisible to disk-based checks), Test case (Task 9 matched-pair Firefox memory probe).

- [ ] **Step 2: CHANGELOG entry** at the top:
```
## [1.49.0] — 2026-08-04 — In-place ZIP composition
```
with bullets: worker-owned positioned writes into precomputed slots; eliminates the OPFS temp read-back cycle and the Firefox memory leak (#59); serial path retained as fallback for browsers without worker sync handles; no format change.

- [ ] **Step 3: Bump + build.**
```bash
npm version 1.49.0 --no-git-tag-version
npm run build
```

- [ ] **Step 4: Full verification gate.**
Run: `npm test` — Expected: PASS
Run: `npm run test:ui` — Expected: PASS
Run: `npm run test:e2e:container` — Expected: PASS (record image + versions)

- [ ] **Step 5: Commit the release.**
```bash
git add package.json package-lock.json CHANGELOG.md BUG-LOG.md dist/index.html src/lib/changelog.js
git commit -m "release: v1.49.0 — in-place ZIP composition (fixes #59)"
```

- [ ] **Step 6: Finish the branch (requesting-code-review, then merge/deploy).**
Use `superpowers:requesting-code-review` for a whole-branch review; address findings. Then per `superpowers:finishing-a-development-branch`: push, open the MR, let CI's full matrix pass, merge to `main`, confirm Forge deploy, and live-verify the deployed instance serves 1.49.0. Comment on GitLab #59 with the fix + verification and close it.

---

## Self-review (spec coverage)

- Spec D1 (fetch-main/assembler-worker) → T4/T5. D2 (parallel engine, runPrefetch fallback) → T5/T6. D3 (descriptors, byte-identical for same order) → T2/T3 parity tests. D4 (layout once, pure) → T2. D5 (resume/cancel/quota reuse) → T5. D6 (fidelity probe gate) → T1. D7 (worker inlined) → T7. D8 (caps gate) → T6. D9 (v1.49.0) → T10. #59 memory → T9. E2E observable → T8. Baseline → T0.
- No placeholders: all code steps carry real code or exact structural instructions with named signatures.
- Type consistency: `computeZipLayout` shape, assembler methods (`writeHeaders/writeChunk/endEntry/finish`), client methods (`init/writeChunk/endEntry/finish/abort/onFatal`), worker protocol message types, and `inPlaceSupported`/`selectZipEngine` names are used identically across T2–T8.
