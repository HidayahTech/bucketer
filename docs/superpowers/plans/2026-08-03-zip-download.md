# ZIP Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Download as one ZIP" delivery: stream a store-only ZIP64 into one OPFS staging file through the existing `runDownloadJob` engine, resume at file granularity, export as a single browser download.

**Architecture:** `zip-writer.js` (pure ZIP64 format over an injected sink) + `zip-job.js` (OPFS sink, gate arithmetic, orchestration over `runDownloadJob`, resume, finish-from-persisted-records) + App wiring (`handleZipStart`, export anchor, discard cleanup) + panel UI (gated second start button, persist() action, zip job rows).

**Tech Stack:** Preact, esbuild, `node --test`, fake OPFS test double (in-repo), jsdom via `npm run test:ui`, Playwright container matrix. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-03-zip-download-design.md` — read it first. Its "Operator decisions" and "Bounds" sections bind this plan.

## Global Constraints

- Branch: `zip-download`. Never push without operator confirmation; pre-push hook builds + tests and tags the working-tree `package.json` version.
- `npm test` (unit) / `npm run test:ui` (component, `../helpers/with-dom.js` first import) / `npm run test:e2e:container` (only source of e2e coverage claims; baseline first per the E2E Evidence Rules).
- Store-only ZIP (method 0); ZIP64 records when any threshold crossed (entry or total ≥ 4 GiB, > 65 535 entries); thresholds injectable for tests.
- Feature detection only (`opfs && streamingFetch && writableFiles`), never browser names. Quota headroom: existing `QUOTA_SAFETY = 0.9` from `src/lib/browser-capability.js`.
- `persist()` requested ONLY on the doesn't-fit gate path, and only when `navigator.storage.persisted()` is false.
- All job/item model changes additive; legacy handoff jobs (`delivery` undefined) must behave exactly as today.
- Copy style: sentence case, plain, no exclamation marks.
- Version bump only in the final task, only after operator confirms level, with CHANGELOG + rebuilt `dist/index.html` + `src/lib/changelog.js` in the same commit.

---

### Task 0: E2E baseline on the untouched tree

**Files:** none changed.

- [ ] **Step 1:** `git status --short` — no modified tracked files (untracked legacy docs are expected).
- [ ] **Step 2:** Run `npm run test:e2e:container` to completion (10–20 min; babysit — no output for 5+ min means kill, diagnose, re-run). Record per-lane pass/fail counts and the image tag.
- [ ] **Step 3:** Write the record to `.claude-scratch/e2e-baseline-2026-08-03.txt` (HEAD, image, per-lane rows that actually sum). Do not commit it.

---

### Task 1: `zip-writer.js` — the format, complete

**Files:**
- Create: `src/lib/zip-writer.js`
- Test: `test/zip-writer.test.js`

**Interfaces:**
- Consumes: nothing (pure; sink injected).
- Produces:
  - `crc32(bytes, seed = 0) -> number` (unsigned) — exported for tests.
  - `createZipWriter(sink, { zip64Limit = 0xFFFFFFFF, maxEntries = 0xFFFF, startOffset = 0 } = {})` where `sink = { write(uint8array) }` (may return a promise). Returns:
    - `offset` (getter, bytes written so far including `startOffset`)
    - `async beginEntry(path, { mtime = null, declaredSize = 0 } = {})`
    - `async update(chunk)` — Uint8Array
    - `async endEntry() -> { path, zipOffset, zipEnd, size, crc }` — throws if streamed length ≠ `declaredSize`
    - `async finish(entries) -> { totalBytes }` — central directory + EOCD (+ ZIP64 records when needed); `entries` is an array of entry records (possibly reloaded from persistence, order = physical append order is NOT required; records carry their own offsets).

- [ ] **Step 1: Write the failing tests.** The test file needs a mini ZIP reader — include it verbatim; it is deliberately independent of the writer's code paths (reads from the END via EOCD, not by replaying offsets):

```js
// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-writer.js — store-only streaming ZIP64 writer.
//
// The reader here is the test's independent witness: it starts from the EOCD at the end
// of the buffer (how real extractors work), walks the central directory, and checks each
// local entry + data descriptor against it. CRCs are cross-checked with a separate,
// table-free bitwise CRC-32 so a shared table bug cannot self-verify.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createZipWriter, crc32 } from '../src/lib/zip-writer.js';

function memSink() {
  const chunks = [];
  return {
    chunks,
    write(u8) { chunks.push(Uint8Array.from(u8)); },
    bytes() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

// Independent bitwise CRC-32 (reflected, poly 0xEDB88320) — no table.
function refCrc(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// Minimal reader: EOCD (with optional ZIP64 EOCD) -> central entries -> local checks.
function readZip(u8) {
  const d = dv(u8);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (d.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'EOCD signature present');
  let count = d.getUint16(eocd + 10, true);
  let cdSize = d.getUint32(eocd + 12, true);
  let cdOff = d.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    const locOff = eocd - 20;
    assert.equal(d.getUint32(locOff, true), 0x07064b50, 'ZIP64 EOCD locator present');
    const z64Off = Number(d.getBigUint64(locOff + 8, true));
    assert.equal(d.getUint32(z64Off, true), 0x06064b50, 'ZIP64 EOCD present');
    count = Number(d.getBigUint64(z64Off + 32, true));
    cdSize = Number(d.getBigUint64(z64Off + 40, true));
    cdOff = Number(d.getBigUint64(z64Off + 48, true));
  }
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    assert.equal(d.getUint32(p, true), 0x02014b50, `central header ${n}`);
    const flags = d.getUint16(p + 8, true);
    const method = d.getUint16(p + 10, true);
    let crc = d.getUint32(p + 16, true);
    let csize = d.getUint32(p + 20, true);
    let usize = d.getUint32(p + 24, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const cmtLen = d.getUint16(p + 32, true);
    let lho = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra (id 0x0001): fields present only for the 0xFFFFFFFF markers, in order
    // usize, csize, offset.
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q < extraEnd) {
      const id = d.getUint16(q, true), sz = d.getUint16(q + 2, true);
      if (id === 0x0001) {
        let r = q + 4;
        if (usize === 0xFFFFFFFF) { usize = Number(d.getBigUint64(r, true)); r += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(d.getBigUint64(r, true)); r += 8; }
        if (lho === 0xFFFFFFFF) { lho = Number(d.getBigUint64(r, true)); r += 8; }
      }
      q += 4 + sz;
    }
    entries.push({ name, method, flags, crc, csize, usize, lho });
    p = p + 46 + nameLen + extraLen + cmtLen;
  }
  assert.equal(p, cdOff + cdSize, 'central directory size matches');
  // Local checks: header + streamed data + data descriptor.
  for (const e of entries) {
    assert.equal(d.getUint32(e.lho, true), 0x04034b50, `local header ${e.name}`);
    const flags = d.getUint16(e.lho + 6, true);
    assert.ok(flags & 0x0008, 'streaming bit set');
    assert.ok(flags & 0x0800, 'UTF-8 bit set');
    const nameLen = d.getUint16(e.lho + 26, true);
    const extraLen = d.getUint16(e.lho + 28, true);
    const dataStart = e.lho + 30 + nameLen + extraLen;
    const data = u8.subarray(dataStart, dataStart + e.csize);
    assert.equal(refCrc(data), e.crc, `crc of ${e.name}`);
    e.data = data;
  }
  return entries;
}

const enc = (s) => new TextEncoder().encode(s);

describe('zip-writer', () => {
  test('crc32 matches the independent bitwise implementation', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(1000)]) {
      assert.equal(crc32(enc(s)), refCrc(enc(s)));
    }
  });

  test('crc32 is incremental across chunks', () => {
    const whole = enc('the quick brown fox');
    let running = 0;
    running = crc32(whole.subarray(0, 7), running);
    running = crc32(whole.subarray(7), running);
    assert.equal(running, crc32(whole));
  });

  test('a two-entry zip reads back with correct names, bytes and CRCs', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const records = [];
    for (const [path, body] of [['a.txt', 'alpha'], ['dir/b.bin', 'bravo-bytes']]) {
      await w.beginEntry(path, { declaredSize: enc(body).length, mtime: 1700000000000 });
      await w.update(enc(body));
      records.push(await w.endEntry());
    }
    await w.finish(records);
    const entries = readZip(sink.bytes());
    assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/b.bin']);
    assert.equal(new TextDecoder().decode(entries[0].data), 'alpha');
    assert.equal(new TextDecoder().decode(entries[1].data), 'bravo-bytes');
    assert.ok(entries.every(e => e.method === 0), 'store-only');
  });

  test('entry records carry offsets usable for resume', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    await w.beginEntry('a', { declaredSize: 1 });
    await w.update(enc('x'));
    const r = await w.endEntry();
    assert.equal(r.zipOffset, 0);
    assert.equal(r.zipEnd, w.offset);
    assert.equal(r.size, 1);
  });

  test('a declared-size mismatch throws at endEntry', async () => {
    const w = createZipWriter(memSink());
    await w.beginEntry('a', { declaredSize: 5 });
    await w.update(enc('xy'));
    await assert.rejects(() => w.endEntry(), /declared/);
  });

  test('multi-chunk update accumulates size and crc', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const body = enc('0123456789'.repeat(100));
    await w.beginEntry('big.txt', { declaredSize: body.length });
    for (let i = 0; i < body.length; i += 64) await w.update(body.subarray(i, i + 64));
    const r = await w.endEntry();
    await w.finish([r]);
    const [e] = readZip(sink.bytes());
    assert.equal(e.usize, body.length);
    assert.equal(e.crc, refCrc(body));
  });

  test('zip64: a tiny injected limit forces ZIP64 records that still read back', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { zip64Limit: 8 }); // any entry >= 8 bytes goes zip64
    const body = enc('0123456789'); // 10 bytes >= limit
    await w.beginEntry('big', { declaredSize: body.length });
    await w.update(body);
    const r = await w.endEntry();
    await w.finish([r]);
    const [e] = readZip(sink.bytes());
    assert.equal(e.usize, 10);
    assert.equal(new TextDecoder().decode(e.data), '0123456789');
  });

  test('zip64: a tiny maxEntries forces the ZIP64 EOCD path', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { maxEntries: 1 }); // 2 entries > 1 forces zip64 EOCD
    const records = [];
    for (const p of ['a', 'b']) {
      await w.beginEntry(p, { declaredSize: 1 });
      await w.update(enc('x'));
      records.push(await w.endEntry());
    }
    await w.finish(records);
    assert.equal(readZip(sink.bytes()).length, 2);
  });

  test('startOffset shifts recorded offsets (resume construction)', async () => {
    const sink = memSink();
    const w = createZipWriter(sink, { startOffset: 1000 });
    await w.beginEntry('a', { declaredSize: 1 });
    await w.update(enc('x'));
    const r = await w.endEntry();
    assert.equal(r.zipOffset, 1000);
  });

  test('finish accepts records out of physical order', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    const recs = [];
    for (const p of ['first', 'second']) {
      await w.beginEntry(p, { declaredSize: 1 });
      await w.update(enc('x'));
      recs.push(await w.endEntry());
    }
    await w.finish([recs[1], recs[0]]); // reversed
    assert.equal(readZip(sink.bytes()).length, 2);
  });

  test('mtime before 1980 clamps instead of corrupting the DOS field', async () => {
    const sink = memSink();
    const w = createZipWriter(sink);
    await w.beginEntry('old', { declaredSize: 1, mtime: 0 }); // 1970
    await w.update(enc('x'));
    await w.finish([await w.endEntry()]);
    readZip(sink.bytes()); // must simply parse
  });
});
```

- [ ] **Step 2:** Run `node --test test/zip-writer.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/zip-writer.js`:**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Store-only streaming ZIP64 writer over an injected byte sink.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md.
//
// Streaming means the CRC is unknown when an entry starts, so every entry sets the
// data-descriptor bit (3) and writes crc/sizes after its bytes (APPNOTE 4.4.4). Sizes ARE
// known up front (the manifest records them), which decides each entry's ZIP64-ness before
// its local header is written — and gives a free integrity check: a streamed length that
// disagrees with the manifest fails the entry rather than corrupting the archive.
// Store-only (method 0) is deliberate: S3-hosted media is mostly incompressible and CPU
// time is the enemy of 10 GiB jobs.

const SIG_LOCAL = 0x04034b50;
const SIG_DESC = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOC = 0x07064b50;
// Bit 3: sizes/crc follow the data. Bit 11: name is UTF-8.
const FLAGS = 0x0008 | 0x0800;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// DOS timestamps cannot express pre-1980; clamp rather than wrap.
function dosDateTime(mtime) {
  const d = mtime != null ? new Date(mtime) : null;
  if (!d || d.getFullYear() < 1980) return { time: 0, date: 0x21 }; // 1980-01-01 00:00
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ByteBuilder {
  constructor() { this.parts = []; this.len = 0; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  bytes() {
    const out = new Uint8Array(this.len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export function createZipWriter(sink, { zip64Limit = 0xFFFFFFFF, maxEntries = 0xFFFF, startOffset = 0 } = {}) {
  let offset = startOffset;
  let cur = null; // { path, nameBytes, zipOffset, declaredSize, zip64, crc, size, time, date }

  const write = async (u8) => { await sink.write(u8); offset += u8.length; };

  return {
    get offset() { return offset; },

    async beginEntry(path, { mtime = null, declaredSize = 0 } = {}) {
      if (cur) throw new Error('previous entry not ended');
      const nameBytes = new TextEncoder().encode(path);
      // Declared size decides descriptor width up front; offset can also force ZIP64 in
      // the central record, but that never changes the local layout.
      const zip64 = declaredSize >= zip64Limit;
      const { time, date } = dosDateTime(mtime);
      const b = new ByteBuilder();
      b.u32(SIG_LOCAL);
      b.u16(zip64 ? 45 : 20);          // version needed
      b.u16(FLAGS);
      b.u16(0);                        // method: store
      b.u16(time); b.u16(date);
      b.u32(0); b.u32(0); b.u32(0);    // crc, csize, usize: in the descriptor
      b.u16(nameBytes.length);
      b.u16(0);                        // no local extra: descriptor carries the truth
      b.push(nameBytes);
      cur = { path, zipOffset: offset, declaredSize, zip64, crc: 0, size: 0, time, date };
      await write(b.bytes());
    },

    async update(chunk) {
      if (!cur) throw new Error('no entry in progress');
      cur.crc = crc32(chunk, cur.crc);
      cur.size += chunk.length;
      await write(chunk);
    },

    async endEntry() {
      if (!cur) throw new Error('no entry in progress');
      if (cur.size !== cur.declaredSize) {
        const e = cur; cur = null;
        throw new Error(`entry ${e.path}: streamed ${e.size} bytes but declared ${e.declaredSize}`);
      }
      const b = new ByteBuilder();
      b.u32(SIG_DESC);
      b.u32(cur.crc);
      if (cur.zip64) { b.u64(cur.size); b.u64(cur.size); } else { b.u32(cur.size); b.u32(cur.size); }
      await write(b.bytes());
      const rec = { path: cur.path, zipOffset: cur.zipOffset, zipEnd: offset, size: cur.size, crc: cur.crc, time: cur.time, date: cur.date };
      cur = null;
      return rec;
    },

    async finish(entries) {
      if (cur) throw new Error('entry in progress');
      const cdStart = offset;
      for (const e of entries) {
        const nameBytes = new TextEncoder().encode(e.path);
        const sizeMark = e.size >= zip64Limit ? 0xFFFFFFFF : e.size;
        const offMark = e.zipOffset >= zip64Limit ? 0xFFFFFFFF : e.zipOffset;
        const extra = new ByteBuilder();
        if (sizeMark === 0xFFFFFFFF || offMark === 0xFFFFFFFF) {
          const fields = new ByteBuilder();
          if (sizeMark === 0xFFFFFFFF) { fields.u64(e.size); fields.u64(e.size); } // usize, csize
          if (offMark === 0xFFFFFFFF) fields.u64(e.zipOffset);
          extra.u16(0x0001); extra.u16(fields.len); extra.push(fields.bytes());
        }
        const b = new ByteBuilder();
        b.u32(SIG_CENTRAL);
        b.u16(45);                                   // version made by
        b.u16(sizeMark === 0xFFFFFFFF || offMark === 0xFFFFFFFF ? 45 : 20);
        b.u16(FLAGS); b.u16(0);
        b.u16(e.time ?? 0); b.u16(e.date ?? 0x21);
        b.u32(e.crc);
        b.u32(sizeMark); b.u32(sizeMark);
        b.u16(nameBytes.length); b.u16(extra.len); b.u16(0);
        b.u16(0); b.u16(0); b.u32(0);
        b.u32(offMark);
        b.push(nameBytes);
        b.push(extra.bytes());
        await write(b.bytes());
      }
      const cdSize = offset - cdStart;
      const needZip64 = entries.length > maxEntries || cdStart >= zip64Limit || cdSize >= zip64Limit;
      if (needZip64) {
        const z64At = offset;
        const b = new ByteBuilder();
        b.u32(SIG_Z64_EOCD); b.u64(44); b.u16(45); b.u16(45);
        b.u32(0); b.u32(0);
        b.u64(entries.length); b.u64(entries.length);
        b.u64(cdSize); b.u64(cdStart);
        b.u32(SIG_Z64_LOC); b.u32(0); b.u64(z64At); b.u32(1);
        await write(b.bytes());
      }
      const b = new ByteBuilder();
      b.u32(SIG_EOCD); b.u16(0); b.u16(0);
      const cnt = needZip64 ? 0xFFFF : entries.length;
      b.u16(cnt); b.u16(cnt);
      b.u32(needZip64 ? 0xFFFFFFFF : cdSize);
      b.u32(needZip64 ? 0xFFFFFFFF : cdStart);
      b.u16(0);
      await write(b.bytes());
      return { totalBytes: offset - startOffset };
    },
  };
}
```

- [ ] **Step 4:** `node --test test/zip-writer.test.js` — all PASS. Then `npm test` — no regressions.
- [ ] **Step 5:** Commit:

```bash
git add src/lib/zip-writer.js test/zip-writer.test.js
git commit -m "feat: store-only streaming ZIP64 writer over an injected sink"
```

---

### Task 2: `zip-job.js` part 1 — pure pieces (paths, name, gate)

**Files:**
- Create: `src/lib/zip-job.js` (pure part; Task 3 extends this file)
- Test: `test/zip-job.test.js`

**Interfaces:**
- Consumes: `sanitizeSegment` from `src/lib/download-naming.js`; `QUOTA_SAFETY` is NOT exported from browser-capability.js — export it there (one-line change, add to this task) and import it.
- Produces:
  - `zipEntryPath(key, capturedPrefix) -> string` — key relative to capturedPrefix, each segment sanitized, joined with `/`; a key not under capturedPrefix uses its full path (sanitized).
  - `zipFileName(bucket, capturedPrefix, now) -> string` — `<last folder segment or bucket>-<YYYYMMDD-HHMM>.zip`, sanitized.
  - `zipGate({ caps, sendableBytes, quota, persisted }) -> { state, reason }` with `state` ∈ `'offered' | 'needs-storage' | 'unavailable'`; `quota` is `{ quotaBytes, usageBytes }` or null (null → optimistic `'offered'`, reason `null`); `'needs-storage'` only when it doesn't fit AND `persisted === false`; doesn't fit AND `persisted === true` → `'unavailable'` with the honest size reason; missing capability → `'unavailable'` with a capability reason.

- [ ] **Step 1: Write the failing tests:**

```js
// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-job.js — pure pieces: entry paths, zip name, quota gate.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zipEntryPath, zipFileName, zipGate } from '../src/lib/zip-job.js';

const CAPS = { opfs: true, streamingFetch: true, writableFiles: true };

describe('zipEntryPath', () => {
  test('strips the captured prefix and keeps folder structure', () => {
    assert.equal(zipEntryPath('photos/2024/trip.jpg', 'photos/'), '2024/trip.jpg');
  });
  test('sanitizes each segment', () => {
    assert.equal(zipEntryPath('a/b:c/d.txt', 'a/'), 'b_c/d.txt');
  });
  test('a key outside the prefix keeps its full (sanitized) path', () => {
    assert.equal(zipEntryPath('other/x.txt', 'photos/'), 'other/x.txt');
  });
  test('empty prefix means the full key', () => {
    assert.equal(zipEntryPath('a/b.txt', ''), 'a/b.txt');
  });
});

describe('zipFileName', () => {
  const now = new Date(2026, 7, 3, 14, 5); // 2026-08-03 14:05 local
  test('uses the last folder segment when there is a prefix', () => {
    assert.equal(zipFileName('bkt', 'photos/2024/', now), '2024-20260803-1405.zip');
  });
  test('falls back to the bucket at the root', () => {
    assert.equal(zipFileName('bkt', '', now), 'bkt-20260803-1405.zip');
  });
});

describe('zipGate', () => {
  const quota = (free) => ({ quotaBytes: free + 100, usageBytes: 100 });
  test('offered when capabilities present and the job fits', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 10, quota: quota(1000), persisted: false }).state, 'offered');
  });
  test('unavailable without OPFS capability', () => {
    const g = zipGate({ caps: { ...CAPS, opfs: false }, sendableBytes: 10, quota: quota(1000), persisted: false });
    assert.equal(g.state, 'unavailable');
  });
  test('needs-storage when it does not fit and persist has not been granted', () => {
    const g = zipGate({ caps: CAPS, sendableBytes: 5000, quota: quota(1000), persisted: false });
    assert.equal(g.state, 'needs-storage');
    assert.match(g.reason, /storage/);
  });
  test('unavailable (not needs-storage) when persist is already granted and it still does not fit', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 5000, quota: quota(1000), persisted: true }).state, 'unavailable');
  });
  test('fit respects the QUOTA_SAFETY headroom, not the raw free space', () => {
    // free = 100; safety 0.9 → 90 usable; 95 must NOT fit.
    assert.notEqual(zipGate({ caps: CAPS, sendableBytes: 95, quota: quota(100), persisted: false }).state, 'offered');
  });
  test('unknown quota is optimistic', () => {
    assert.equal(zipGate({ caps: CAPS, sendableBytes: 1e15, quota: null, persisted: false }).state, 'offered');
  });
});
```

- [ ] **Step 2:** Run — FAIL (module missing).
- [ ] **Step 3: Implement** (top of the new `src/lib/zip-job.js`), and add `export` to the `QUOTA_SAFETY` const in `src/lib/browser-capability.js`:

```js
// Copyright (C) 2026 HidayahTech, LLC
// ZIP delivery: entry naming, the quota gate, and (below, Task 3) job orchestration.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md.

import { sanitizeSegment } from './download-naming.js';
import { QUOTA_SAFETY } from './browser-capability.js';

// Keys keep their real folder structure inside the zip — that is the point of the format.
// Relative to the scope's captured prefix; a key outside it (possible in a selection with
// mixed roots) keeps its full path rather than escaping upward.
export function zipEntryPath(key, capturedPrefix = '') {
  const rel = capturedPrefix && key.startsWith(capturedPrefix) ? key.slice(capturedPrefix.length) : key;
  return rel.split('/').filter(Boolean).map(sanitizeSegment).join('/');
}

export function zipFileName(bucket, capturedPrefix = '', now = new Date()) {
  const segs = capturedPrefix.split('/').filter(Boolean);
  const base = sanitizeSegment(segs.length ? segs[segs.length - 1] : bucket);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${base}-${stamp}.zip`;
}

// The gate, in the spec's order: capability, then fit, then the lazy-persist path.
// Unknown quota is optimistic per selectTier's philosophy — a quota failure is catchable
// at runtime, refusing up front denies the mechanism to browsers that will not say.
export function zipGate({ caps, sendableBytes, quota, persisted }) {
  if (!caps?.opfs || !caps?.streamingFetch || !caps?.writableFiles) {
    return { state: 'unavailable', reason: 'This browser cannot stage a ZIP.' };
  }
  if (quota?.quotaBytes == null) return { state: 'offered', reason: null };
  const free = Math.max(0, quota.quotaBytes - (quota.usageBytes ?? 0));
  if (sendableBytes <= free * QUOTA_SAFETY) return { state: 'offered', reason: null };
  const gb = (n) => (n / 1e9).toFixed(1);
  const reason = `Needs about ${gb(sendableBytes)} GB of temporary browser storage; ${gb(free)} GB available.`;
  return persisted ? { state: 'unavailable', reason } : { state: 'needs-storage', reason };
}
```

- [ ] **Step 4:** `node --test test/zip-job.test.js` PASS; `npm test` green.
- [ ] **Step 5:** Commit:

```bash
git add src/lib/zip-job.js src/lib/browser-capability.js test/zip-job.test.js
git commit -m "feat: zip entry naming and the quota gate with the lazy-persist path"
```

---

### Task 3: `zip-job.js` part 2 — orchestration, OPFS sink, resume

**Files:**
- Modify: `src/lib/zip-job.js` (extend)
- Test: `test/zip-job-run.test.js` (new; fake-indexeddb like `test/download-manifest.test.js`)

**Interfaces:**
- Consumes: `createZipWriter` (Task 1); `runDownloadJob` from `download-queue.js` (signature at `src/lib/download-queue.js:63` — injected `presign/issue/probe/onProgress/shouldCancel`); `takeItemsByStatus, updateItem, eachItemByStatus, ITEM_STATUS` from `download-records.js`; `zipEntryPath` (Task 2). Read `src/lib/download-queue.js` and `src/lib/download-records.js` fully before starting.
- Produces:
  - `openZipStaging(jobId, { root }) -> { sink, size, truncate(bytes), getFile(), remove() }` — `root` is an OPFS directory handle (or the fake below). File name: `bucketer-zip-<jobId>.zip`. `sink.write` appends at the current end.
  - `runZipJob(job, { presign, probe, fetchImpl, root, onProgress, shouldCancel }) -> { issued, failed, cancelled, errors, blocked, finished }` — `finished` true when the central directory was written. `onProgress({ done, bytesDone })`.
  - `discardZipStaging(jobId, { root })` — best-effort delete.
  - Item status semantics: completed entry → `ITEM_STATUS.DONE` with `{ zipOffset, zipEnd, size, crc, time, date }` merged onto the item (via `updateItem`); `runDownloadJob`'s own ISSUED write is superseded by an immediate DONE update inside the injected `issue` (issue completes only after the descriptor is written, so DONE is truthful).
- Resume algorithm (verbatim from the spec): collect DONE items' records; `truncate(maxZipEnd)`; if staging size < maxZipEnd or missing → reset ALL DONE items to PENDING (clear their records), truncate(0); mid-entry rewind is implicit — an entry only records on success, and `runZipJob` truncates to the last DONE `zipEnd` before starting, discarding any partial tail.

- [ ] **Step 1: Write the failing tests** — use this fake OPFS root (put it in the test file; it is also the model for what the real code needs from OPFS):

```js
// Fake OPFS directory: enough surface for openZipStaging — getFileHandle(name,
// {create}), removeEntry(name); file handles expose createWritable({keepExistingData})
// and getFile(). Backed by a Uint8Array per file.
function fakeOpfsRoot() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
        files.set(name, new Uint8Array(0));
      }
      return {
        async createWritable({ keepExistingData = false } = {}) {
          let buf = keepExistingData ? Uint8Array.from(files.get(name)) : new Uint8Array(0);
          let pos = buf.length;
          return {
            async write(u8) {
              const grown = new Uint8Array(Math.max(buf.length, pos + u8.length));
              grown.set(buf); grown.set(u8, pos); buf = grown; pos += u8.length;
            },
            async truncate(n) { buf = buf.slice(0, n); pos = Math.min(pos, n); },
            async seek(n) { pos = n; },
            async close() { files.set(name, buf); },
          };
        },
        async getFile() { const b = files.get(name); return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
}
```

Test cases (write them all; reuse `saveJob`/`loadJob`/item helpers and the `job()` factory pattern from `test/download-manifest.test.js`, a fetch fake serving deterministic bodies by key, and the mini reader from `test/zip-writer.test.js` — export it from that test file into `test/helpers/zip-reader.js` so both tests share it, and update `test/zip-writer.test.js` to import it from there):

1. `runZipJob` over a 3-item manifest produces a staging file that parses as a ZIP with exactly the 3 entry paths (via `zipEntryPath`) and correct bytes/CRCs; all items DONE with records; `finished: true`; `onProgress` saw monotonically increasing `bytesDone` ending at the total.
2. Interrupt after item 1 (a `shouldCancel` that flips true after the first completion): items = 1 DONE + 2 PENDING, `finished: false`. Second `runZipJob` call resumes: truncates to item 1's `zipEnd` (assert staging size shrank to it before growing), completes, final ZIP parses with all 3.
3. A fetch that dies mid-body for item 2 (fake fetch throws after yielding one chunk): item 2 FAILED with a message, items 1 and 3 DONE, ZIP not finished; a retry pass (reset FAILED→PENDING like `resetFailedToPending`) then a second run completes a valid 3-entry ZIP — entry order in the archive is 1,3,2 and it still parses.
4. Vanished staging: after run 1 completes 2 of 3, delete the file from the fake root, run again → all items PENDING again at start (assert via a probe of statuses inside a wrapped `onProgress` or after by checking every item's record was cleared and re-DONE), final ZIP has 3 entries.
5. A probe returning DENIED for every item trips the existing 3-streak breaker (blocked non-null) — proving probe wiring passed through.
6. `discardZipStaging` removes the file.

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** the orchestration in `src/lib/zip-job.js`. Core shape (verbatim except where marked):

```js
import { createZipWriter } from './zip-writer.js';
import { runDownloadJob } from './download-queue.js';
import { updateItem, eachItemByStatus, countItemsByStatus, ITEM_STATUS } from './download-records.js';

const stagingName = (jobId) => `bucketer-zip-${jobId}.zip`;

export async function openZipStaging(jobId, { root }) {
  const handle = await root.getFileHandle(stagingName(jobId), { create: true });
  const file = await handle.getFile();
  return {
    size: file.size,
    handle,
    async truncate(bytes) {
      const w = await handle.createWritable({ keepExistingData: true });
      await w.truncate(bytes); await w.close();
    },
    async openAppend(at) {
      const w = await handle.createWritable({ keepExistingData: true });
      await w.seek(at);
      return { write: (u8) => w.write(u8), close: () => w.close() };
    },
    getFile: () => handle.getFile(),
  };
}

export async function discardZipStaging(jobId, { root }) {
  try { await root.removeEntry(stagingName(jobId)); } catch { /* best effort */ }
}

export async function runZipJob(job, { presign, probe, fetchImpl = fetch, root, onProgress, shouldCancel = () => false }) {
  // 1. Reload completed entries; decide the resume point.
  const done = [];
  await eachItemByStatus(job.id, ITEM_STATUS.DONE, (it) => { done.push(it); });
  let resumeAt = done.reduce((m, it) => Math.max(m, it.zipEnd ?? 0), 0);

  const staging = await openZipStaging(job.id, { root });
  if (staging.size < resumeAt) {
    // Eviction or partial loss: the recorded entries are not on disk. Restart cleanly.
    for (const it of done) {
      await updateItem(job.id, it.key, { status: ITEM_STATUS.PENDING, zipOffset: null, zipEnd: null, crc: null, time: null, date: null });
    }
    done.length = 0;
    resumeAt = 0;
  }
  await staging.truncate(resumeAt); // also discards any partial tail past the last entry

  const out = await staging.openAppend(resumeAt);
  const writer = createZipWriter({ write: (u8) => out.write(u8) }, { startOffset: resumeAt });

  let bytesDone = done.reduce((n, it) => n + (it.size || 0), 0);
  let completed = done.length;

  // The injected issue: fetch, stream through the writer, record the entry. issue()
  // resolving means the descriptor is on disk, so DONE (written immediately after by
  // this closure via updateItem) is truthful — it supersedes the engine's ISSUED write.
  const issue = async (url, _localName, item) => {
    await writer.beginEntry(zipEntryPath(item.key, job.prefix ?? job.capturedPrefix ?? ''), {
      mtime: item.lastModified, declaredSize: item.size ?? 0,
    });
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`fetch failed (${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      await writer.update(value);
      onProgress?.({ done: completed, bytesDone: bytesDone + writerEntryBytes() /* see note */ });
    }
    const rec = await writer.endEntry();
    await updateItem(job.id, item.key, { status: ITEM_STATUS.DONE, ...rec });
    completed += 1; bytesDone += rec.size;
    onProgress?.({ done: completed, bytesDone });
  };
  // NOTE: writerEntryBytes — track the in-flight entry's streamed bytes in a closure
  // variable updated alongside writer.update; on a mid-entry failure the engine marks the
  // item FAILED and the NEXT run's truncate(resumeAt) discards the partial tail. After a
  // failed entry in THIS run, the writer is left mid-entry — recreate writer + append
  // stream truncated back to the last good offset before continuing (wrap the issue body
  // in try/catch: on error, truncate to the entry's start, reopen append, recreate the
  // writer with that startOffset, then rethrow so the engine records the failure).

  const result = await runDownloadJob(job, { presign, probe, issue, shouldCancel,
    onProgress: () => {} /* byte progress comes from the issue closure */ });

  // 2. Finish only when nothing remains to send.
  const pending = await countItemsByStatus(job.id, ITEM_STATUS.PENDING);
  const failed = await countItemsByStatus(job.id, ITEM_STATUS.FAILED);
  let finished = false;
  if (!result.cancelled && !result.blocked && pending === 0 && failed === 0) {
    const entries = [];
    await eachItemByStatus(job.id, ITEM_STATUS.DONE, (it) => {
      entries.push({ path: zipEntryPath(it.key, job.prefix ?? job.capturedPrefix ?? ''), zipOffset: it.zipOffset, zipEnd: it.zipEnd, size: it.size, crc: it.crc, time: it.time, date: it.date });
    });
    await writer.finish(entries);
    finished = true;
  }
  await out.close();
  return { ...result, finished };
}
```

Two adaptations the implementer must make and document: (a) `runDownloadJob`'s `issue` is called as `issue(url, it.localName)` — it does not pass the item; extend `download-queue.js` to pass the full item as a third argument (`issue(url, it.localName, it)`, backward-compatible — existing `issueBrowserDownload(url, filename)` ignores it) and cover with one added assertion in `test/download-queue.test.js`; (b) the mid-entry failure recovery marked in the NOTE — implement exactly as described (truncate to entry start, reopen, recreate writer) so a failed entry never leaves the writer wedged; test 3 covers it.

- [ ] **Step 4:** `node --test test/zip-job-run.test.js test/zip-writer.test.js test/download-queue.test.js` PASS; `npm test` green.
- [ ] **Step 5:** Commit:

```bash
git add src/lib/zip-job.js src/lib/download-queue.js test/zip-job-run.test.js test/helpers/zip-reader.js test/zip-writer.test.js test/download-queue.test.js
git commit -m "feat: zip job orchestration — OPFS staging, file-granularity resume, finish from persisted records"
```

---

### Task 4: App wiring — start, export, discard, master-queue row

**Files:**
- Modify: `src/components/App.jsx` (`handleDownloadStart` region ~617-696; `downloadApi.discard` ~611; panel render site)
- Modify: `src/lib/queue-tasks.js:64-76` (`createDownloadTask` gains `delivery`)
- Modify: `src/components/MasterQueue.jsx:~30-35` (zip labels)
- Create: `src/lib/zip-export.js`
- Test: `test/components/master-queue-download.test.jsx` (extend), `test/zip-export.test.js` (jsdom-free: assert DOM calls via injected doc)

**Interfaces:**
- Consumes: `runZipJob`, `discardZipStaging`, `zipFileName` (Tasks 2–3); `navigator.storage.getDirectory()` for the real OPFS root.
- Produces:
  - `exportZip(getFileFn, zipName, doc = document)` in `zip-export.js` — `const f = await getFileFn(); const url = URL.createObjectURL(f);` create an `<a>` with `href=url`, `download=zipName`, append, click, remove, `URL.revokeObjectURL` in a `setTimeout(…, 10_000)` (revoking synchronously races the download start).
  - Job fields: `delivery: 'zip'`, `zipName`, `exportedAt` (additive).
  - `handleZipStart(job)` in App — same shell as `handleDownloadStart` (bucket re-check, `resetFailedToPending`, task creation with `delivery: 'zip'`, RUNNING status) but calls `runZipJob` with `root: await navigator.storage.getDirectory()`, byte progress → `taskStore.update(id, { current: done, bytesDone }, false)`; on `finished` → `exportZip(...)`, `updateJob(id, { status: JOB_STATUS.DONE, exportedAt: Date.now() })`; not finished → PAUSED (resumable) exactly like handoff.
  - `downloadApi.discard` becomes: `async (id) => { const j = await loadJob(id); if (j?.delivery === 'zip') await discardZipStaging(id, { root: await navigator.storage.getDirectory() }); return deleteJob(id); }`
  - The panel's `onStart` routes: `job.delivery === 'zip' ? handleZipStart(job) : handleDownloadStart(job)`.
  - `createDownloadTask({ …, delivery })` stores `delivery`; `MasterQueue.jsx` labels: for `t.delivery === 'zip'` — running: `Zipping ${t.current} of ${t.total}…`; done: `ZIP handed to your browser`.

- [ ] **Step 1:** Write failing tests: extend `master-queue-download.test.jsx` with the two zip label states (model on its existing cases); `test/zip-export.test.js` drives `exportZip` with a fake `doc`/`URL` (injected — add optional params for `urlImpl`) asserting anchor attrs, click, and deferred revoke.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement per the Interfaces block. Read `handleDownloadStart` fully and mirror its structure — including the `activeDownloadJobs` add/delete and the stale-snapshot `updateJob` discipline (never `saveJob({...fresh})`).
- [ ] **Step 4:** `npm run test:ui`, `npm test`, `npm run build` — green. Discard regenerated `dist/index.html`.
- [ ] **Step 5:** Commit:

```bash
git add src/components/App.jsx src/components/MasterQueue.jsx src/lib/queue-tasks.js src/lib/zip-export.js test/zip-export.test.js test/components/master-queue-download.test.jsx
git commit -m "feat: zip jobs run, export as one download, and clean their staging on discard"
```

---

### Task 5: Panel UI — the gated ZIP button and zip job rows

**Files:**
- Modify: `src/components/DownloadJobPanel.jsx` (ready phase ~341-375; job rows)
- Modify: `src/components/App.jsx` (pass `zipGateState` inputs: `browserCapabilities` already passed; add a `requestPersist` callback + quota via `readStorageQuota`)
- Test: `test/components/download-job-panel.test.jsx` (extend)

**Interfaces:**
- Consumes: `zipGate`, `zipFileName` (Task 2); `readStorageQuota` from `browser-capability.js`; `navigator.storage.persisted()`/`persist()`.
- Produces (all in the ready phase, `counts.objects > 0`):
  - Gate evaluation on entering `ready`: panel calls a new prop `api.zipGate({ sendableBytes })` (App implements it: reads quota + `persisted()`, returns `zipGate(...)` result plus a `requestPersist()` that calls `persist()`, re-reads quota, and returns the re-evaluated gate). Keeping the async I/O behind `api` preserves the component's no-SDK/no-IndexedDB rule.
  - `state === 'offered'`: button `data-testid="start-zip"` — `Download as one ZIP (${sendable} files, ${formatBytes(sendableBytes)})`; hint line: "Arrives as a single file with its folder structure intact. Your browser asks once, not N times." Clicking: `api.startZipJob(job)` → sets `delivery:'zip'`, `zipName: zipFileName(bucket, prefix)` on the job record, then `onStart(jobWithDelivery)`; panel closes (reuse the existing `start()` flow with the patched job).
  - `state === 'needs-storage'`: the same button disabled, the gate `reason` beneath, and `data-testid="allow-storage"` button "Allow more storage…" → `api.requestPersist()` → re-render from the returned gate.
  - `state === 'unavailable'`: no ZIP button; if `reason` is a size reason, show it as one muted line.
  - Zip job rows (all three sections): label suffix `— ZIP`; a finished-unexported zip job (DONE items, no `exportedAt`) shows `data-testid="save-zip-again"` → `api.exportZipAgain(job.id)` (App: re-export from staging).
- [ ] **Step 1:** Failing component tests: the four gate states (mock `api.zipGate` returning each), the start-zip dispatch carrying `delivery: 'zip'`, the persist action calling `api.requestPersist` and re-rendering enabled, save-zip-again dispatch. Model on the file's existing fakes.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement panel + the three new `api` members in App (`zipGate`, `startZipJob`, `exportZipAgain`).
- [ ] **Step 4:** `npm run test:ui`, `npm test`, `npm run build` green.
- [ ] **Step 5:** Commit:

```bash
git add src/components/DownloadJobPanel.jsx src/components/App.jsx test/components/download-job-panel.test.jsx
git commit -m "feat: the download panel offers a gated ZIP delivery with the lazy persist path"
```

---

### Task 6: E2E — the ZIP observable + full matrix

**Files:**
- Create: `test/e2e/browser/download-zip.test.mjs`
- Test: full container matrix.

**Interfaces:** harness exports as in `download-selection.test.mjs`; Playwright's `download.path()` to read the saved ZIP's bytes; the mini reader from `test/helpers/zip-reader.js`.

- [ ] **Step 1: Write the spec.** Selectors must be verified against the real DOM before running (same discipline as the selection spec — adapt selectors, keep assertion meaning). Arms:
  1. **Happy path (chromium + firefox lanes):** seed 4 files under `zsel/` (one in a subfolder), open the folder download panel, scan, click `start-zip`, wait for exactly ONE download event, read its bytes from `download.path()`, parse with the shared reader: exactly the 4 entry paths (folder structure intact), sizes and CRCs matching the seeded bodies. Assert no second download event within a settle window (the "one dialog" claim, measured).
  2. **Interruption/resume (desktop lanes):** seed files sized so the mock's `killAtByte` fault drops the socket mid-file-2; run ZIP → job pauses with a failure; clear the fault; resume from the panel's unfinished row; final single download parses as a complete, byte-valid ZIP.
  3. **WebKit lanes:** assert `start-zip` is absent from the ready phase (valid absence — presence is asserted in arms 1–2 on the other engines) while the handoff start button IS present.
- [ ] **Step 2:** Full `npm run test:e2e:container` — all lanes green; pre-existing specs unchanged; compare to the Task 0 baseline and attribute any diff. A pre-existing-spec failure = regression from Tasks 4–5 → report BLOCKED, do not modify old specs.
- [ ] **Step 3:** Commit:

```bash
git add test/e2e/browser/download-zip.test.mjs
git commit -m "test: e2e — one ZIP download containing exactly the selected bytes, resume after a dropped socket"
```

---

### Task 7: Export-scale probe (spec-mandated measurement)

**Files:**
- Create: `docs/review-download-parity/probe/zip-export-scale.md` (results)
- Possibly create: a probe page/script under `docs/review-download-parity/probe/` following that directory's existing conventions (read its README first).

- [ ] **Step 1:** Build a probe that generates a >2 GiB (target 3–4 GiB) store-only ZIP in OPFS inside the containerized chromium and firefox (reusing `zip-writer` via the probe page), exports it via the Task 4 anchor path, and records peak process memory (the parity probes' existing measurement method — follow `docs/review-download-parity/README.md`).
- [ ] **Step 2:** Record results in `zip-export-scale.md`: flat (matches the ≤2 GiB measurements) → the quota-driven gate stands as implemented, note that. NOT flat → report the numbers and STOP for the operator: the gate needs a measured ceiling, which is a design change.
- [ ] **Step 3:** Commit the results doc:

```bash
git add docs/review-download-parity/probe/zip-export-scale.md
git commit -m "docs: measured zip export at >2 GiB — memory profile recorded"
```

(Include the probe page too if one was created.)

---

### Task 8: Release gate (operator-in-the-loop)

- [ ] **Step 1:** Present the change summary and proposed **minor** bump; STOP for the operator's confirmation of the level.
- [ ] **Step 2:** `npm version <confirmed> --no-git-tag-version`.
- [ ] **Step 3:** CHANGELOG top entry (first line self-contained):

```markdown
## [<x.y.0>] — <date> — One ZIP, one dialog

Download as one ZIP bundles the folder or selection you chose into a single file with its folder structure intact, so the browser asks once instead of once per file. ZIP jobs stream through the browser's private storage, show real byte progress, stop and resume across sessions, and offer to request more storage only when a job needs it. Firefox and Chromium; the browser-managed per-file delivery is unchanged.
```

- [ ] **Step 4:** `npm run build`, `npm test`, `npm run test:ui` — green.
- [ ] **Step 5:** Commit bump + `dist/index.html` + `src/lib/changelog.js` + CHANGELOG together; STOP before any push (hook will tag from the working tree).

---

## Self-review notes

- Spec coverage: writer → T1; paths/name/gate incl. lazy persist → T2, T5; orchestration/resume misfortunes 1–3 → T3; export/discard/exportedAt/"Save ZIP again" → T4, T5; four gate states UI → T5; e2e observables incl. interruption + WebKit absence → T6; >2 GiB export probe (spec Bounds) → T7; additive model/legacy safety → constraints + T3/T4 tests.
- Known verify-before-run points: e2e selectors (T6 Step 1, flagged); `runDownloadJob` third-arg extension (T3, explicit with its own test).
- Type consistency: entry record `{ path, zipOffset, zipEnd, size, crc, time, date }` used identically in T1 (producer), T3 (persistence + finish), T6 (reader checks).
