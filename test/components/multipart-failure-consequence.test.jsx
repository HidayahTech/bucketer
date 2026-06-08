// Tests for MultipartFailureConsequence.
// The provider-specific message is the only user-facing signal telling the user
// whether orphaned S3 parts will auto-expire or accrue charges indefinitely.
// If the wrong message shows for the wrong provider, a user could ignore
// a B2 billing issue or needlessly panic about R2.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount } from '../helpers/render.js';
import { MultipartFailureConsequence } from '../../src/components/MultipartFailureConsequence.jsx';

describe('MultipartFailureConsequence — R2', () => {
  test('shows the 7-day auto-expiry message', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'r2' }));
    assert.ok(text().includes('7 days'), 'R2 message must mention the 7-day auto-abort window');
    cleanup();
  });

  test('tells the user no manual cleanup is needed', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'r2' }));
    assert.ok(text().toLowerCase().includes('no manual cleanup'), 'R2 message must say no manual cleanup needed');
    cleanup();
  });

  test('does NOT mention storage charges (R2 auto-expires)', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'r2' }));
    assert.ok(!text().toLowerCase().includes('charges'), 'R2 message must not mention storage charges');
    cleanup();
  });
});

describe('MultipartFailureConsequence — B2', () => {
  test('warns about ongoing storage charges', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'b2' }));
    assert.ok(text().toLowerCase().includes('charges'), 'B2 message must warn about accruing storage charges');
    cleanup();
  });

  test('directs user to the B2 console or CLI', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'b2' }));
    assert.ok(
      text().toLowerCase().includes('console') || text().toLowerCase().includes('cli'),
      'B2 message must tell the user to use the B2 console or CLI to clean up'
    );
    cleanup();
  });

  test('does NOT show the R2 auto-expiry message for B2', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'b2' }));
    assert.ok(!text().includes('7 days'), 'B2 must not show the R2 7-day auto-expiry message');
    cleanup();
  });
});

describe('MultipartFailureConsequence — generic (non-B2, non-R2)', () => {
  test('tells user to check the provider\'s console', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'wasabi' }));
    assert.ok(text().toLowerCase().includes("provider"), 'generic message must mention checking the provider');
    cleanup();
  });

  test('does NOT show R2 auto-expiry message for generic providers', () => {
    const { text, cleanup } = mount(h(MultipartFailureConsequence, { provider: 'wasabi' }));
    assert.ok(!text().includes('7 days') && !text().includes('no manual cleanup'));
    cleanup();
  });

  test('renders the same generic message for unknown providers', () => {
    const { text: t1, cleanup: c1 } = mount(h(MultipartFailureConsequence, { provider: 'minio' }));
    const { text: t2, cleanup: c2 } = mount(h(MultipartFailureConsequence, { provider: 'generic' }));
    // Both should produce the generic message (not B2 or R2 specific)
    assert.ok(!t1().includes('7 days') && !t1().toLowerCase().includes('b2:'));
    assert.ok(!t2().includes('7 days') && !t2().toLowerCase().includes('b2:'));
    c1(); c2();
  });
});
