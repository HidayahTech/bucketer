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
import { JOB_CLASS } from '../../src/lib/download-lifecycle.js';

const DESKTOP = { directoryPicker: false, opfs: true, streamingFetch: true, likelyMobile: false };
const MOBILE = { ...DESKTOP, likelyMobile: true };
const CAN_PICK = { ...DESKTOP, directoryPicker: true };

const NOOP = () => {};

// A classified job row, as api.listJobs returns them.
const classified = (over = {}) => ({
  id: 'old', prefix: 'videos/', bucket: 'bkt',
  counters: { total: 412, bytesTotal: 900, sendable: 412, bytesSendable: 900 },
  counts: { pending: 100, failed: 72, issued: 240, done: 0 },
  jobClass: JOB_CLASS.UNFINISHED,
  ...over,
});

function fakeApi(over = {}) {
  return {
    listJobs: async () => [],
    startJob: async ({ mode }) => ({ id: 'job-1', mode }),
    enumerate: async (_job, { onProgress }) => {
      onProgress?.({ objects: 412, bytes: 840 * 1024 ** 3 });
      return { objects: 412, bytes: 840 * 1024 ** 3, done: true, cancelled: false };
    },
    verify: async () => ({ confirmed: 0, missing: 0, mismatched: 0, ambiguous: 0, renamed: 0 }),
    discard: async () => {},
    ...over,
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('DownloadJobPanel', () => {
  test('names the folder it is about to download', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'videos/' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.equal(m.text().includes('videos/'), true);
    m.cleanup();
  });

  test('HONESTY: says up front that it cannot show transfer progress', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.ok(/can(not|'t) (see|show)/i.test(m.text()));
    m.cleanup();
  });

  test('HONESTY: warns that files arrive flat, not as folders', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.ok(/folder/i.test(m.text()));
    assert.notEqual(m.query('[data-testid="mode-flatten"]'), null);
    assert.notEqual(m.query('[data-testid="mode-leaf"]'), null);
    m.cleanup();
  });

  test('lists the folder and reports what it found', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const body = m.text();
    assert.equal(body.includes('412'), true);
    assert.ok(/GB|GiB/.test(body), 'the size must be shown before committing');
    m.cleanup();
  });

  test('puts the real numbers on the confirm button', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const start = m.query('[data-testid="start"]');
    assert.notEqual(start, null);
    assert.equal(start.textContent.includes('412'), true);
    m.cleanup();
  });

  test('mentions egress cost before a large transfer', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    assert.ok(/egress|bill|cost/i.test(m.text()));
    m.cleanup();
  });

  test('passes the chosen naming mode through', async () => {
    let started;
    const api = fakeApi({ startJob: async ({ mode }) => { started = mode; return { id: 'j', mode }; } });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);

    fire(m.query('[data-testid="mode-flatten"]'), 'click');
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(started, NAMING_MODES.FLATTEN);
    m.cleanup();
  });

  test('hands the job to onStart when confirmed', async () => {
    let handed = null;
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={j => { handed = j; }} onClose={NOOP} />);
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
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    fire(m.query('[data-testid="panel-close"]'), 'click');
    await flush();

    assert.equal(discarded, 'job-1');
    m.cleanup();
  });

  test('reports an enumeration failure instead of pretending it worked', async () => {
    const api = fakeApi({ enumerate: async () => { throw new Error('AccessDenied'); } });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.text().includes('AccessDenied'), true);
    assert.equal(m.query('[data-testid="start"]'), null);
    m.cleanup();
  });

  test('offers the transfer-tool route as a sibling, not a fallback', () => {
    let asked = false;
    const m = mount(
      <DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP}
        onUseTransferTool={() => { asked = true; }} />,
    );
    fire(m.query('[data-testid="use-transfer-tool"]'), 'click');
    assert.equal(asked, true);
    m.cleanup();
  });

  // Selection scope: the label is the scope line, and the transfer-tool link is hidden
  // because the Stage 1 command generator is prefix-scoped (spec decision 3).
  test('selection scope shows its label and hides the transfer-tool link', async () => {
    const m = mount(
      <DownloadJobPanel bucket="bkt"
        scope={{ kind: 'selection', roots: [{ type: 'file', key: 'a.txt', size: 1, etag: '"a"', lastModified: null, storageClass: null }], label: '1 selected item in bkt' }}
        api={fakeApi()} onStart={NOOP} onClose={NOOP} onUseTransferTool={NOOP} />,
    );
    await flush();
    assert.ok(m.text().includes('1 selected item in bkt'));
    assert.equal(m.query('[data-testid="use-transfer-tool"]'), null);
    m.cleanup();
  });

  test('folder scope still offers the transfer-tool link', async () => {
    const m = mount(
      <DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'p/' }}
        api={fakeApi()} onStart={NOOP} onClose={NOOP} onUseTransferTool={NOOP} />,
    );
    await flush();
    assert.ok(m.query('[data-testid="use-transfer-tool"]'));
    m.cleanup();
  });

  test('scan() passes the scope roots and label to startJob', async () => {
    let started = null;
    const api = fakeApi({ startJob: async (args) => { started = args; return { id: 'j1' }; } });
    const roots = [{ type: 'file', key: 'a.txt', size: 1, etag: '"a"', lastModified: null, storageClass: null }];
    const m = mount(
      <DownloadJobPanel bucket="bkt" scope={{ kind: 'selection', roots, label: '1 selected item in bkt' }}
        api={api} onStart={NOOP} onClose={NOOP} />,
    );
    await flush();
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();
    assert.equal(started.roots, roots);
    assert.equal(started.label, '1 selected item in bkt');
    assert.equal(started.prefix, '');
    m.cleanup();
  });

  // The durable manifest only earns its keep if an interrupted job can be picked up in a
  // later session. The panel is the download entry point, so it is where they surface.
  test('surfaces an unfinished job from a previous session', async () => {
    const api = fakeApi({ listJobs: async () => [classified()] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    await flush();

    const body = m.text();
    assert.ok(/unfinished|resume|earlier|previous/i.test(body));
    assert.equal(body.includes('videos/'), true);
    assert.equal(body.includes('172'), true, 'pending + failed is what remains to send');
    m.cleanup();
  });

  test('resuming hands the existing job straight to onStart', async () => {
    let handed = null;
    const api = fakeApi({ listJobs: async () => [classified()] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={j => { handed = j; }} onClose={NOOP} />);
    await flush();

    fire(m.query('[data-testid="resume-old"]'), 'click');
    assert.equal(handed?.id, 'old');
    m.cleanup();
  });

  test('an unfinished job can be discarded', async () => {
    let discarded = null;
    const api = fakeApi({
      listJobs: async () => [classified()],
      discard: async (id) => { discarded = id; },
    });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    await flush();

    fire(m.query('[data-testid="discard-old"]'), 'click');
    await flush();
    assert.equal(discarded, 'old');
    m.cleanup();
  });

  // Postmortem F6 regression: a paused job with both failures and issued files is ONE
  // row (unfinished, since work remains), never two rows with two Discards.
  test('a job with failures and issued files renders exactly one row', async () => {
    const api = fakeApi({ listJobs: async () => [classified({ counts: { pending: 0, failed: 2, issued: 6, done: 0 } })] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.equal(m.queryAll('[data-testid="discard-old"]').length, 1,
      'one job, one row, one Discard');
    assert.notEqual(m.query('[data-testid="resume-old"]'), null, 'work remains, so it resumes');
    assert.ok(m.text().includes('6 already sent'), 'the sent portion is disclosed on the same row');
    m.cleanup();
  });

  // Capability disclosure. The mechanism in use is named rather than left implicit, and the
  // mobile warning exists because backgrounding and page-memory limits are the real ceiling
  // on a phone and neither is something the app can detect or work around.
  test('names the mechanism this download will use', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={DESKTOP} />);
    assert.notEqual(m.query('[data-testid="tier-notice"]'), null);
    m.cleanup();
  });

  test('warns on a phone, where the real limits are not detectable', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={MOBILE} />);
    const warn = m.query('[data-testid="mobile-warning"]');
    assert.notEqual(warn, null);
    assert.ok(/switch apps|background/i.test(warn.textContent));
    m.cleanup();
  });

  test('does not warn about phones on a desktop browser', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={DESKTOP} />);
    assert.equal(m.query('[data-testid="mobile-warning"]'), null);
    m.cleanup();
  });

  // Advertising a mechanism that is not built would be the same class of untruth as a
  // progress bar the app cannot back up.
  test('HONESTY: does not promise folder delivery it cannot perform', () => {
    const capable = { ...DESKTOP, directoryPicker: true, writableFiles: true };
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP}
      onClose={NOOP} capabilities={capable} />);
    const body = m.text();
    assert.ok(/flat/i.test(body), 'must still say files arrive flat');
    m.cleanup();
  });

  test('works when no capabilities are supplied', () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={fakeApi()} onStart={NOOP} onClose={NOOP} />);
    assert.notEqual(m.query('[data-testid="scan"]'), null);
    m.cleanup();
  });

  // Enumeration of a large prefix can run for minutes. Without a way to stop it the only
  // exit is closing the panel, which previously discarded the job out from under a crawl
  // that was still writing to it.
  test('offers a way to stop a long listing', async () => {
    const api = fakeApi({ enumerate: () => new Promise(() => {}) });   // never settles
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
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

    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
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

    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
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
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: '' }} api={api} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="start"]'), null);
    assert.ok(/nothing|empty|no files/i.test(m.text()));
    m.cleanup();
  });
});

// Archived objects are recorded SKIPPED at enumeration, so they are in the totals but
// will never be issued. Saying "Send 412 files" when 12 of them cannot be sent is a lie
// the user only discovers by absence — and the size quoted must describe the same set as
// the count (catalog defects 17/19: the count once shrank while the bytes did not).
describe('DownloadJobPanel — archived objects', () => {
  const GB = 1024 ** 3;
  const withArchived = (archived, archivedBytes = archived * GB) => fakeApi({
    enumerate: async () => ({
      objects: 412, bytes: 840 * GB, archived, archivedBytes, done: true, cancelled: false,
    }),
  });

  test('warns when some objects are archived, naming the count and size', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={withArchived(12)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const notice = m.query('[data-testid="archived-notice"]');
    assert.notEqual(notice, null);
    assert.match(notice.textContent, /12/, 'the archived count must be shown');
    m.cleanup();
  });

  test('the offer counts and sizes only what can actually be sent', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={withArchived(12)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    const start = m.query('[data-testid="start"]');
    assert.match(start.textContent, /\b400\b/, '412 − 12 archived = 400');
    assert.match(start.textContent, /828/, 'the size must be 840 GB − 12 GB, not the full total');
    m.cleanup();
  });

  test('says nothing about archiving when nothing is archived', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={withArchived(0, 0)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="archived-notice"]'), null);
    assert.match(m.query('[data-testid="start"]').textContent, /\b412\b/);
    m.cleanup();
  });

  test('does not offer to start when every object is archived', async () => {
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={withArchived(412, 840 * GB)} onStart={NOOP} onClose={NOOP} />);
    fire(m.query('[data-testid="scan"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="start"]'), null, 'nothing sendable means no start button');
    m.cleanup();
  });
});

// The reachability invariant, at the rendering layer: every persisted job renders exactly
// one row, and every row carries Discard on EVERY browser. Only the check ACTION is
// capability-gated. (Postmortem F3 / catalog 18: a job invisible to every list had no
// Discard, so its manifest was permanent — on Firefox and Safari even a clean one.)
describe('DownloadJobPanel — sent and settled jobs', () => {
  const sentJob = (over = {}) => classified({
    id: 'job-9', prefix: 'videos/', jobClass: JOB_CLASS.SENT,
    counts: { pending: 0, failed: 0, issued: 412, done: 0 }, ...over,
  });

  test('a sent job renders with Discard even without a directory picker', async () => {
    const api = fakeApi({ listJobs: async () => [sentJob()] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={DESKTOP}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.notEqual(m.query('[data-testid="discard-job-9"]'), null,
      'no browser may strand a manifest without a Discard');
    assert.equal(m.query('[data-testid="verify-job-9"]'), null,
      'the check action needs the picker; the row does not');
    m.cleanup();
  });

  test('a sent job offers the folder check when the picker exists', async () => {
    const api = fakeApi({ listJobs: async () => [sentJob()] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.notEqual(m.query('[data-testid="verify-job-9"]'), null);
    assert.match(m.text(), /412/);
    m.cleanup();
  });

  test('a settled job shows its confirmation and can be discarded', async () => {
    const api = fakeApi({ listJobs: async () => [sentJob({
      jobClass: JOB_CLASS.SETTLED, counts: { pending: 0, failed: 0, issued: 0, done: 412 },
    })] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={DESKTOP}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    assert.ok(/confirmed/i.test(m.text()));
    assert.notEqual(m.query('[data-testid="discard-job-9"]'), null);
    m.cleanup();
  });

  test('a previous check‘s summary is shown from the job record, surviving panel close', async () => {
    const api = fakeApi({ listJobs: async () => [sentJob({
      lastVerify: { confirmed: 400, missing: 10, mismatched: 2, ambiguous: 0, renamed: 0, at: 1 },
    })] });
    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();

    const summary = m.query('[data-testid="verified-job-9"]');
    assert.notEqual(summary, null);
    assert.match(summary.textContent, /400/, 'the confirmed count must be shown');
    assert.match(summary.textContent, /10/, 'the missing count must be shown');
    m.cleanup();
  });
});

describe('DownloadJobPanel — the folder check', () => {
  const sentJob = () => classified({
    id: 'job-9', prefix: 'videos/', jobClass: JOB_CLASS.SENT,
    counts: { pending: 0, failed: 0, issued: 412, done: 0 },
  });

  test('checking re-lists the jobs so verdicts and class changes appear', async () => {
    let calls = 0;
    const api = fakeApi({
      listJobs: async () => {
        calls += 1;
        return calls === 1 ? [sentJob()] : [{ ...sentJob(), lastVerify: { confirmed: 412, missing: 0, mismatched: 0, ambiguous: 0, renamed: 0, at: 1 } }];
      },
    });
    global.window.showDirectoryPicker = async () => ({ values: async function* () {} });

    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();
    fire(m.query('[data-testid="verify-job-9"]'), 'click');
    await flush(); await flush();

    assert.match(m.text(), /412 confirmed/, 'the fresh verdict must be rendered');
    m.cleanup();
  });

  // Postmortem F4 regression: a verification failure was stored into state no branch ever
  // rendered — the bucket-mismatch guard's message was unreachable by design.
  test('a failing check shows its reason instead of silently doing nothing', async () => {
    const api = fakeApi({
      listJobs: async () => [sentJob()],
      verify: async () => { throw new Error('That download was created for a different bucket. Reconnect to it to check it.'); },
    });
    global.window.showDirectoryPicker = async () => ({ values: async function* () {} });

    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();
    fire(m.query('[data-testid="verify-job-9"]'), 'click');
    await flush(); await flush();

    const err = m.query('[data-testid="verify-error"]');
    assert.notEqual(err, null, 'the error must be rendered, not swallowed');
    assert.match(err.textContent, /different bucket/);
    m.cleanup();
  });

  // Cancelling the folder picker throws AbortError. That is a normal user action, not a
  // failure worth an error banner.
  test('a cancelled folder picker leaves no error behind', async () => {
    global.window.showDirectoryPicker = async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
    const api = fakeApi({ listJobs: async () => [sentJob()] });

    const m = mount(<DownloadJobPanel bucket="bkt" scope={{ kind: 'folder', prefix: 'v/' }} api={api} capabilities={CAN_PICK}
      onStart={NOOP} onClose={NOOP} />);
    await flush();
    fire(m.query('[data-testid="verify-job-9"]'), 'click');
    await flush();

    assert.equal(m.query('[data-testid="verify-error"]'), null, 'cancelling is not an error');
    m.cleanup();
  });
});
