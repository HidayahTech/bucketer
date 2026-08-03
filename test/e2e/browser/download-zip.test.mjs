// Browser e2e: ZIP delivery — the "one dialog instead of N" claim, end to end.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md and
// docs/superpowers/plans/2026-08-03-zip-download.md (Task 6). Three arms:
//
//   1. Happy path (chromium/firefox, all devices): a folder of 4 files, one nested,
//      becomes exactly ONE download event whose bytes parse as a ZIP containing exactly
//      those 4 entries — folder structure intact, sizes and CRCs matching the seeded
//      bodies. Both the presence (one download) and the absence (no second one, measured
//      over a settle window) are asserted — a spec that only checks "at least one" would
//      pass just as happily if the writer looped and re-exported.
//   2. Interruption/resume (desktop lanes, chromium/firefox only — the same "not
//      device-emulated" carve-out download-completion.test.mjs uses for its racy arm):
//      the mock drops the socket mid-body of one file via killAtByte. The job pauses with
//      that one file FAILED and the others DONE (MasterQueue's honest "Paused — N of M
//      zipped, K failed" label — see progress.md Task 4's operator ruling). No download
//      fires yet: an unfinished zip is never exported (zip-job.js only calls writer.finish
//      when nothing is left PENDING or FAILED). Clearing the fault and clicking the
//      panel's resume row re-runs the job from its OPFS-persisted offset; the SINGLE
//      resulting download parses as a complete, byte-valid ZIP with all files intact,
//      including the one that was truncated the first time.
//   3. WebKit (all lanes): `start-zip` never renders — zipGate requires OPFS +
//      streamingFetch + writableFiles, which this engine lacks (design doc: "Where
//      absent (WebKit), the button does not render; handoff remains"). This is a valid
//      absence claim specifically because presence is proven elsewhere (arms 1–2, on the
//      other two engines) — see harness.mjs's note on absence-only specs.
//
// WHY skipRange ON THE INTERRUPTION FAULT. Every file is probed before it is issued (a
// `Range: bytes=0-0` GET — download-preflight.js) and a probe that fails with a NETWORK
// error blocks the whole job, not just one file (download-queue.js). Arm 2 wants a
// single-file failure, so the fault only targets the real streaming GET (`hasRange:
// false`) via `skipRange: true`, leaving the 1-byte probe unaffected — see server.mjs's
// matchFault comment, which documents exactly this "probe survives, transfer doesn't"
// scenario.
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  startMock, startAppServer, connectApp, BUCKET, launchBrowser, newE2EContext, newE2EPage,
  e2eTest, e2eDeviceName,
} from '../harness.mjs';
import { readZip, refCrc } from '../../helpers/zip-reader.js';

let ctx, app, browser, context, page, downloads;

// Deterministic, distinguishable bodies — different sizes and byte patterns so a bug that
// swapped two entries' data (not just their names) would still fail the CRC/byte check.
function mkBinary(length, seed) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * seed + 17) % 256;
  return buf;
}

// Arm 1: a folder of 4 files, one nested under sub/.
const ZSEL = {
  'zsel/a.txt':     Buffer.from('alpha file for the zip happy path\n'),
  'zsel/b.txt':     Buffer.from('bravo file, a different length than alpha\n'),
  'zsel/c.bin':     mkBinary(337, 7),
  'zsel/sub/d.txt': Buffer.from('delta lives one folder down\n'),
};

// Arm 2: f2.bin is large enough that killAtByte lands well inside its body, not at its edge.
const ZINT = {
  'zint/f1.txt': Buffer.from('first file, must survive the interruption intact\n'),
  'zint/f2.bin': mkBinary(4096, 13),
  'zint/f3.txt': Buffer.from('third file, must also survive the interruption intact\n'),
};

// Arm 3: WebKit absence — one file is enough to reach the ready phase.
const ZWK = { 'zwk/only.txt': Buffer.from('webkit must not offer a zip button\n') };

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  for (const [key, body] of [...Object.entries(ZSEL), ...Object.entries(ZINT), ...Object.entries(ZWK)]) {
    await ctx.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
  }
});
after(async () => {
  await browser?.close();
  await app?.close();
  await ctx?.mock.close();
});

// Local download-object collector — deliberately not harness.collectDownloads(), which only
// records suggestedFilename(); this arm needs the actual Download object for .path() so the
// saved ZIP's bytes can be read off disk. Same shape (list/waitForCount/settle) for
// consistency with the harness helper it stands in for.
function collectZipDownloads(p) {
  const events = [];
  p.on('download', (d) => events.push(d));
  return {
    list: () => events.slice(),
    waitForCount(n, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      return (async () => {
        while (events.length < n) {
          if (Date.now() > deadline) {
            throw new Error(`expected ${n} zip download(s), saw ${events.length} after ${timeoutMs}ms`);
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      })();
    },
    settle(ms = 3000) { return new Promise((r) => setTimeout(r, ms)); },
  };
}

beforeEach(async () => {
  await context?.close().catch(() => {});
  context = await newE2EContext(browser);
  page = await newE2EPage(context);
  downloads = collectZipDownloads(page);
  ctx.mock.configure({ latencyMs: 0, faults: [] });
  ctx.mock.requestLog.reset();
});

async function openPanel(p) {
  await p.locator('[data-testid="open-download-job"]').dispatchEvent('click');
}

// Asserts entries/zip against `expected` ({ entryName: Buffer }): exact entry set, and for
// each entry the uncompressed size, an independent refCrc of the ORIGINAL seeded body
// (readZip already self-checks crc against its own extracted bytes; this additionally
// cross-checks against the bytes this test put into the mock, not just internal
// consistency), and byte-for-byte equality.
function assertZipMatches(entries, expected) {
  const gotNames = entries.map((e) => e.name).sort();
  const wantNames = Object.keys(expected).sort();
  assert.deepEqual(gotNames, wantNames, 'the zip must contain exactly the expected entries, no more, no fewer');
  for (const [name, body] of Object.entries(expected)) {
    const entry = entries.find((e) => e.name === name);
    assert.equal(entry.usize, body.length, `${name}: uncompressed size must match the seeded body`);
    assert.equal(refCrc(body), entry.crc, `${name}: crc32 must match the seeded body (independent check)`);
    assert.deepEqual(Buffer.from(entry.data), body, `${name}: bytes must match the seeded body exactly`);
  }
}

describe('browser e2e — zip download', () => {
  e2eTest('one zip download contains exactly the selected files, byte-for-byte, folder structure intact', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:zsel"]').click();
    await page.locator('[data-testid="file-row:a.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start-zip"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="start-zip"]').click();

    await downloads.waitForCount(1, 30000);
    // The "one dialog" claim is presence AND absence, both measured: got exactly one, and
    // nothing more shows up in a settle window after it.
    await downloads.settle(3000);
    assert.equal(downloads.list().length, 1, 'exactly one zip download must fire, never a second');

    const filePath = await downloads.list()[0].path();
    assert.ok(filePath, 'the zip download must be saved to a local path Playwright can read');
    const bytes = new Uint8Array(readFileSync(filePath));
    const entries = readZip(bytes); // throws on any structural defect (bad EOCD/CD/local headers)

    const expected = Object.fromEntries(Object.entries(ZSEL).map(([k, v]) => [k.slice('zsel/'.length), v]));
    assertZipMatches(entries, expected);
  }, { skipOn: { webkit: 'start-zip does not render on WebKit — see the WebKit-absence arm below' } });

  e2eTest('a per-file failure pauses the zip; resuming finishes it as one complete download', async (t) => {
    if (e2eDeviceName()) {
      t.skip('download-manager/OPFS staging behavior is not device-emulated; this arm runs on desktop lanes');
      return;
    }

    // The probe (a 1-byte Range GET) must survive so the failure stays scoped to f2.bin
    // instead of blocking the whole job — see the file-header comment.
    ctx.mock.configure({ faults: [{ op: 'GetObject', keyPrefix: 'zint/f2.bin', killAtByte: 1500, skipRange: true }] });

    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:zint"]').click();
    await page.locator('[data-testid="file-row:f1.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start-zip"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="start-zip"]').click();

    // f1.txt and f3.txt succeed, f2.bin fails on the dropped connection: MasterQueue's
    // honest not-finished label (progress.md Task 4).
    await page.getByText(/Paused — 2 of 3 zipped, 1 failed/).first().waitFor({ timeout: 30000 });
    assert.equal(downloads.list().length, 0, 'an unfinished zip (a failure still pending) must never export');

    ctx.mock.configure({ faults: [] });
    await openPanel(page);
    await page.locator('[data-testid^="resume-"]').waitFor({ timeout: 10000 });
    await page.locator('[data-testid^="resume-"]').first().click();

    await page.getByText(/ZIP handed to your browser/).first().waitFor({ timeout: 30000 });
    await downloads.waitForCount(1, 15000);
    await downloads.settle(3000);
    assert.equal(downloads.list().length, 1, 'the resumed job must export exactly one zip, not one per run');

    const filePath = await downloads.list()[0].path();
    const bytes = new Uint8Array(readFileSync(filePath));
    const entries = readZip(bytes);

    const expected = Object.fromEntries(Object.entries(ZINT).map(([k, v]) => [k.slice('zint/'.length), v]));
    assertZipMatches(entries, expected);
  }, { skipOn: { webkit: 'start-zip does not render on WebKit — see the WebKit-absence arm below' } });

  e2eTest('WebKit offers the handoff button but never the zip button', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:zwk"]').click();
    await page.locator('[data-testid="file-row:only.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start"]').waitFor({ timeout: 15000 });

    // start-zip is gated by an async effect (zipGate() reads live storage quota); give it
    // room to resolve before treating its absence as meaningful rather than "not yet".
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('[data-testid="start-zip"]').count(), 0,
      'start-zip must not render where OPFS/writableFiles/streamingFetch are unavailable (WebKit)');
    assert.equal(await page.locator('[data-testid="start"]').count(), 1,
      'the handoff start button must still be offered on every engine');
  }, { skipOn: {
    chromium: 'presence of start-zip is asserted in the happy-path/interruption arms above',
    firefox:  'presence of start-zip is asserted in the happy-path/interruption arms above',
  } });
});
