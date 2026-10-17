// Tests for CredentialForm.
// The credential form is the entry point to the entire application. Tests cover:
// field rendering, loading state, validation errors, provider auto-detection,
// and form submission.
//
// VALIDATION NOTE: credentialErrors() only flags non-empty malformed values
// (spaces, >63 chars). Empty required fields are enforced by HTML 'required'
// attributes in real browsers. jsdom does not enforce HTML required, so empty
// forms appear valid from JavaScript's perspective — the component relies on the
// browser's native form validation for that layer.
//
// CLEANUP DISCIPLINE: all mounts use try/finally to call cleanup() even when
// an assertion fails, preventing orphaned Preact trees from interfering with
// subsequent tests.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { CredentialForm } from '../../src/components/CredentialForm.jsx';

const EMPTY_INITIAL = { endpoint: '', bucket: '', keyId: '', secretKey: '', provider: null, regionOverride: '' };

const B2_INITIAL = {
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  bucket: 'my-bucket',
  keyId: 'keyabc',
  secretKey: 'secret',
  provider: 'b2',
  regionOverride: 'us-west-002',
};

// A valid bucket with a space — triggers credentialErrors.bucket
const INVALID_BUCKET = 'my bucket';

function defaultProps(overrides = {}) {
  return { initial: EMPTY_INITIAL, onSave: () => {}, onFormChange: () => {}, loading: false, ...overrides };
}

describe('CredentialForm — field rendering', () => {
  test('renders the Endpoint URL input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-endpoint'), 'endpoint input must be present');
    } finally {
      cleanup();
    }
  });

  test('renders the Bucket Name input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-bucket'), 'bucket input must be present');
    } finally {
      cleanup();
    }
  });

  test('renders the Key ID input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-keyid'), 'key ID input must be present');
    } finally {
      cleanup();
    }
  });

  test('renders the Secret Key input as type="password"', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const input = query('#cred-secretkey');
      assert.ok(input, 'secret key input must be present');
      assert.equal(input.type, 'password', 'secret key must be a password field');
    } finally {
      cleanup();
    }
  });

  test('renders the Provider Override select', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-provider'), 'provider override select must be present');
    } finally {
      cleanup();
    }
  });

  test('renders the Region input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-region'), 'region input must be present');
    } finally {
      cleanup();
    }
  });

  test('renders the Connect submit button', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const btn = query('button[type="submit"]');
      assert.ok(btn, 'submit button must be present');
      assert.ok(btn.textContent.includes('Connect'));
    } finally {
      cleanup();
    }
  });

  test('shows the sessionStorage security hint for the secret key field', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(text().includes('sessionStorage'));
    } finally {
      cleanup();
    }
  });

  test('required attribute is present on endpoint, bucket, keyId, and secretKey fields', () => {
    // HTML required is the guard for empty fields in real browsers (not jsdom).
    // This test verifies the attribute is present so the browser enforces it.
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(query('#cred-endpoint').required, 'endpoint must be required');
      assert.ok(query('#cred-bucket').required, 'bucket must be required');
      assert.ok(query('#cred-keyid').required, 'keyId must be required');
      assert.ok(query('#cred-secretkey').required, 'secretKey must be required');
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — loading state', () => {
  test('shows "Connecting…" text when loading=true', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: true })));
    try {
      assert.ok(query('button[type="submit"]').textContent.includes('Connecting'));
    } finally {
      cleanup();
    }
  });

  test('Connect button is disabled when loading=true', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: true })));
    try {
      assert.ok(query('button[type="submit"]').disabled, 'submit must be disabled while loading');
    } finally {
      cleanup();
    }
  });

  test('shows "Connect" (not "Connecting…") when loading=false', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ loading: false })));
    try {
      const text = query('button[type="submit"]').textContent;
      assert.ok(text.includes('Connect'));
      assert.ok(!text.includes('Connecting'));
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — validation', () => {
  test('Connect button is enabled when the form is empty (empty fields use HTML required, not JS validation)', () => {
    // credentialErrors() only flags non-empty malformed values. Empty fields rely on
    // browser-native required attribute validation (not tested in jsdom).
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial: EMPTY_INITIAL })));
    try {
      assert.ok(
        !query('button[type="submit"]').disabled,
        'submit is enabled for an empty form — JS validation only fires for malformed, non-empty values',
      );
    } finally {
      cleanup();
    }
  });

  test('Connect button is enabled when all required fields are validly filled', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(!query('button[type="submit"]').disabled, 'submit must be enabled when all required fields are filled');
    } finally {
      cleanup();
    }
  });

  test('shows a bucket field error when bucket contains spaces', () => {
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
        }),
      ),
    );
    try {
      const bucketError = query('.field-error');
      assert.ok(bucketError, 'a .field-error element must appear for a bucket with spaces');
      assert.ok(
        bucketError.textContent.toLowerCase().includes('space') ||
          bucketError.textContent.toLowerCase().includes('bucket'),
      );
    } finally {
      cleanup();
    }
  });

  test('Connect button is disabled when bucket contains a space', () => {
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
        }),
      ),
    );
    try {
      assert.ok(query('button[type="submit"]').disabled, 'submit must be disabled when bucket has spaces');
    } finally {
      cleanup();
    }
  });

  test('shows a keyId error when keyId contains spaces', () => {
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, keyId: 'AK ID 123' },
        }),
      ),
    );
    try {
      const err = query('.field-error');
      assert.ok(err, 'a field-error must appear for a keyId with spaces');
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — provider auto-detection', () => {
  test('shows "Detected: Backblaze B2" hint when a B2 endpoint is pre-filled', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(
        text().includes('Detected') && (text().includes('Backblaze') || text().includes('B2')),
        'provider detection hint must appear for a known B2 endpoint',
      );
    } finally {
      cleanup();
    }
  });

  test('typing a B2 endpoint shows the B2 detection hint', () => {
    const { query, text, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const endpointInput = query('#cred-endpoint');
      assert.ok(endpointInput, '#cred-endpoint input must be present');
      setInput(endpointInput, 'https://s3.us-west-002.backblazeb2.com');
      assert.ok(
        text().includes('Detected') || text().includes('Backblaze') || text().includes('B2'),
        'provider detection hint must appear after typing a B2 endpoint',
      );
    } finally {
      cleanup();
    }
  });

  test('shows the B2 master-key warning when B2 is the detected provider', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(
        text().includes('B2') && text().toLowerCase().includes('master'),
        'B2 master key warning must appear when B2 is detected',
      );
    } finally {
      cleanup();
    }
  });

  test('auto-fills the region when a B2 endpoint with an embedded region is entered', () => {
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...EMPTY_INITIAL, endpoint: 'https://s3.us-west-002.backblazeb2.com' },
        }),
      ),
    );
    try {
      const regionInput = query('#cred-region');
      assert.ok(regionInput, '#cred-region input must be present');
      assert.ok(
        regionInput.value.includes('us-west-002'),
        'region must be auto-filled from a B2 endpoint that embeds the region',
      );
    } finally {
      cleanup();
    }
  });

  test('shows "Auto-filled from endpoint URL" hint when region is inferred', () => {
    const { text, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...EMPTY_INITIAL, endpoint: 'https://s3.us-east-1.wasabisys.com' },
        }),
      ),
    );
    try {
      assert.ok(
        text().includes('Auto-filled from endpoint'),
        '"Auto-filled from endpoint URL" hint must appear when region is inferred from the endpoint',
      );
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — form submission', () => {
  test('calls onSave when submitted with a valid form', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: B2_INITIAL,
          onSave: (data) => {
            saved = data;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(saved, 'onSave must be called on submit');
    } finally {
      cleanup();
    }
  });

  test('calls onSave with trimmed endpoint (no trailing slash)', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, endpoint: 'https://s3.us-west-002.backblazeb2.com/' },
          onSave: (data) => {
            saved = data;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(saved, 'onSave must be called');
      assert.ok(!saved.endpoint.endsWith('/'), 'trailing slash must be stripped from the endpoint');
    } finally {
      cleanup();
    }
  });

  test('calls onSave with the correct bucket and keyId', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: B2_INITIAL,
          onSave: (data) => {
            saved = data;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.equal(saved.bucket, 'my-bucket');
      assert.equal(saved.keyId, 'keyabc');
    } finally {
      cleanup();
    }
  });

  test('does NOT call onSave when the form has JS validation errors (spaces in bucket)', () => {
    let saveCalled = false;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, bucket: INVALID_BUCKET },
          onSave: () => {
            saveCalled = true;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!saveCalled, 'onSave must not be called when the form has JS validation errors');
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — base folder field (#60)', () => {
  test('renders the optional Base folder input', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const input = query('#cred-baseprefix');
      assert.ok(input, 'base folder input must be present');
      assert.ok(!input.required, 'base folder must not be required');
      assert.equal(input.placeholder, 'photos/2024/');
    } finally {
      cleanup();
    }
  });

  test('shows the leave-blank hint', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      assert.ok(text().includes('leave blank for full bucket access'));
    } finally {
      cleanup();
    }
  });

  test('shows a field error and blocks submit when the value contains ".."', () => {
    let saveCalled = false;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, basePrefix: 'team/../other/' },
          onSave: () => {
            saveCalled = true;
          },
        }),
      ),
    );
    try {
      assert.ok(query('.field-error'), 'a field error must render for a ".." base folder');
      fire(query('button[type="submit"]'), 'click');
      assert.ok(!saveCalled, 'onSave must not fire while base folder is invalid');
    } finally {
      cleanup();
    }
  });

  test('submit passes the normalized base folder (trailing slash appended)', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: { ...B2_INITIAL, basePrefix: 'team/alice' },
          onSave: (data) => {
            saved = data;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.equal(saved.basePrefix, 'team/alice/');
    } finally {
      cleanup();
    }
  });

  test('submit passes empty basePrefix for an unscoped connection', () => {
    let saved = null;
    const { query, cleanup } = mount(
      h(
        CredentialForm,
        defaultProps({
          initial: B2_INITIAL,
          onSave: (data) => {
            saved = data;
          },
        }),
      ),
    );
    try {
      fire(query('button[type="submit"]'), 'click');
      assert.equal(saved.basePrefix, '');
    } finally {
      cleanup();
    }
  });

  test('the key-hygiene warning points Name-Prefix keys at the Base folder field', () => {
    const { text, cleanup } = mount(h(CredentialForm, defaultProps({ initial: B2_INITIAL })));
    try {
      assert.ok(text().includes('Name Prefix'), 'warning line must bridge B2 Name Prefix vocabulary');
    } finally {
      cleanup();
    }
  });
});

describe('CredentialForm — autofocus secret', () => {
  test('focuses the Secret Key field on mount when autoFocusSecret is set', async () => {
    const initial = {
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      keyId: 'AKID',
      secretKey: '',
      provider: null,
      regionOverride: '',
    };
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ initial, autoFocusSecret: true })));
    try {
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(document.activeElement, query('#cred-secretkey'), 'secret field must be focused');
    } finally {
      cleanup();
    }
  });

  test('does NOT focus the Secret Key field when autoFocusSecret is falsy', async () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      await new Promise((r) => setTimeout(r, 0));
      assert.notEqual(document.activeElement, query('#cred-secretkey'), 'secret field must not be auto-focused');
    } finally {
      cleanup();
    }
  });
});

// Accounts A (v1.66.0): suggestions from this device + catalog (C2), key-ID recall (C3), and the
// rarely-needed fields behind "More options".
describe('CredentialForm — accounts A', () => {
  const SAVED = [
    {
      id: 1,
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      bucket: 'family-photos',
      provider: 'b2',
      lastUsedAt: 20,
    },
    {
      id: 2,
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      bucket: 'household-docs',
      provider: 'b2',
      lastUsedAt: 10,
    },
  ];
  const RECALL = (keyId) =>
    keyId === 'K004abc'
      ? {
          endpoint: 'https://s3.us-west-004.backblazeb2.com',
          provider: 'b2',
          regionOverride: 'us-west-004',
          bucket: 'family-photos',
          basePrefix: '',
          buckets: ['family-photos', 'household-docs'],
        }
      : null;

  test('the endpoint suggests this device first, then the catalog; browser autocomplete is not switched off', () => {
    const { query, queryAll, cleanup } = mount(h(CredentialForm, defaultProps({ savedConnections: SAVED })));
    try {
      const input = query('#cred-endpoint');
      assert.equal(input.getAttribute('list'), 'cred-endpoint-options');
      assert.notEqual(input.getAttribute('autocomplete'), 'off');
      const values = queryAll('#cred-endpoint-options option').map((o) => o.value);
      assert.equal(values[0], 'https://s3.us-west-004.backblazeb2.com');
      assert.ok(values.includes('https://s3.eu-central-2.wasabisys.com'), 'catalog rows follow');
    } finally {
      cleanup();
    }
  });

  test('the bucket suggests buckets used on the typed endpoint', () => {
    const { query, queryAll, cleanup } = mount(h(CredentialForm, defaultProps({ savedConnections: SAVED })));
    try {
      setInput(query('#cred-endpoint'), 'https://s3.us-west-004.backblazeb2.com');
      assert.deepEqual(
        queryAll('#cred-bucket-options option').map((o) => o.value),
        ['family-photos', 'household-docs'],
      );
    } finally {
      cleanup();
    }
  });

  test('a known key ID fills an empty endpoint and bucket and says so', () => {
    let last;
    const { query, text, cleanup } = mount(
      h(CredentialForm, defaultProps({ recall: RECALL, onFormChange: (f) => (last = f) })),
    );
    try {
      setInput(query('#cred-keyid'), 'K004abc');
      assert.equal(query('#cred-endpoint').value, 'https://s3.us-west-004.backblazeb2.com');
      assert.equal(query('#cred-bucket').value, 'family-photos');
      assert.equal(query('#cred-region').value, 'us-west-004');
      assert.equal(last.bucket, 'family-photos', 'the parent sees the recalled values');
      assert.ok(text().includes("You've used this key before"));
    } finally {
      cleanup();
    }
  });

  test('recall never overwrites what the user already typed', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps({ recall: RECALL })));
    try {
      setInput(query('#cred-endpoint'), 'https://minio.home.test:9000');
      setInput(query('#cred-bucket'), 'mine');
      setInput(query('#cred-keyid'), 'K004abc');
      assert.equal(query('#cred-endpoint').value, 'https://minio.home.test:9000');
      assert.equal(query('#cred-bucket').value, 'mine');
    } finally {
      cleanup();
    }
  });

  test('base folder, provider and region sit in "More options", closed when all are default', () => {
    const { query, cleanup } = mount(h(CredentialForm, defaultProps()));
    try {
      const d = query('details.more-options');
      assert.ok(d, 'a More options disclosure exists');
      assert.equal(d.open, false);
      for (const id of ['#cred-baseprefix', '#cred-provider', '#cred-region']) assert.ok(d.querySelector(id), id);
      assert.ok(d.querySelector('summary').textContent.includes('folder: none'));
    } finally {
      cleanup();
    }
  });

  test('"More options" starts open when a base folder or a provider override is set', () => {
    const a = mount(h(CredentialForm, defaultProps({ initial: { ...EMPTY_INITIAL, basePrefix: 'videos/' } })));
    const b = mount(
      h(
        CredentialForm,
        defaultProps({ initial: { ...EMPTY_INITIAL, endpoint: 'https://nas.test', provider: 'minio' } }),
      ),
    );
    try {
      assert.equal(a.query('details.more-options').open, true);
      assert.equal(b.query('details.more-options').open, true);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
