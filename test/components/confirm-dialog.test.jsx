import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mount, fire } from '../helpers/render.js';
import { ConfirmDialog } from '../../src/components/ConfirmDialog.jsx';

function makeController(overrides = {}) {
  const calls = { setConfirm: [], act: [] };
  const controller = {
    confirmAction: null,
    cleared: null,
    setConfirm: (v) => { calls.setConfirm.push(v); },
    act:        (v) => { calls.act.push(v); },
    ...overrides,
  };
  return { controller, calls };
}

describe('ConfirmDialog', () => {
  describe('idle state (confirmAction !== id)', () => {
    test('renders only the trigger button with the label', () => {
      const { controller } = makeController();
      const { queryAll, query, cleanup } = mount(
        <ConfirmDialog id="credentials" label="Clear connection" controller={controller} />
      );
      const buttons = queryAll('button');
      assert.equal(buttons.length, 1, 'idle state must render exactly one button');
      assert.equal(buttons[0].textContent, 'Clear connection');
      assert.equal(query('.sv-confirm-warn'), null, 'no warning text in idle state');
      assert.equal(query('.sv-cleared-msg'), null, 'no cleared message when not just-cleared');
      cleanup();
    });

    test('clicking the trigger calls setConfirm(id)', () => {
      const { controller, calls } = makeController();
      const { query, cleanup } = mount(
        <ConfirmDialog id="resume" label="Discard" controller={controller} />
      );
      fire(query('button'), 'click');
      assert.deepEqual(calls.setConfirm, ['resume']);
      assert.deepEqual(calls.act, []);
      cleanup();
    });
  });

  describe('pending state (confirmAction === id)', () => {
    test('renders Cancel + confirm buttons; clicking confirm calls act(id)', () => {
      const { controller, calls } = makeController({ confirmAction: 'log' });
      const { queryAll, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      const buttons = queryAll('button');
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].textContent, 'Cancel');
      assert.equal(buttons[1].textContent, 'Clear history');
      fire(buttons[1], 'click');
      assert.deepEqual(calls.act, ['log']);
      cleanup();
    });

    test('clicking Cancel calls setConfirm(null)', () => {
      const { controller, calls } = makeController({ confirmAction: 'log' });
      const { queryAll, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      fire(queryAll('button')[0], 'click');
      assert.deepEqual(calls.setConfirm, [null]);
      cleanup();
    });

    test('explicit warning prop is rendered', () => {
      const { controller } = makeController({ confirmAction: 'profiles' });
      const { query, cleanup } = mount(
        <ConfirmDialog id="profiles" label="Delete all"
          warning="Everything will be removed." controller={controller} />
      );
      const warn = query('.sv-confirm-warn');
      assert.ok(warn, 'warning span must render');
      assert.equal(warn.textContent, 'Everything will be removed.');
      cleanup();
    });

    test('reload=true with no warning falls back to "This will reload the page."', () => {
      const { controller } = makeController({ confirmAction: 'credentials' });
      const { query, cleanup } = mount(
        <ConfirmDialog id="credentials" label="Clear" reload controller={controller} />
      );
      assert.equal(query('.sv-confirm-warn').textContent, 'This will reload the page.');
      cleanup();
    });

    test('no warning and reload=false: no warning span renders', () => {
      const { controller } = makeController({ confirmAction: 'log' });
      const { query, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      assert.equal(query('.sv-confirm-warn'), null);
      cleanup();
    });

    test('danger=true applies btn-danger class to the confirm button', () => {
      const { controller } = makeController({ confirmAction: 'profiles' });
      const { queryAll, cleanup } = mount(
        <ConfirmDialog id="profiles" label="Delete all" danger controller={controller} />
      );
      const confirmBtn = queryAll('button')[1];
      assert.ok(confirmBtn.className.includes('btn-danger'));
      cleanup();
    });

    test('danger=false (default): confirm button gets btn-ghost, not btn-danger', () => {
      const { controller } = makeController({ confirmAction: 'log' });
      const { queryAll, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      const confirmBtn = queryAll('button')[1];
      assert.ok(confirmBtn.className.includes('btn-ghost'));
      assert.ok(!confirmBtn.className.includes('btn-danger'));
      cleanup();
    });
  });

  describe('cleared flash (cleared === id and not pending)', () => {
    test('renders "✓ Cleared" message alongside the trigger button', () => {
      const { controller } = makeController({ cleared: 'log' });
      const { query, queryAll, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      const msg = query('.sv-cleared-msg');
      assert.ok(msg, 'cleared message must render');
      assert.match(msg.textContent, /Cleared/);
      assert.equal(queryAll('button').length, 1, 'still in idle button state');
      cleanup();
    });

    test('cleared message is suppressed while the same id is pending', () => {
      const { controller } = makeController({ confirmAction: 'log', cleared: 'log' });
      const { query, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      assert.equal(query('.sv-cleared-msg'), null);
      cleanup();
    });

    test('cleared message only appears for matching id', () => {
      const { controller } = makeController({ cleared: 'profiles' });
      const { query, cleanup } = mount(
        <ConfirmDialog id="log" label="Clear history" controller={controller} />
      );
      assert.equal(query('.sv-cleared-msg'), null);
      cleanup();
    });
  });
});
