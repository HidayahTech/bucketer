// Component tests for ErrorBlock.
// Requires the JSX loader: run via `npm run test:ui`, not `npm test`.
import '../helpers/with-dom.js';       // must be first — installs DOM globals
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
    const { text, cleanup } = mount(h(ErrorBlock, {
      error: new Error('oops'),
      consequence: 'Files may not have uploaded.',
    }));
    assert.ok(text().includes('Files may not have uploaded.'));
    cleanup();
  });

  test('renders guidance text when provided', () => {
    const { text, cleanup } = mount(h(ErrorBlock, {
      error: new Error('oops'),
      guidance: 'Check your key has GetObject permission.',
    }));
    assert.ok(text().includes('Check your key has GetObject permission.'));
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
    const s3Error = Object.assign(new Error('Access Denied'), { Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const { query, cleanup } = mount(h(ErrorBlock, { error: s3Error }));
    assert.ok(query('details'), 'should render a details element for S3 errors with metadata');
    cleanup();
  });

  test('no diagnostics button without the diagnostics prop', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, { error: new Error('Failed to fetch') }));
    assert.ok(!queryAll('button').some(b => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('no diagnostics button for non-CORS-like errors even with the prop', () => {
    const s3Error = Object.assign(new Error('Access Denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const { queryAll, cleanup } = mount(h(ErrorBlock, {
      error: s3Error,
      diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
    }));
    assert.ok(!queryAll('button').some(b => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('diagnostics button renders for CORS-like errors with the prop', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, {
      error: new Error('Failed to fetch'),
      diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
    }));
    const btn = queryAll('button').find(b => b.textContent.includes('Run diagnostics'));
    assert.ok(btn, 'button should be present');
    assert.equal(btn.getAttribute('type'), 'button');
    cleanup();
  });

  test('clicking the button runs diagnostics and shows the verdict', async () => {
    const { queryAll, text, cleanup } = mount(h(ErrorBlock, {
      error: new Error('Failed to fetch'),
      diagnostics: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        forcePathStyle: false,
        pageProtocol: 'https:',
        onLine: true,
        fetchFn: async () => ({ type: 'opaque' }),
      },
    }));
    const btn = queryAll('button').find(b => b.textContent.includes('Run diagnostics'));
    fire(btn, 'click');
    // flush the async runDiagnostics → setState round-trips
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    assert.ok(text().includes('almost certainly missing or incorrect CORS'),
      'cors-blocked verdict should be shown');
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
    const { queryAll, text, container, cleanup } = mount(h(ErrorBlock, {
      error: new Error('Failed to fetch'),
      diagnostics,
    }));
    fire(queryAll('button').find(b => b.textContent.includes('Run diagnostics')), 'click');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    assert.ok(text().includes('Browser is online'), 'precondition: results are showing');

    act(() => render(h(ErrorBlock, {
      error: new Error('NetworkError when attempting to fetch resource.'),
      diagnostics,
    }), container));

    assert.ok(!text().includes('Browser is online'), 'old check list must be cleared for the new error');
    assert.ok(queryAll('button').some(b => b.textContent.includes('Run diagnostics')),
      'Run diagnostics button must return for the new error');
    cleanup();
  });
});
