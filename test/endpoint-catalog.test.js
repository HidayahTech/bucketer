// Endpoint suggestions (accounts A, v1.66.0, REPORT C2 + §2.3): this device's endpoints first,
// then a provider catalog shipped as data; bucket suggestions are the buckets used on an endpoint.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT_CATALOG, endpointOptions, bucketOptions } from '../src/lib/endpoint-catalog.js';

describe('ENDPOINT_CATALOG', () => {
  test('lists every AWS, Wasabi and DigitalOcean region from the sourced tables, as https URLs', () => {
    const by = (p) => ENDPOINT_CATALOG.filter((r) => r.provider === p);
    assert.equal(by('aws').length, 36);
    assert.equal(by('wasabi').length, 16);
    assert.equal(by('do_spaces').length, 13);
    for (const r of ENDPOINT_CATALOG) assert.match(r.endpoint, /^https:\/\/[a-z0-9.-]+$/);
  });
  test('rows use the same URLs provider.js builds (so detection and region extraction agree)', () => {
    const row = (p, region) => ENDPOINT_CATALOG.find((r) => r.provider === p && r.region === region);
    assert.equal(row('aws', 'eu-west-1').endpoint, 'https://s3.eu-west-1.amazonaws.com');
    assert.equal(row('wasabi', 'us-east-1').endpoint, 'https://s3.wasabisys.com');
    assert.equal(row('do_spaces', 'nyc3').endpoint, 'https://nyc3.digitaloceanspaces.com');
    assert.equal(row('wasabi', 'eu-central-2').label, 'Wasabi · eu-central-2');
  });
});

const saved = [
  { id: 1, endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'old', provider: 'b2', lastUsedAt: 10 },
  { id: 2, endpoint: 'http://minio.home.test:9000', bucket: 'media', provider: 'minio', lastUsedAt: 30 },
  { id: 3, endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'photos', provider: 'b2', lastUsedAt: 20 },
  { id: 4, endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'aws-b', provider: 'aws', lastUsedAt: 5 },
];

describe('endpointOptions', () => {
  test('this device first, most recent first, each once; then the catalog without repeats', () => {
    const opts = endpointOptions(saved);
    assert.deepEqual(
      opts.slice(0, 3).map((o) => o.endpoint),
      ['http://minio.home.test:9000', 'https://s3.us-west-004.backblazeb2.com', 'https://s3.eu-west-1.amazonaws.com'],
    );
    assert.ok(opts[1].label.includes('2 buckets'), 'history rows say how many buckets were used there');
    assert.equal(
      opts.filter((o) => o.endpoint === 'https://s3.eu-west-1.amazonaws.com').length,
      1,
      'a catalog row already in history is not repeated',
    );
    assert.equal(opts.length, 3 + ENDPOINT_CATALOG.length - 1);
  });
  test('with nothing saved it is the catalog', () => {
    assert.equal(endpointOptions([]).length, ENDPOINT_CATALOG.length);
  });
});

describe('bucketOptions', () => {
  test('buckets used on that endpoint, most recent first; trailing slash ignored', () => {
    assert.deepEqual(bucketOptions(saved, 'https://s3.us-west-004.backblazeb2.com/'), ['photos', 'old']);
    assert.deepEqual(bucketOptions(saved, ''), []);
  });
});
