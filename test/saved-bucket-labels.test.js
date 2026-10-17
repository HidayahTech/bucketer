// Labels for remembered buckets (accounts A, v1.66.0): the endpoint host shown on cards and in
// the connected header (REPORT C6/S4), and the "Last used" line (C8).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { endpointHost, lastUsedLabel } from '../src/lib/saved-bucket-labels.js';

describe('endpointHost', () => {
  test('returns host and port, without scheme or path', () => {
    assert.equal(endpointHost('https://s3.us-west-004.backblazeb2.com'), 's3.us-west-004.backblazeb2.com');
    assert.equal(endpointHost('http://minio.home.test:9000/'), 'minio.home.test:9000');
  });
  test('falls back to the trimmed input when it is not a URL', () => {
    assert.equal(endpointHost(' not a url '), 'not a url');
    assert.equal(endpointHost(''), '');
    assert.equal(endpointHost(undefined), '');
  });
});

describe('lastUsedLabel', () => {
  const now = new Date(2026, 9, 16, 21, 30).getTime();
  test('same day reads "today HH:MM"', () => {
    assert.equal(lastUsedLabel(new Date(2026, 9, 16, 9, 12).getTime(), now), 'Last used today 09:12');
  });
  test('previous calendar day reads "yesterday"', () => {
    assert.equal(lastUsedLabel(new Date(2026, 9, 15, 23, 59).getTime(), now), 'Last used yesterday');
  });
  test('2–13 days reads "N days ago"; 14+ reads weeks', () => {
    assert.equal(lastUsedLabel(new Date(2026, 9, 13, 12).getTime(), now), 'Last used 3 days ago');
    assert.equal(lastUsedLabel(new Date(2026, 9, 1, 12).getTime(), now), 'Last used 2 weeks ago');
  });
  test('60+ days reads months', () => {
    assert.equal(lastUsedLabel(new Date(2026, 6, 1, 12).getTime(), now), 'Last used 3 months ago');
  });
  test('a card saved before v1.66.0 has no time and says so', () => {
    assert.equal(lastUsedLabel(null, now), 'Saved before last-use tracking');
  });
});
