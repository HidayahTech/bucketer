// UploadQueue connection binding (GitLab #72 / R01). UploadQueue stays mounted across a
// connected-to-connected switch, and App routes drag-drops through the addFiles it received
// once via onMount. Before the fix that function closed over the MOUNT-time client/bucket, so a
// drop after switching A→B was sent to A while the screen showed B. Observable: which client,
// and which Bucket, received the PutObject.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { UploadQueue } from '../../src/components/UploadQueue.jsx';

const caps = { list: 'permitted', download: 'permitted', upload: 'permitted', delete: 'permitted' };

function recordingClient(label) {
  const calls = [];
  return {
    label,
    calls,
    send: (cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return Promise.resolve({});
    },
  };
}

function props(client, bucket, extra = {}) {
  return {
    client,
    bucket,
    provider: 'generic',
    currentPrefix: '',
    credentials: { bucket, endpoint: `https://${bucket}.example.test` },
    capabilities: caps,
    onCapabilityChange: () => {},
    onUploadsComplete: () => {},
    onLogEntry: () => {},
    ...extra,
  };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  return true;
}

const puts = (c) => c.calls.filter((x) => x.name === 'PutObjectCommand');

describe('UploadQueue — uploads follow the current connection (#72, R01)', () => {
  test('a drop routed through the onMount addFiles after an A→B switch uploads to B, not A', async () => {
    const a = recordingClient('A');
    const b = recordingClient('B');
    let exposed = null;
    const onMount = ({ addFiles }) => {
      exposed = addFiles;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      act(() => render(h(UploadQueue, props(a, 'bucket-a', { onMount })), container));
      // Connected-to-connected switch: same mounted instance, new client and bucket.
      act(() => render(h(UploadQueue, props(b, 'bucket-b', { onMount })), container));

      act(() =>
        exposed([{ file: new File(['dropped'], 'dropped.txt', { type: 'text/plain' }), relativePath: 'dropped.txt' }]),
      );
      const sent = await waitFor(() => puts(a).length + puts(b).length > 0);
      assert.ok(sent, 'the drop must produce a PutObject on some client');

      assert.equal(puts(a).length, 0, `bucket-a must receive nothing, got ${JSON.stringify(puts(a))}`);
      assert.equal(puts(b).length, 1);
      assert.equal(puts(b)[0].input.Bucket, 'bucket-b');
      assert.equal(puts(b)[0].input.Key, 'dropped.txt');
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });

  test('retrying an item that failed in A after switching to B re-uploads to A, its own origin', async () => {
    const a = recordingClient('A');
    let failNext = true;
    const realSend = a.send;
    a.send = (cmd) => {
      if (failNext && cmd.constructor.name === 'PutObjectCommand') {
        failNext = false;
        a.calls.push({ name: cmd.constructor.name, input: cmd.input });
        return Promise.reject(new Error('network down'));
      }
      return realSend(cmd);
    };
    const b = recordingClient('B');
    let exposed = null;
    const onMount = ({ addFiles }) => {
      exposed = addFiles;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      act(() => render(h(UploadQueue, props(a, 'bucket-a', { onMount })), container));
      act(() =>
        exposed([{ file: new File(['in A'], 'a-file.txt', { type: 'text/plain' }), relativePath: 'a-file.txt' }]),
      );
      const findRetry = () => [...container.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Retry');
      assert.ok(await waitFor(() => findRetry()), 'the failed A upload must offer Retry');

      act(() => render(h(UploadQueue, props(b, 'bucket-b', { onMount })), container));
      act(() => findRetry().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      assert.ok(await waitFor(() => puts(a).length + puts(b).length > 1), 'Retry must send a PutObject');

      assert.equal(puts(b).length, 0, `bucket-b must receive nothing, got ${JSON.stringify(puts(b))}`);
      assert.equal(puts(a).length, 2);
      assert.equal(puts(a)[1].input.Bucket, 'bucket-a');
      assert.equal(puts(a)[1].input.Key, 'a-file.txt');
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });
});
