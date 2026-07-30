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
