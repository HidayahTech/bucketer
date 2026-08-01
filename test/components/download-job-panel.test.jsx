// Tests for DownloadJobPanel — creating a browser-managed download job.
//
// The panel lists the folder before offering to start, so the confirm carries real
// numbers ("Send 412 files (840 GB)") rather than an abstract warning. Egress is billed
// by most providers, and a user about to move a TB deserves to see the size first.
//
// The `api` prop is the single seam: App supplies the real record/enumeration wiring,
// tests supply fakes, and the component stays free of IndexedDB and the SDK.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mount, fire } from '../helpers/render.js';
import { DownloadJobPanel } from '../../src/components/DownloadJobPanel.jsx';
import { NAMING_MODES } from '../../src/lib/download-naming.js';
import { TIERS } from '../../src/lib/browser-capability.js';

const DESKTOP = { directoryPicker: false, opfs: true, streamingFetch: true, likelyMobile: false };
const MOBILE = { ...DESKTOP, likelyMobile: true };

const NOOP = () => {};

function fakeApi(over = {}) {
  return {
    listUnfinished: async () => [],
    startJob: async ({ mode }) => ({ id: 'job-1', mode }),
    enumerate: async (_job, { onProgress }) => {
      onProgress?.({ objects: 412, bytes: 840 * 1024 ** 3 });
      return { objects: 412, bytes: 840 * 1024 ** 3, done: true, cancelled: false };
    },
    discard: async () => {},
    ...over,
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('DownloadJobPanel', () => {
  test('names the folder it is about to download', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="videos/" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.equal(m.text().includes('videos/'), true);
    m.cleanup();
  });

  test('HONESTY: says up front that it cannot show transfer progress', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.ok(/can(not|'t) (see|show)/i.test(m.text()));
    m.cleanup();
  });

  test('HONESTY: warns that files arrive flat, not as folders', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.ok(/folder/i.test(m.text()));
    assert.notEqual(m.query('[data-testid="mode-flatten"]'), null);
    assert.notEqual(m.query('[data-testid="mode-leaf"]'), null);
    m.cleanup();
  });

  test('lists the folder and reports what it found', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const body = m.text();
    assert.equal(body.includes('412'), true);
    assert.ok(/GB|GiB/.test(body), 'the size must be shown before committing');
    m.cleanup();
  });

  test('puts the real numbers on the confirm button', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const start = m.query('[data-testid="start"]');
    assert.notEqual(start, null);
    assert.equal(start.textContent.includes('412'), true);
    m.cleanup();
  });

  test('mentions egress cost before a large transfer', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    assert.ok(/egress|bill|cost/i.test(m.text()));
    m.cleanup();
  });

  test('passes the chosen naming mode through', async () => {
    let started;
    const api = fakeApi({ startJob: async ({ mode }) => { started = mode; return { id: 'j', mode }; } });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);

    fire(m.query('[data-testid="mode-flatten"]'), 'click');
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(started, NAMING_MODES.FLATTEN);
    m.cleanup();
  });

  test('hands the job to onStart when confirmed', async () => {
    let handed = null;
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={j => { handed = j; }} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    fire(m.query('[data-testid="start"]'), 'click');

    assert.notEqual(handed, null);
    assert.equal(handed.id, 'job-1');
    m.cleanup();
  });

  test('discards the job if the user backs out after listing', async () => {
    let discarded = null;
    const api = fakeApi({ discard: async (id) => { discarded = id; } });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    fire(m.query('[data-testid="panel-close"]'), 'click');
    await flush();

    assert.equal(discarded, 'job-1');
    m.cleanup();
  });

  test('reports an enumeration failure instead of pretending it worked', async () => {
    const api = fakeApi({ enumerate: async () => { throw new Error('AccessDenied'); } });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.text().includes('AccessDenied'), true);
    assert.equal(m.query('[data-testid="start"]'), null);
    m.cleanup();
  });

  test('offers the transfer-tool route as a sibling, not a fallback', () => {
    let asked = false;
    const m = mount(
      <DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP}
        onUseTransferTool={() => { asked = true; }} />,
    );
    fire(m.query('[data-testid="use-transfer-tool"]'), 'click');
    assert.equal(asked, true);
    m.cleanup();
  });

  // The durable manifest only earns its keep if an interrupted job can be picked up in a
  // later session. The panel is the download entry point, so it is where they surface.
  test('surfaces an unfinished job from a previous session', async () => {
    const api = fakeApi({
      listUnfinished: async () => [
        { id: 'old', prefix: 'videos/', counters: { total: 412, bytesTotal: 900 }, remaining: 172 },
      ],
    });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    await flush();

    const body = m.text();
    assert.ok(/unfinished|resume|earlier|previous/i.test(body));
    assert.equal(body.includes('videos/'), true);
    assert.equal(body.includes('172'), true);
    m.cleanup();
  });

  test('resuming hands the existing job straight to onStart', async () => {
    const existing = { id: 'old', prefix: 'videos/', counters: { total: 412 }, remaining: 172 };
    let handed = null;
    const api = fakeApi({ listUnfinished: async () => [existing] });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={j => { handed = j; }} onClose={NOOP} />);
    await flush();

    fire(m.query('[data-testid="resume-old"]'), 'click');
    assert.equal(handed?.id, 'old');
    m.cleanup();
  });

  test('an unfinished job can be discarded', async () => {
    let discarded = null;
    const api = fakeApi({
      listUnfinished: async () => [{ id: 'old', prefix: 'videos/', counters: { total: 412 }, remaining: 172 }],
      discard: async (id) => { discarded = id; },
    });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    await flush();

    fire(m.query('[data-testid="discard-old"]'), 'click');
    await flush();
    assert.equal(discarded, 'old');
    m.cleanup();
  });

  // Capability disclosure. The mechanism in use is named rather than left implicit, and the
  // mobile warning exists because backgrounding and page-memory limits are the real ceiling
  // on a phone and neither is something the app can detect or work around.
  test('names the mechanism this download will use', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={DESKTOP} />);
    assert.notEqual(m.query('[data-testid="tier-notice"]'), null);
    m.cleanup();
  });

  test('warns on a phone, where the real limits are not detectable', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={MOBILE} />);
    const warn = m.query('[data-testid="mobile-warning"]');
    assert.notEqual(warn, null);
    assert.ok(/switch apps|background/i.test(warn.textContent));
    m.cleanup();
  });

  test('does not warn about phones on a desktop browser', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={DESKTOP} />);
    assert.equal(m.query('[data-testid="mobile-warning"]'), null);
    m.cleanup();
  });

  // Advertising a mechanism that is not built would be the same class of untruth as a
  // progress bar the app cannot back up.
  test('HONESTY: does not promise folder delivery it cannot perform', () => {
    const capable = { ...DESKTOP, directoryPicker: true, writableFiles: true };
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={capable} />);
    const body = m.text();
    assert.ok(/flat/i.test(body), 'must still say files arrive flat');
    m.cleanup();
  });

  test('works when no capabilities are supplied', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.notEqual(m.query('[data-testid="scan"]'), null);
    m.cleanup();
  });

  // Enumeration of a large prefix can run for minutes. Without a way to stop it the only
  // exit is closing the panel, which previously discarded the job out from under a crawl
  // that was still writing to it.
  test('offers a way to stop a long listing', async () => {
    const api = fakeApi({ enumerate: () => new Promise(() => {}) });   // never settles
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    assert.notEqual(m.query('[data-testid="cancel-scan"]'), null);
    m.cleanup();
  });

  test('cancelling a listing stops the crawl and discards the partial job', async () => {
    let cancelSeen = false;
    let discarded = null;
    const api = fakeApi({
      enumerate: async (_job, { shouldCancel }) => {
        // Stand in for a crawl that checks between pages.
        for (let i = 0; i < 100; i++) {
          if (shouldCancel?.()) { cancelSeen = true; return { objects: 5, bytes: 5, cancelled: true, done: false }; }
          await new Promise(r => setTimeout(r, 1));
        }
        return { objects: 5, bytes: 5, cancelled: false, done: true };
      },
      discard: async (id) => { discarded = id; },
    });

    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    fire(m.query('[data-testid="cancel-scan"]'), 'click');
    await new Promise(r => setTimeout(r, 60));

    assert.equal(cancelSeen, true, 'the crawl must be told to stop');
    assert.equal(discarded, 'job-1', 'a half-enumerated job is not worth keeping');
    assert.equal(m.query('[data-testid="start"]'), null);
    m.cleanup();
  });

  // Closing must not delete the job while a crawl is still writing pages into it.
  test('closing mid-listing cancels rather than discarding underneath the crawl', async () => {
    const order = [];
    const api = fakeApi({
      enumerate: async (_job, { shouldCancel }) => {
        for (let i = 0; i < 100; i++) {
          if (shouldCancel?.()) { order.push('crawl-stopped'); return { objects: 1, bytes: 1, cancelled: true, done: false }; }
          await new Promise(r => setTimeout(r, 1));
        }
        return { objects: 1, bytes: 1, cancelled: false, done: true };
      },
      discard: async () => { order.push('discard'); },
    });

    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    fire(m.query('[data-testid="panel-close"]'), 'click');
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(order, ['crawl-stopped', 'discard'],
      'the crawl must stop before its job is deleted, not after');
    m.cleanup();
  });

  test('an empty folder cannot be started', async () => {
    const api = fakeApi({
      enumerate: async (_j, { onProgress }) => {
        onProgress?.({ objects: 0, bytes: 0 });
        return { objects: 0, bytes: 0, done: true, cancelled: false };
      },
    });
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="" api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="start"]'), null);
    assert.ok(/nothing|empty|no files/i.test(m.text()));
    m.cleanup();
  });
});

// Archived objects are recorded SKIPPED at enumeration, so they are counted in the total
// but will never be issued. Saying "Send 412 files" when 12 of them cannot be sent is a
// lie the user only discovers by their absence — this tier cannot report their failure.
describe('DownloadJobPanel — archived objects', () => {
  const withArchived = (archived) => fakeApi({
    enumerate: async () => ({ objects: 412, bytes: 840 * 1024 ** 3, archived, done: true, cancelled: false }),
  });

  test('warns when some objects are archived, naming the count', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={withArchived(12)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const text = m.text();
    assert.match(text, /12/, 'the archived count must be shown');
    assert.match(text, /archiv/i, 'the reason must be named, not just a smaller number');
    m.cleanup();
  });

  test('offers to send only the objects that can actually be sent', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={withArchived(12)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.match(m.query('[data-testid="start"]').textContent, /\b400\b/,
      'the button must offer 412 - 12 = 400, not the raw total');
    m.cleanup();
  });

  test('says nothing about archiving when nothing is archived', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={withArchived(0)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(/archiv/i.test(m.text()), false, 'no archived files means no archive warning');
    assert.match(m.query('[data-testid="start"]').textContent, /\b412\b/);
    m.cleanup();
  });

  // Every object archived means there is nothing to send at all.
  test('does not offer to start when every object is archived', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={withArchived(412)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="start"]'), null, 'nothing sendable means no start button');
    assert.match(m.text(), /archiv/i);
    m.cleanup();
  });
});

// A job that issued files is kept so its arrival can be checked. Verification reads the
// folder the user picks — read-only, no requests, no egress — and is the only thing that
// can turn "we handed this over" into "this actually landed".
describe('DownloadJobPanel — verifying what arrived', () => {
  const CAN_PICK = { ...DESKTOP, directoryPicker: true };
  const verifiable = (over = {}) => fakeApi({
    listVerifiable: async () => [{ id: 'job-9', prefix: 'videos/', issued: 412 }],
    ...over,
  });

  test('offers to verify a job that sent files', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={verifiable()} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.ok(m.query('[data-testid="verify-job-9"]'), 'a verify action must be offered');
    assert.match(m.text(), /412/);
    m.cleanup();
  });

  // showDirectoryPicker is Chromium-only. Offering a button that throws on Firefox and
  // Safari would be worse than saying nothing.
  test('offers no verification when the browser has no directory picker', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={verifiable()} capabilities={DESKTOP}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.equal(m.query('[data-testid="verify-job-9"]'), null);
    m.cleanup();
  });

  test('reports what the folder reading found', async () => {
    const api = verifiable({ verify: async () => ({ confirmed: 400, missing: 10, mismatched: 2, ambiguous: 0, renamed: 0 }) });
    global.window.showDirectoryPicker = async () => ({ values: async function* () {} });

    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();
    fire(m.query('[data-testid="verify-job-9"]'), 'click');
    await flush();

    const text = m.text();
    assert.match(text, /400/, 'the confirmed count must be shown');
    assert.match(text, /10/, 'the missing count must be shown');
    m.cleanup();
  });

  // Cancelling the folder picker throws AbortError. That is a normal user action, not a
  // failure worth an error banner.
  test('a cancelled folder picker leaves no error behind', async () => {
    global.window.showDirectoryPicker = async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };

    const m = mount(<DownloadJobPanel bucket="bkt" prefix="v/" api={verifiable()} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();
    fire(m.query('[data-testid="verify-job-9"]'), 'click');
    await flush();

    assert.equal(/could not|failed|error/i.test(m.text()), false, 'cancelling is not an error');
    m.cleanup();
  });
});
