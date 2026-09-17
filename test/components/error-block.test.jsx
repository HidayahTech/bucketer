// Component tests for ErrorBlock.
// Requires the JSX loader: run via `npm run test:ui`, not `npm test`.
import '../helpers/with-dom.js'; // must be first — installs DOM globals
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { mount, fire } from '../helpers/render.js';
import { ErrorBlock } from '../../src/components/ErrorBlock.jsx';

describe('ErrorBlock', () => {
  test('renders nothing when error is falsy', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: null }));
    assert.equal(query('.error-block'), null);
    cleanup();
  });

  test('renders an error-block element when error is provided', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: new Error('Something went wrong') }));
    assert.ok(query('.error-block'), 'error-block element should be present');
    assert.equal(query('.error-block').getAttribute('role'), 'alert');
    cleanup();
  });

  test('shows default title "Error" when no title prop is given', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: new Error('oops') }));
    assert.ok(query('.error-title').textContent.includes('Error'));
    cleanup();
  });

  test('shows custom title when title prop is provided', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: new Error('oops'), title: 'Download failed' }));
    assert.ok(query('.error-title').textContent.includes('Download failed'));
    cleanup();
  });

  test('renders the error message', () => {
    const { text, cleanup } = mount(h(ErrorBlock, { error: new Error('Access denied') }));
    assert.ok(text().includes('Access denied'));
    cleanup();
  });

  test('accepts a plain string as error', () => {
    const { text, cleanup } = mount(h(ErrorBlock, { error: 'Network error' }));
    assert.ok(text().includes('Network error'));
    cleanup();
  });

  test('renders consequence text when provided', () => {
    const { text, cleanup } = mount(
      h(ErrorBlock, {
        error: new Error('oops'),
        consequence: 'Files may not have uploaded.',
      }),
    );
    assert.ok(text().includes('Files may not have uploaded.'));
    cleanup();
  });

  test('renders guidance text when provided', () => {
    const { text, cleanup } = mount(
      h(ErrorBlock, {
        error: new Error('oops'),
        guidance: 'Check your key has GetObject permission.',
      }),
    );
    assert.ok(text().includes('Check your key has GetObject permission.'));
    cleanup();
  });

  // Prefix-scoped keys (#60): a denied connection with no Base folder set gets a
  // recovery hint naming the field. Gated on basePrefixUnset so the hint never
  // shows once a base folder exists (the restriction is already declared).
  test('shows the Base folder hint on a 403 when no base folder is set', () => {
    const denied = {
      name: 'AccessDenied',
      Code: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    };
    const { text, cleanup } = mount(h(ErrorBlock, { error: denied, basePrefixUnset: true }));
    assert.ok(text().includes('Base folder'), 'the hint must name the field');
    assert.ok(text().includes('Name Prefix'), 'the hint must bridge B2 vocabulary');
    cleanup();
  });

  test('no Base folder hint when a base folder is already set', () => {
    const denied = {
      name: 'AccessDenied',
      Code: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    };
    const { text, cleanup } = mount(h(ErrorBlock, { error: denied }));
    assert.ok(!text().includes('Base folder'));
    cleanup();
  });

  test('no Base folder hint on a non-permission error', () => {
    const notFound = {
      name: 'NoSuchBucket',
      Code: 'NoSuchBucket',
      message: 'not here',
      $metadata: { httpStatusCode: 404 },
    };
    const { text, cleanup } = mount(h(ErrorBlock, { error: notFound, basePrefixUnset: true }));
    assert.ok(!text().includes('Base folder'));
    cleanup();
  });

  // #65: on the CORS-masked shape the folder-restriction cause is its own ranked block,
  // not a sentence appended to the CORS paragraph, and the generic CORS note is not
  // repeated beneath it (the block already says both causes and the curl escape hatch).
  test('a CORS-masked failure with no base folder gets the two-cause block, not the generic CORS note', () => {
    const { text, query, cleanup } = mount(
      h(ErrorBlock, { error: new Error('Failed to fetch'), basePrefixUnset: true, onSetBaseFolder: () => {} }),
    );
    assert.ok(query('.scope-hint'), 'the scope hint block must render');
    assert.ok(text().includes('limited to a folder'), 'names the folder-restriction cause');
    assert.ok(text().includes('CORS rules'), 'names the CORS cause too');
    assert.ok(!text().includes('This may be a CORS error'), 'the generic CORS note must not be repeated');
    cleanup();
  });

  const denied403 = () => ({
    name: 'AccessDenied',
    Code: 'AccessDenied',
    message: 'Access Denied',
    $metadata: { httpStatusCode: 403 },
  });

  test('#65: the scope hint renders before any CORS text and carries a Set base folder button', () => {
    let clicked = 0;
    const { query, queryAll, cleanup } = mount(
      h(ErrorBlock, { error: denied403(), basePrefixUnset: true, onSetBaseFolder: () => clicked++ }),
    );
    const btn = queryAll('button').find((b) => b.textContent.includes('Set base folder'));
    assert.ok(btn, 'the action button must be present');
    assert.equal(btn.getAttribute('type'), 'button');
    assert.ok(query('.scope-hint').contains(btn), 'the button lives inside the hint block');
    fire(btn, 'click');
    assert.equal(clicked, 1, 'clicking invokes the call site action');
    cleanup();
  });

  test('#65: no Set base folder button without the action callback (in-session blocks)', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, { error: denied403(), basePrefixUnset: true }));
    assert.ok(!queryAll('button').some((b) => b.textContent.includes('Set base folder')));
    cleanup();
  });

  test('#65: a readable 403 shows no CORS text at all', () => {
    const { text, cleanup } = mount(h(ErrorBlock, { error: denied403(), basePrefixUnset: true }));
    assert.ok(!text().includes('CORS'), 'a parsed HTTP response proves CORS is fine');
    cleanup();
  });

  for (const code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId']) {
    test(`#65: no scope hint on ${code} even with no base folder — a base folder cannot fix a bad credential`, () => {
      const bad = { name: code, Code: code, message: 'nope', $metadata: { httpStatusCode: 403 } };
      const { text, query, cleanup } = mount(
        h(ErrorBlock, { error: bad, basePrefixUnset: true, onSetBaseFolder: () => {} }),
      );
      assert.equal(query('.scope-hint'), null, 'no hint block');
      assert.ok(!text().includes('Base folder'), 'the field is not named');
      assert.ok(text().includes('key ID or secret key is wrong'), 'the plain cause is stated instead');
      cleanup();
    });
  }

  for (const code of ['RequestTimeTooSkewed', 'ExpiredToken', 'AllAccessDisabled']) {
    test(`#65: no scope hint and no bad-credential claim on ${code} (diff review S-4)`, () => {
      const err = { name: code, Code: code, message: 'provider says so', $metadata: { httpStatusCode: 403 } };
      const { text, query, cleanup } = mount(
        h(ErrorBlock, { error: err, basePrefixUnset: true, onSetBaseFolder: () => {} }),
      );
      assert.equal(query('.scope-hint'), null);
      assert.ok(!text().includes('Base folder'));
      assert.ok(!text().includes('key ID or secret key is wrong'), 'the provider message is the explanation');
      assert.ok(text().includes('provider says so'));
      cleanup();
    });
  }

  test('#65: a floor that is set yet denied gets the set-but-denied variant naming the floor', () => {
    const { text, query, cleanup } = mount(
      h(ErrorBlock, { error: denied403(), basePrefix: 'team/alice/', onSetBaseFolder: () => {} }),
    );
    assert.ok(query('.scope-hint'), 'the block renders');
    assert.ok(text().includes('team/alice/'), 'names the current floor');
    assert.ok(text().includes('correct the Base folder'), 'asks for a correction, not a first entry');
    cleanup();
  });

  test('#65: the set-but-denied variant never renders for in-session blocks (no action callback)', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: denied403(), basePrefix: 'team/alice/' }));
    assert.equal(query('.scope-hint'), null);
    cleanup();
  });

  test('#65: focusOnMount makes the block focusable and focuses it on a new error', () => {
    const { query, container, cleanup } = mount(h(ErrorBlock, { error: denied403(), focusOnMount: true }));
    const block = query('.error-block');
    assert.equal(block.getAttribute('tabindex'), '-1');
    assert.equal(document.activeElement, block, 'focus moved to the alert on mount');
    document.body.focus();
    act(() => render(h(ErrorBlock, { error: new Error('second'), focusOnMount: true }), container));
    assert.equal(document.activeElement, query('.error-block'), 'a new error re-focuses the alert');
    cleanup();
  });

  test('#65: without focusOnMount the block is not focusable and focus stays put', () => {
    const { query, cleanup } = mount(h(ErrorBlock, { error: denied403() }));
    assert.equal(query('.error-block').getAttribute('tabindex'), null);
    assert.notEqual(document.activeElement, query('.error-block'));
    cleanup();
  });

  test('shows CORS note for fetch/network errors', () => {
    const { text, cleanup } = mount(h(ErrorBlock, { error: new Error('Failed to fetch') }));
    assert.ok(text().includes('CORS'), 'should show CORS note for fetch errors');
    cleanup();
  });

  test('does not show CORS note for S3 errors with an HTTP status code', () => {
    // parseS3Error returns status:null for plain Error objects (no $metadata),
    // which also triggers the CORS heuristic. Use a proper S3 error with a known
    // HTTP status to exercise the non-CORS path.
    const s3Error = Object.assign(new Error('Access Denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'req-abc' },
    });
    const { text, cleanup } = mount(h(ErrorBlock, { error: s3Error }));
    assert.ok(!text().includes('CORS'), 'should not show CORS note for errors with a concrete HTTP status');
    cleanup();
  });

  test('renders provider response details section for S3 errors with a code', () => {
    const s3Error = Object.assign(new Error('Access Denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const { query, cleanup } = mount(h(ErrorBlock, { error: s3Error }));
    assert.ok(query('details'), 'should render a details element for S3 errors with metadata');
    cleanup();
  });

  test('no diagnostics button without the diagnostics prop', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, { error: new Error('Failed to fetch') }));
    assert.ok(!queryAll('button').some((b) => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('no diagnostics button for non-CORS-like errors even with the prop', () => {
    const s3Error = Object.assign(new Error('Access Denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const { queryAll, cleanup } = mount(
      h(ErrorBlock, {
        error: s3Error,
        diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
      }),
    );
    assert.ok(!queryAll('button').some((b) => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('diagnostics button renders for CORS-like errors with the prop', () => {
    const { queryAll, cleanup } = mount(
      h(ErrorBlock, {
        error: new Error('Failed to fetch'),
        diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
      }),
    );
    const btn = queryAll('button').find((b) => b.textContent.includes('Run diagnostics'));
    assert.ok(btn, 'button should be present');
    assert.equal(btn.getAttribute('type'), 'button');
    cleanup();
  });

  test('clicking the button runs diagnostics and shows the verdict', async () => {
    const { queryAll, text, cleanup } = mount(
      h(ErrorBlock, {
        error: new Error('Failed to fetch'),
        diagnostics: {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          forcePathStyle: false,
          pageProtocol: 'https:',
          onLine: true,
          fetchFn: async () => ({ type: 'opaque' }),
        },
      }),
    );
    const btn = queryAll('button').find((b) => b.textContent.includes('Run diagnostics'));
    fire(btn, 'click');
    // flush the async runDiagnostics → setState round-trips
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(text().includes('almost certainly missing or incorrect CORS'), 'cors-blocked verdict should be shown');
    assert.ok(text().includes('Endpoint host responds'), 'check list should be shown');
    cleanup();
  });

  // #51: diag state must reset when a different error lands in the same mounted
  // block — otherwise stale results render with no way to re-run diagnostics.
  test('diagnostics results reset when the error changes (#51)', async () => {
    const diagnostics = {
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      forcePathStyle: false,
      pageProtocol: 'https:',
      onLine: true,
      fetchFn: async () => ({ type: 'opaque' }),
    };
    const { queryAll, text, container, cleanup } = mount(
      h(ErrorBlock, {
        error: new Error('Failed to fetch'),
        diagnostics,
      }),
    );
    fire(
      queryAll('button').find((b) => b.textContent.includes('Run diagnostics')),
      'click',
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(text().includes('Browser is online'), 'precondition: results are showing');

    act(() =>
      render(
        h(ErrorBlock, {
          error: new Error('NetworkError when attempting to fetch resource.'),
          diagnostics,
        }),
        container,
      ),
    );

    assert.ok(!text().includes('Browser is online'), 'old check list must be cleared for the new error');
    assert.ok(
      queryAll('button').some((b) => b.textContent.includes('Run diagnostics')),
      'Run diagnostics button must return for the new error',
    );
    cleanup();
  });
});
