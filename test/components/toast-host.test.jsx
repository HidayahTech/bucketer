import '../helpers/with-dom.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'preact/test-utils';
import { mount, fire } from '../helpers/render.js';
import { ToastHost } from '../../src/components/ToastHost.jsx';
import { toastStore, showToast } from '../../src/lib/toast.js';

function clearToasts() { toastStore.get().slice().forEach(t => toastStore.dismiss(t.id)); }

describe('ToastHost (#15)', () => {
  beforeEach(clearToasts);

  test('renders no toast items when empty', () => {
    const { query, cleanup } = mount(<ToastHost />);
    assert.equal(query('.toast'), null);
    cleanup();
  });

  test('exposes an aria-live region (present before any toast, so additions are announced)', () => {
    const { query, cleanup } = mount(<ToastHost />);
    const host = query('.toast-host');
    assert.ok(host, 'toast-host container must always be present');
    assert.equal(host.getAttribute('aria-live'), 'polite');
    cleanup();
  });

  test('renders a toast pushed via showToast', () => {
    const { text, cleanup } = mount(<ToastHost />);
    act(() => { showToast('Renamed to "x"', { duration: 0 }); });
    assert.ok(text().includes('Renamed to "x"'));
    cleanup();
  });

  test('clicking a toast dismisses it', () => {
    const { query, cleanup } = mount(<ToastHost />);
    act(() => { showToast('Deleted 2 items', { duration: 0 }); });
    const toast = query('.toast');
    assert.ok(toast);
    fire(toast, 'click');
    assert.equal(query('.toast'), null);
    cleanup();
  });
});
