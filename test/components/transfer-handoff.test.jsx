// Copyright (C) 2026 HidayahTech, LLC
// Tests for TransferHandoff — the Stage 1 CLI transfer handoff modal.
//
// The load-bearing assertion here is that the secret key is not rendered unless the
// user explicitly asks for it. Everything else is presentation.

import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mount, fire } from '../helpers/render.js';
import { TransferHandoff } from '../../src/components/TransferHandoff.jsx';
import { PROVIDERS } from '../../src/lib/provider.js';

const CREDS = {
  provider: PROVIDERS.B2,
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'KEY123',
  secretKey: 'SUPERSECRET',
  regionOverride: '',
};

const NOOP = () => {};

describe('TransferHandoff', () => {
  test('renders the rclone config and both commands', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="videos/" onClose={NOOP} />);
    const body = m.text();
    assert.equal(body.includes('type = s3'), true);
    assert.equal(body.includes('provider = Other'), true);
    assert.equal(body.includes('rclone copy'), true);
    assert.equal(body.includes('aws s3 sync'), true);
    m.cleanup();
  });

  test('scopes the command to the current prefix', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="videos/2024/" onClose={NOOP} />);
    assert.equal(m.text().includes('my-bucket/videos/2024'), true);
    m.cleanup();
  });

  test('derives the region from the endpoint', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="" onClose={NOOP} />);
    assert.equal(m.text().includes('region = us-west-004'), true);
    m.cleanup();
  });

  test('prefers an explicit region override', () => {
    const m = mount(
      <TransferHandoff credentials={{ ...CREDS, regionOverride: 'custom-1' }} currentPrefix="" onClose={NOOP} />,
    );
    assert.equal(m.text().includes('region = custom-1'), true);
    m.cleanup();
  });

  test('SECURITY: does not render the secret key by default', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="" onClose={NOOP} />);
    assert.equal(m.html().includes('SUPERSECRET'), false);
    assert.equal(m.text().includes('<YOUR_SECRET_KEY>'), true);
    m.cleanup();
  });

  test('reveals the secret only after the user opts in', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="" onClose={NOOP} />);
    const toggle = m.query('[data-testid="include-secret"]');
    assert.notEqual(toggle, null);
    fire(toggle, 'click');
    assert.equal(m.text().includes('SUPERSECRET'), true);
    m.cleanup();
  });

  test('warns about handling once the secret is shown', () => {
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="" onClose={NOOP} />);
    assert.equal(m.query('[data-testid="secret-warning"]'), null);
    fire(m.query('[data-testid="include-secret"]'), 'click');
    assert.notEqual(m.query('[data-testid="secret-warning"]'), null);
    m.cleanup();
  });

  test('closes via the close button', () => {
    let closed = false;
    const m = mount(<TransferHandoff credentials={CREDS} currentPrefix="" onClose={() => { closed = true; }} />);
    fire(m.query('[data-testid="handoff-close"]'), 'click');
    assert.equal(closed, true);
    m.cleanup();
  });
});
