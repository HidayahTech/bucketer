import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listObjectsPage } from '../src/lib/list-objects.js';

// Minimal mock S3 client: records each command's input + send options, and can be
// scripted to throw N times before returning a response (to exercise the retry path).
function mockClient({ failTimes = 0, error, response } = {}) {
  let calls = 0;
  const commands = [];
  return {
    calls: () => calls,
    commands,
    async send(command, opts) {
      calls++;
      commands.push({ input: command.input, opts });
      if (calls <= failTimes) throw error;
      return response;
    },
  };
}

describe('listObjectsPage', () => {
  test('builds a ListObjectsV2 command with the given params and returns the response', async () => {
    const response = { Contents: [{ Key: 'a' }], IsTruncated: false };
    const controller = new AbortController();
    const client = mockClient({ response });
    const resp = await listObjectsPage(client, { bucket: 'b', prefix: 'p/', token: 'Tok', maxKeys: 500, signal: controller.signal });
    assert.equal(resp, response);
    const { input, opts } = client.commands[0];
    assert.equal(input.Bucket, 'b');
    assert.equal(input.Prefix, 'p/');
    assert.equal(input.Delimiter, '/');
    assert.equal(input.MaxKeys, 500);
    assert.equal(input.ContinuationToken, 'Tok');
    // the abort signal is threaded to the SDK send so an in-flight request can be cancelled
    assert.equal(opts.abortSignal, controller.signal);
  });

  test('omits Prefix and ContinuationToken at the bucket root / first page', async () => {
    const client = mockClient({ response: {} });
    await listObjectsPage(client, { bucket: 'b', prefix: '', token: null, maxKeys: 1000 });
    const { input } = client.commands[0];
    assert.equal(input.Prefix, undefined);
    assert.equal(input.ContinuationToken, undefined);
  });

  test('retries a transient throttling error, then returns the response', async () => {
    const response = { Contents: [], IsTruncated: false };
    const client = mockClient({ failTimes: 1, error: { name: 'SlowDown' }, response });
    const resp = await listObjectsPage(client, { bucket: 'b', maxKeys: 1000 });
    assert.equal(resp, response);
    assert.equal(client.calls(), 2); // one throttle failure + one success
  });

  test('does NOT retry a non-transient error (e.g. AccessDenied)', async () => {
    const denied = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
    const client = mockClient({ failTimes: 5, error: denied, response: {} });
    await assert.rejects(listObjectsPage(client, { bucket: 'b', maxKeys: 1000 }), (e) => e === denied);
    assert.equal(client.calls(), 1); // no retry on a permission error
  });

  test('does NOT retry once the abort signal is aborted (user navigated away / cancelled)', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = mockClient({ failTimes: 5, error: { name: 'SlowDown' }, response: {} });
    await assert.rejects(listObjectsPage(client, { bucket: 'b', maxKeys: 1000, signal: controller.signal }));
    assert.equal(client.calls(), 1); // aborted → single attempt, no retry
  });
});
