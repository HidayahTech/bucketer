// Browser e2e: ZIP delivery — the "one dialog instead of N" claim, end to end.
//
// See docs/superpowers/specs/2026-08-03-zip-download-design.md,
// docs/superpowers/plans/2026-08-03-zip-download.md (Task 6), and, for the concurrent
// engine underneath every arm below, docs/superpowers/specs/2026-08-04-download-concurrency-design.md
// (runZipJob now stages via zip-prefetch.js's bounded concurrent pool — see zip-job.js's
// header comment). Four arms:
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
//      including the one that was truncated the first time. This arm doubles as
//      concurrent-path resume coverage: resume is file-granularity (PENDING items are
//      re-fetched through the same bounded pool as a fresh run), so nothing about it
//      changes under concurrency.
//   3. Many small files (chromium/firefox, desktop): ~12 files (a couple nested one
//      folder down) — enough that zip-prefetch.js's default CONCURRENCY (4) has more than
//      one file in flight at once, exercising completion-order writing instead of arm 1's
//      small fixed set. The observable is UNCHANGED from arm 1: one download, all entries
//      present with correct bytes/CRCs, folder structure intact. Concurrency must not
//      change correctness — timing/concurrency itself is NOT asserted here (timing-
//      sensitive; the design doc's probe measures that separately).
//   4. WebKit (all lanes): `start-zip` never renders — zipGate requires OPFS +
//      streamingFetch + writableFiles, which this engine lacks (design doc: "Where
//      absent (WebKit), the button does not render; handoff remains"). This is a valid
//      absence claim specifically because presence is proven elsewhere (arms 1–3, on the
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

// Arm 3: ~12 small files, 10 at the folder root and 2 one level down under sub/ — enough
// that CONCURRENCY (4, zip-prefetch.js) has more than one file in flight at once. Every
// body is a distinct length/pattern (mkBinary keyed by index) so a bug that wrote the
// right COUNT of entries but mixed up which bytes went with which name would still fail.
const ZMANY = Object.fromEntries([
  ...Array.from({ length: 10 }, (_, i) => [`zmany/f${String(i + 1).padStart(2, '0')}.txt`, mkBinary(40 + i * 11, i + 3)]),
  ...Array.from({ length: 2 }, (_, i) => [`zmany/sub/n${String(i + 1).padStart(2, '0')}.txt`, mkBinary(60 + i * 17, i + 31)]),
]);

// Arm 4: WebKit absence — one file is enough to reach the ready phase.
const ZWK = { 'zwk/only.txt': Buffer.from('webkit must not offer a zip button\n') };

before(async () => {
  ctx = await startMock();
  app = await startAppServer();
  browser = await launchBrowser();
  for (const [key, body] of [...Object.entries(ZSEL), ...Object.entries(ZINT), ...Object.entries(ZMANY), ...Object.entries(ZWK)]) {
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
    // ── Engine-identity observable: prove the IN-PLACE engine ran, not just that a valid
    // zip came out. On Chromium/Firefox the zip path now runs through the in-place engine
    // (a Web Worker doing positioned OPFS writes, per the 2026-08-04 offset-composition
    // design); the serial engine it replaced instantiates no Worker at all. So "at least one
    // `new Worker` was constructed before the download completed" is a valid presence proof
    // for "in-place ran" — a silent regression back to serial, or a worker that fails to
    // spin up and the code silently falling back, would both zero out this counter while the
    // byte-level assertions below could still pass (a correct zip can, in principle, come out
    // of either engine). This is the PRESENCE half; assertZipMatches below remains the
    // CORRECTNESS half — neither subsumes the other.
    //
    // Installed on the CONTEXT (not evaluate()) and BEFORE page.goto(): addInitScript runs
    // the wrapper before any of the navigated document's own scripts, so the app bundle's
    // `import { makeAssemblerWorker }` / `new Worker(blobURL)` (assembler-worker-url.js) sees
    // the wrapped constructor, not the original. Registering it here — after `page` already
    // exists (created in beforeEach) but before this test's own `page.goto` — still lands
    // ahead of that navigation: addInitScript scripts apply to a context's pages "whenever a
    // page is created ... or is navigated" (verified locally against this Playwright version
    // before relying on it here). WebKit is excluded (skipOn below): it has no zip button at
    // all (arm 4), so there is nothing to instrument there.
    await context.addInitScript(() => {
      window.__zipWorkerCount = 0;
      const OrigWorker = window.Worker;
      if (OrigWorker) {
        window.Worker = class extends OrigWorker {
          constructor(...args) { super(...args); window.__zipWorkerCount++; }
        };
      }
    });

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

    // Fail loudly if the counter never landed (wrong insertion point) rather than skipping
    // the check — the whole point is that this fails if in-place didn't run.
    const workerCount = await page.evaluate(() => window.__zipWorkerCount);
    assert.ok(Number.isInteger(workerCount), 'window.__zipWorkerCount must be defined — the init script did not land before app JS ran');
    assert.ok(workerCount >= 1, `expected the in-place engine to construct at least one assembler Worker, saw ${workerCount}`);
  }, { skipOn: { webkit: 'start-zip does not render on WebKit — see the WebKit-absence arm below' } });

  e2eTest('a per-file failure pauses the zip; resuming finishes it as one complete download', async (t) => {
    if (e2eDeviceName()) {
      t.skip('download-manager/OPFS staging behavior is not device-emulated; this arm runs on desktop lanes');
      return;
    }

    // The probe (a 1-byte Range GET) must survive so the failure stays scoped to f2.bin
    // instead of blocking the whole job — see the file-header comment.
    ctx.mock.configure({ faults: [{ op: 'GetObject', keyPrefix: 'zint/f2.bin', killAtByte: 1500, skipRange: true }] });

    // Same engine-identity observable as the happy-path arm above (see its comment for the
    // full rationale): the in-place engine's assembler Worker must be created not just on
    // the first run, but again on the resumed run — resume re-enters the same zip-job code
    // path (file-granularity, per the header comment), so a regression that broke in-place
    // specifically on resume (e.g. a fallback that only triggers on retry) would still be
    // caught. Installed on the context before this test's page.goto, ahead of the app bundle.
    await context.addInitScript(() => {
      window.__zipWorkerCount = 0;
      const OrigWorker = window.Worker;
      if (OrigWorker) {
        window.Worker = class extends OrigWorker {
          constructor(...args) { super(...args); window.__zipWorkerCount++; }
        };
      }
    });

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

    // Fail loudly if the counter never landed, same as the happy-path arm.
    const workerCount = await page.evaluate(() => window.__zipWorkerCount);
    assert.ok(Number.isInteger(workerCount), 'window.__zipWorkerCount must be defined — the init script did not land before app JS ran');
    assert.ok(workerCount >= 1, `expected the in-place engine to construct at least one assembler Worker across the first run + resume, saw ${workerCount}`);
  }, { skipOn: { webkit: 'start-zip does not render on WebKit — see the WebKit-absence arm below' } });

  e2eTest('a many-file zip (concurrent prefetch) still contains exactly the expected files, byte-for-byte', async () => {
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await connectApp(page, ctx.httpsBrowserEndpoint);
    await page.locator('[data-testid="folder-row:zmany"]').click();
    await page.locator('[data-testid="file-row:f01.txt"]').waitFor({ timeout: 10000 });
    await openPanel(page);
    await page.locator('[data-testid="scan"]').click();
    await page.locator('[data-testid="start-zip"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="start-zip"]').click();

    await downloads.waitForCount(1, 30000);
    // Same presence-AND-absence shape as the happy-path arm: concurrency must collapse
    // back to exactly one export, not one per completed prefetch worker.
    await downloads.settle(3000);
    assert.equal(downloads.list().length, 1, 'exactly one zip download must fire, never one per prefetched file');

    const filePath = await downloads.list()[0].path();
    const bytes = new Uint8Array(readFileSync(filePath));
    const entries = readZip(bytes); // throws on any structural defect (bad EOCD/CD/local headers)

    const expected = Object.fromEntries(Object.entries(ZMANY).map(([k, v]) => [k.slice('zmany/'.length), v]));
    assertZipMatches(entries, expected);
  }, { skipOn: {
    webkit: 'start-zip does not render on WebKit — see the WebKit-absence arm below',
  } });

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
