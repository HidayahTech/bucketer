// Tests for the duplicate-detection engine (read-only). The engine narrows candidates
// cheaply — size grouping, then HeadObject-derived signals (ETag-MD5 / our stamp) — and
// clusters same-content candidates. It never decides a deletion; byte-for-byte
// verification (verify-bytes.js) is the only thing that confirms identity. Key safety
// properties under test:
//   - singletons and zero-byte/folder markers are not flagged,
//   - provably-distinct single-part objects (different MD5) are never grouped,
//   - a member carrying two signals bridges otherwise-separate clusters,
//   - encrypted/multipart ETags are not trusted as an MD5.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  enumerateObjects,
  groupBySize,
  deriveSignals,
  classifyGroups,
  headSizeGroups,
} from '../src/lib/dedup-scan.js';

// ── enumerateObjects ──────────────────────────────────────────────────────────

function listMock(pages) {
  return {
    send(cmd) {
      const token = cmd.input.ContinuationToken;
      const page = token ? pages.find((p) => p.trigger === token) : pages[0];
      if (!page) return Promise.reject(new Error(`unexpected token ${token}`));
      return Promise.resolve({
        Contents: page.contents,
        IsTruncated: page.isTruncated ?? false,
        NextContinuationToken: page.next,
      });
    },
  };
}

describe('enumerateObjects', () => {
  test('captures Key/Size/LastModified across pages', async () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const client = listMock([
      { contents: [{ Key: 'a', Size: 1, LastModified: d }], isTruncated: true, next: 't2' },
      { contents: [{ Key: 'b', Size: 2, LastModified: d }], isTruncated: false, trigger: 't2' },
    ]);
    const objs = await enumerateObjects(client, 'bk', '');
    assert.deepEqual(objs.map((o) => o.Key), ['a', 'b']);
    assert.equal(objs[0].Size, 1);
    assert.equal(objs[1].LastModified, d);
  });

  test('tolerates a missing Contents array', async () => {
    const client = listMock([{ contents: undefined, isTruncated: false }]);
    assert.deepEqual(await enumerateObjects(client, 'bk', ''), []);
  });
});

// ── groupBySize ───────────────────────────────────────────────────────────────

describe('groupBySize', () => {
  test('keeps only size-collision groups (>=2), drops singletons', () => {
    const groups = groupBySize([
      { Key: 'a', Size: 10 },
      { Key: 'b', Size: 10 },
      { Key: 'c', Size: 99 }, // singleton
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((o) => o.Key).sort(), ['a', 'b']);
  });

  test('excludes zero-byte objects (folder markers / empty placeholders)', () => {
    const groups = groupBySize([
      { Key: 'dir/', Size: 0 },
      { Key: 'dir2/', Size: 0 },
    ]);
    assert.deepEqual(groups, []);
  });
});

// ── deriveSignals ─────────────────────────────────────────────────────────────

describe('deriveSignals', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e';

  test('single-part unencrypted ETag is trusted as MD5', () => {
    const s = deriveSignals({ ETag: `"${md5}"` });
    assert.equal(s.etagMd5, md5);
    assert.equal(s.multipart, false);
  });

  test('multipart ETag is flagged and not trusted as MD5', () => {
    const s = deriveSignals({ ETag: `"${md5}-4"` });
    assert.equal(s.etagMd5, null);
    assert.equal(s.multipart, true);
  });

  test('SSE-KMS object ETag is not trusted as MD5', () => {
    const s = deriveSignals({ ETag: `"${md5}"`, ServerSideEncryption: 'aws:kms' });
    assert.equal(s.etagMd5, null);
  });

  test('parses our content-hash stamp from metadata', () => {
    const hex = 'a'.repeat(64);
    const s = deriveSignals({ ETag: '"x"', Metadata: { 'bucketer-content-hash': `sha256-ht64k:${hex}` } });
    assert.deepEqual(s.stampHash, { scheme: 'sha256-ht64k', hex });
  });
});

// ── classifyGroups ────────────────────────────────────────────────────────────

const ETAG_X = 'a'.repeat(32);
const ETAG_Y = 'b'.repeat(32);
const STAMP_S = { scheme: 'sha256-ht64k', hex: 'c'.repeat(64) };

function member(key, lm, extra) {
  return { Key: key, Size: 100, LastModified: new Date(lm), etagMd5: null, multipart: false, stampHash: null, ...extra };
}

describe('classifyGroups', () => {
  test('groups two single-part objects with the same MD5', () => {
    const [g] = classifyGroups([[
      member('new', '2026-02-01', { etagMd5: ETAG_X }),
      member('old', '2026-01-01', { etagMd5: ETAG_X }),
    ]]);
    assert.equal(g.matchedBy, 'md5');
    assert.equal(g.confidence, 'candidate');
    assert.equal(g.verified, false);
    assert.equal(g.reclaimableBytes, 100); // size * (2 - 1)
    assert.deepEqual(g.members.map((m) => m.Key), ['old', 'new']); // oldest first (default keeper)
  });

  test('never groups provably-distinct single-part objects (different MD5)', () => {
    const groups = classifyGroups([[
      member('a', '2026-01-01', { etagMd5: ETAG_X }),
      member('b', '2026-01-02', { etagMd5: ETAG_Y }),
    ]]);
    assert.deepEqual(groups, []);
  });

  test('groups by our stamp when ETag is unavailable', () => {
    const [g] = classifyGroups([[
      member('a', '2026-01-01', { stampHash: STAMP_S }),
      member('b', '2026-01-02', { stampHash: STAMP_S }),
    ]]);
    assert.equal(g.matchedBy, 'stamp');
    assert.equal(g.members.length, 2);
  });

  test('a member with two signals bridges MD5-only and stamp-only members', () => {
    const [g] = classifyGroups([[
      member('bridge', '2026-01-01', { etagMd5: ETAG_X, stampHash: STAMP_S }),
      member('md5only', '2026-01-02', { etagMd5: ETAG_X }),
      member('stamponly', '2026-01-03', { stampHash: STAMP_S }),
    ]]);
    assert.equal(g.members.length, 3);
  });

  test('surfaces same-size multipart objects with no cheap signal as a size candidate', () => {
    const [g] = classifyGroups([[
      member('a', '2026-01-01', { multipart: true }),
      member('b', '2026-01-02', { multipart: true }),
    ]]);
    assert.equal(g.matchedBy, 'size');
    assert.equal(g.members.length, 2);
  });

  test('drops a lone concrete-signal member and a lone unresolved member', () => {
    const groups = classifyGroups([[
      member('uniqueMd5', '2026-01-01', { etagMd5: ETAG_X }),
      member('loneMultipart', '2026-01-02', { multipart: true }),
    ]]);
    assert.deepEqual(groups, []);
  });
});

// ── headSizeGroups ────────────────────────────────────────────────────────────

describe('headSizeGroups', () => {
  test('enriches members with HeadObject-derived signals', async () => {
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const heads = { a: { ETag: `"${md5}"` }, b: { ETag: `"${md5}"` } };
    const client = { send: (cmd) => Promise.resolve(heads[cmd.input.Key]) };
    const groups = [[{ Key: 'a', Size: 5 }, { Key: 'b', Size: 5 }]];
    await headSizeGroups(client, 'bk', groups, { concurrency: 2 });
    assert.equal(groups[0][0].etagMd5, md5);
    assert.equal(groups[0][1].etagMd5, md5);
  });
});
