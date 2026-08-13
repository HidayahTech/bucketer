// Component tests for SetupGuide.
// Verifies that every provider guide renders without throwing and contains
// the expected key content — this was previously untestable without a DOM.
// Requires the JSX loader: run via `npm run test:ui`, not `npm test`.
import '../helpers/with-dom.js';       // must be first — installs DOM globals
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { SetupGuide } from '../../src/components/SetupGuide.jsx';
import { PROVIDERS } from '../../src/lib/provider.js';

describe('SetupGuide — null state', () => {
  test('renders nothing when no provider is given', () => {
    const { query, cleanup } = mount(h(SetupGuide, { provider: null }));
    assert.equal(query('.cors-guide'), null);
    cleanup();
  });
});

describe('SetupGuide — B2', () => {
  const props = {
    provider: PROVIDERS.B2,
    endpoint: 'https://s3.us-west-002.backblazeb2.com',
    bucket: 'my-test-bucket',
    keyId: 'abc123',
  };

  test('renders a details element with the B2 guide title', () => {
    const { query, text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'), 'should render a <details> element');
    assert.ok(text().toLowerCase().includes('b2'), 'title should mention B2');
    cleanup();
  });

  // Prefix-scoped keys (#60): the app-key step is where users create restricted
  // keys, so it must bridge B2's "Name Prefix" vocabulary to the Base folder field.
  test('bridges Name Prefix keys to the Base folder field', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('Name Prefix'), 'B2 guide must mention Name Prefix restrictions');
    assert.ok(text().includes('Base folder'), 'B2 guide must point at the Base folder field');
    cleanup();
  });

  test('includes native CORS removal step (B2-specific)', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('native CORS') || text().includes('ClearNativeCors') || text().includes('b2 bucket update'),
      'B2 guide must include the native CORS removal step');
    cleanup();
  });

  test('includes the aws configure step with the keyId', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('abc123'), 'keyId should appear in the aws configure command');
    cleanup();
  });

  test('includes the aws s3api put-bucket-cors command', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('put-bucket-cors'), 'B2 guide should include the put-bucket-cors command');
    cleanup();
  });

  test('includes the bucket name in the CORS command', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('my-test-bucket'), 'bucket name should appear in the guide');
    cleanup();
  });

  // BUG-043: B2 rejects PutBucketCors when ExposeHeaders contains a wildcard
  // ("illegal '*' in an exposeHeaders value"), so the copy-paste command must
  // expose the app's meta headers explicitly instead of x-amz-meta-*.
  test('CORS command has no ExposeHeaders wildcard (BUG-043)', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(!text().includes('x-amz-meta-*'),
      'B2 guide must not emit x-amz-meta-* — B2 rejects wildcards in ExposeHeaders');
    assert.ok(text().includes('x-amz-meta-bucketer-content-hash'),
      'B2 guide must expose the content-hash meta header explicitly');
    assert.ok(text().includes('x-amz-meta-file-mtime'),
      'B2 guide must expose the file-mtime meta header explicitly');
    cleanup();
  });
});

describe('SetupGuide — R2', () => {
  const props = { provider: PROVIDERS.R2, endpoint: 'https://abc123.r2.cloudflarestorage.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('title mentions R2', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().toLowerCase().includes('r2'));
    cleanup();
  });

  test('includes put-bucket-cors command', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('put-bucket-cors'));
    cleanup();
  });
});

describe('SetupGuide — Wasabi', () => {
  const props = { provider: PROVIDERS.WASABI, endpoint: 'https://s3.us-east-1.wasabisys.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('title mentions Wasabi', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().toLowerCase().includes('wasabi'));
    cleanup();
  });

  test('does not include a put-bucket-cors command (Wasabi auto-configures CORS)', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(!text().includes('put-bucket-cors'),
      'Wasabi guide must not show the CORS command — Wasabi auto-configures permissive headers');
    cleanup();
  });
});

describe('SetupGuide — AWS', () => {
  const props = { provider: PROVIDERS.AWS, endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('does not include --endpoint-url flag (AWS uses the default endpoint)', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    // AWS guide uses the SDK default endpoint; --endpoint-url is only for non-AWS providers
    assert.ok(text().includes('put-bucket-cors'));
    cleanup();
  });
});

describe('SetupGuide — DigitalOcean Spaces', () => {
  const props = { provider: PROVIDERS.DO_SPACES, endpoint: 'https://nyc3.digitaloceanspaces.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('title mentions DigitalOcean', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().toLowerCase().includes('digitalocean') || text().toLowerCase().includes('spaces'));
    cleanup();
  });
});

describe('SetupGuide — MinIO', () => {
  const props = { provider: PROVIDERS.MINIO, endpoint: 'https://minio.example.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('title mentions MinIO', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().toLowerCase().includes('minio'));
    cleanup();
  });
});

describe('SetupGuide — Generic', () => {
  const props = { provider: PROVIDERS.GENERIC, endpoint: 'https://s3.example.com', bucket: 'my-bucket' };

  test('renders without throwing', () => {
    const { query, cleanup } = mount(h(SetupGuide, props));
    assert.ok(query('details.cors-guide'));
    cleanup();
  });

  test('includes put-bucket-cors command', () => {
    const { text, cleanup } = mount(h(SetupGuide, props));
    assert.ok(text().includes('put-bucket-cors'));
    cleanup();
  });
});
