// Browser e2e GATE: worker FileSystemSyncAccessHandle positioned-write fidelity.
//
// The whole premise of in-place ZIP composition (docs/superpowers/specs/
// 2026-08-04-inplace-offset-composition-design.md, decision D6) is that a Web Worker can
// open ONE exclusive sync access handle on an OPFS file and write regions OUT OF ORDER,
// with gaps, and read them back byte-for-byte. This spec measures exactly that primitive —
// deliberately NOT through the app bundle — across every engine the matrix runs. Its result
// decides which engines get the in-place engine vs. the shipped serial fallback (D8).
//
// Observable: the bytes read back through the same handle equal the bytes written, with the
// gap left as zero-fill and the final size exactly the truncated length. UNSUPPORTED (no
// Worker / no createSyncAccessHandle) is recorded, not failed — that engine simply falls
// back to the serial writer, which is already how WebKit reaches handoff for ZIP today.
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startAppServer, launchBrowser, newE2EContext, newE2EPage, e2eTest, e2eEngineName,
} from '../harness.mjs';

let app, browser, context, page;

// The worker source, inline as a string (this probe measures the raw browser primitive, so
// it does not go through build.mjs's worker inlining — that path is proven separately by the
// build test and the in-place e2e).
const WORKER_SRC = `
self.onmessage = async (e) => {
  const { fileName, total, ops } = e.data; // ops written in the given (out-of-order) order
  try {
    // OPFS itself may be absent in the worker (WebKit exposes navigator.storage on the
    // window but not in a DedicatedWorker) — treat that as unsupported, not an error.
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      self.postMessage({ unsupported: 'no OPFS in worker (navigator.storage.getDirectory)' });
      return;
    }
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName, { create: true });
    // createSyncAccessHandle is exposed ONLY in worker global scope — it cannot be
    // feature-detected from the window, so the check must live here, in the worker.
    if (typeof handle.createSyncAccessHandle !== 'function') {
      self.postMessage({ unsupported: 'no createSyncAccessHandle in worker' });
      return;
    }
    const sync = await handle.createSyncAccessHandle();
    sync.truncate(total);
    for (const op of ops) sync.write(new Uint8Array(op.bytes), { at: op.at });
    sync.flush();
    const size = sync.getSize();
    const readBack = new Uint8Array(size);
    sync.read(readBack, { at: 0 });
    sync.close();
    try { await root.removeEntry(fileName); } catch (_) {}
    self.postMessage({ ok: true, size, bytes: Array.from(readBack) });
  } catch (err) {
    self.postMessage({ ok: false, name: err && err.name, message: err && err.message });
  }
};
`;

before(async () => {
  app = await startAppServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

describe('OPFS worker positioned-write fidelity (in-place gate)', () => {
  e2eTest('out-of-order positioned writes read back byte-faithful', async () => {
    const engine = e2eEngineName();
    context = await newE2EContext(browser);
    page = await newE2EPage(context);
    await page.goto(app.url);

    const result = await page.evaluate(async ({ src }) => {
      if (typeof Worker === 'undefined') return { skipped: 'no Worker' };
      // Do NOT gate on the window's FileSystemFileHandle.prototype — createSyncAccessHandle
      // is worker-scope-only and is absent there even on engines that fully support it in a
      // worker. Always spawn the worker; it self-reports support or fidelity.
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      // Three regions written OUT OF ORDER (C, then A, then B); [10,20) left as a gap.
      const total = 30;
      const regionA = { at: 0, bytes: [1, 2, 3, 4, 5] };
      const regionB = { at: 5, bytes: [6, 7, 8, 9, 10] };
      const regionC = { at: 20, bytes: [21, 22, 23, 24, 25] };
      const expected = new Array(total).fill(0);
      for (const r of [regionA, regionB, regionC]) r.bytes.forEach((b, i) => { expected[r.at + i] = b; });
      const msg = await new Promise((res) => {
        worker.onmessage = (ev) => res(ev.data);
        worker.postMessage({ fileName: 'fidelity-probe.bin', total, ops: [regionC, regionA, regionB] });
      });
      worker.terminate();
      return { msg, expected };
    }, { src: WORKER_SRC });

    await context.close();

    if (result.skipped) {
      console.log(`FIDELITY-GATE ${engine}: UNSUPPORTED (${result.skipped})`);
      return;
    }
    if (result.msg.unsupported) {
      // No sync handle in the worker either: this engine uses the serial fallback.
      console.log(`FIDELITY-GATE ${engine}: UNSUPPORTED (${result.msg.unsupported})`);
      return;
    }
    assert.equal(result.msg.ok, true, `${engine} worker error: ${result.msg.name} ${result.msg.message}`);
    assert.equal(result.msg.size, 30, `${engine}: size after truncate(30)`);
    assert.deepEqual(result.msg.bytes, result.expected, `${engine}: out-of-order bytes must read back exactly`);
    console.log(`FIDELITY-GATE ${engine}: PASS`);
  });
});
