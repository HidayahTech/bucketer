import '../helpers/with-dom.js';
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { mount } from '../helpers/render.js';
import { useRate } from '../../src/hooks/useRate.js';

const MB = 1024 * 1024;

function Probe({ bytes, active }) {
  const speed = useRate(bytes, active);
  return <span data-testid="speed">{speed == null ? 'null' : String(Math.round(speed / MB))}</span>;
}

describe('useRate', () => {
  test('returns a bytes/second rate once samples span the minimum, null when inactive', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    let m;
    try {
      m = mount(<Probe bytes={0} active={true} />);               // mount tick samples (0, 0)
      assert.equal(m.query('[data-testid=speed]').textContent, 'null');
      // Preact batches the re-render triggered by the interval's setSpeed() via a
      // microtask outside of act(); mock.timers.tick() runs the interval callback
      // synchronously but does not itself flush that microtask, so each tick must be
      // wrapped in act() to force the DOM update before the next assertion.
      act(() => mock.timers.tick(250));                           // t=250, sample (250, 0)
      // Re-render into the same container with bumped bytes (mount() has no update
      // method itself; this mirrors the same-container re-render used in
      // error-block.test.jsx's "diagnostics results reset" test).
      act(() => render(<Probe bytes={5 * MB} active={true} />, m.container));
      act(() => mock.timers.tick(250));                           // t=500, sample (500, 5 MiB) → span 500
      act(() => mock.timers.tick(250));                           // t=750, sample (750, 5 MiB)
      const shown = Number(m.query('[data-testid=speed]').textContent);
      assert.ok(shown >= 6 && shown <= 7, `~6.7 MiB/s expected, got ${shown}`); // 5 MiB / 0.75 s
      act(() => render(<Probe bytes={5 * MB} active={false} />, m.container)); // deactivate
      assert.equal(m.query('[data-testid=speed]').textContent, 'null');
    } finally {
      mock.timers.reset();
      m?.cleanup?.();
    }
  });
});
