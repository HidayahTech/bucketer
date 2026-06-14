// Tests for IntegrityCheck — the in-app honest-host integrity check UI.
import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire } from '../helpers/render.js';
import { IntegrityCheck } from '../../src/components/IntegrityCheck.jsx';

const VERSION = '1.21.1';

// Ensure document.querySelector('meta[name="app-version"]') returns our test version.
beforeEach(() => {
  document.head.querySelectorAll('meta[name="app-version"]').forEach(el => el.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'app-version');
  meta.setAttribute('content', VERSION);
  document.head.appendChild(meta);
});

function fakeVerify(result) {
  return async () => result;
}

async function flush() {
  // Two microtask flushes — one for the verify promise to resolve, one for the
  // useState update queued inside the .then handler to render.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('IntegrityCheck — idle state', () => {
  test('renders a verify button by default', () => {
    const { query, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify({ status: 'match' }) }));
    const btn = query('button');
    assert.ok(btn, 'must render a button');
    assert.ok(/verify/i.test(btn.textContent), `button label must mention verify, got: ${btn.textContent}`);
    cleanup();
  });

  test('explains the honest-host limit in the hint text', () => {
    const { text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify({ status: 'match' }) }));
    const body = text().toLowerCase();
    assert.ok(body.includes('does not prove') || body.includes('cannot prove'),
      'hint text must surface the limit that this does not prove the JS is untampered');
    cleanup();
  });
});

describe('IntegrityCheck — result rendering', () => {
  test('match → renders banner-success with truncated hash', async () => {
    const result = { status: 'match', version: VERSION, algorithm: 'sha256',
                     hash: 'cc9a608c6d048f2d4a2ad686ca1b5b9cfcf63080216e49405d67d2df9bfb4e9c' };
    const { query, text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify(result) }));
    fire(query('button'), 'click');
    await flush();
    assert.ok(query('.banner-success'), 'must render a success banner');
    assert.ok(text().includes('cc9a608c'), 'must show at least a prefix of the hash');
    cleanup();
  });

  test('mismatch → renders banner-danger with both hashes', async () => {
    const result = { status: 'mismatch', version: VERSION, algorithm: 'sha256',
                     actual: 'aaaa608c6d048f2d4a2ad686ca1b5b9cfcf63080216e49405d67d2df9bfb4e9c',
                     expected: 'bbbb608c6d048f2d4a2ad686ca1b5b9cfcf63080216e49405d67d2df9bfb4e9c' };
    const { query, text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify(result) }));
    fire(query('button'), 'click');
    await flush();
    assert.ok(query('.banner-danger'), 'must render a danger banner on mismatch');
    const body = text();
    assert.ok(body.includes('aaaa608c'), 'must show served hash');
    assert.ok(body.includes('bbbb608c'), 'must show expected hash');
    cleanup();
  });

  test('no-manifest → renders banner-warn explaining the version predates the feature', async () => {
    const result = { status: 'no-manifest', version: VERSION };
    const { query, text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify(result) }));
    fire(query('button'), 'click');
    await flush();
    assert.ok(query('.banner-warn'), 'must render a warn banner when no manifest exists');
    assert.ok(/manifest/i.test(text()), 'message must reference the missing manifest');
    cleanup();
  });

  test('unknown-algorithm → renders banner-warn listing the unsupported algorithms', async () => {
    const result = { status: 'unknown-algorithm', version: VERSION, algorithms: ['blake3', 'sha3_256'] };
    const { query, text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify(result) }));
    fire(query('button'), 'click');
    await flush();
    assert.ok(query('.banner-warn'));
    const body = text();
    assert.ok(body.includes('blake3') && body.includes('sha3_256'),
      'must list the algorithms the manifest expected');
    cleanup();
  });

  test('network-error → renders banner-warn with the error message', async () => {
    const result = { status: 'network-error', version: VERSION, message: 'Manifest fetch failed: CORS' };
    const { query, text, cleanup } = mount(h(IntegrityCheck, { verify: fakeVerify(result) }));
    fire(query('button'), 'click');
    await flush();
    assert.ok(query('.banner-warn'));
    assert.ok(text().includes('CORS'), 'must surface the error message');
    cleanup();
  });
});

describe('IntegrityCheck — running state', () => {
  test('button is disabled while verify is in flight', async () => {
    let resolveVerify;
    const verify = () => new Promise(r => { resolveVerify = r; });
    const { query, cleanup } = mount(h(IntegrityCheck, { verify }));
    fire(query('button'), 'click');
    await Promise.resolve();
    assert.ok(query('button').disabled, 'button must be disabled while verify is in flight');
    resolveVerify({ status: 'match', version: VERSION, algorithm: 'sha256', hash: 'x'.repeat(64) });
    await flush();
    cleanup();
  });
});

describe('IntegrityCheck — version-from-meta', () => {
  test('passes the app-version meta tag content to verify', async () => {
    let captured = null;
    const verify = async (args) => {
      captured = args;
      return { status: 'match', version: args.version, algorithm: 'sha256', hash: 'x'.repeat(64) };
    };
    const { query, cleanup } = mount(h(IntegrityCheck, { verify }));
    fire(query('button'), 'click');
    await flush();
    assert.equal(captured?.version, VERSION,
      'IntegrityCheck must read the running version from the app-version meta tag');
    cleanup();
  });
});
