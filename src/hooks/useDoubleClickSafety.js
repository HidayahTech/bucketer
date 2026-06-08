// Copyright (C) 2026 HidayahTech, LLC
// "Confirm on second click" safety pattern for destructive actions.
//
// WHY THIS FILE EXISTS: the "prime for 3 seconds, confirm on second click" pattern
// was duplicated between handleCancelAllClick (UploadQueue.jsx) and
// handleCancelBatchClick (BatchSummary in UploadQueue.jsx). Each duplicate had its
// own state vars, timer ref, and state-machine logic. Extracting the logic here
// means it is tested once and used consistently.
//
// WHAT BELONGS HERE: the applyClickSafety() pure function (tested independently)
// and the useDoubleClickSafety() hook that wires it to Preact state and real timers.
//
// WHAT DOES NOT BELONG HERE: any S3 operations, storage calls, or business logic.
// This hook knows nothing about uploads — it only manages a two-step click flow.

import { useState, useRef } from 'preact/hooks';

// Pure state-machine function — exported for unit testing without a DOM/Preact environment.
// Encodes the two-step click transition:
//   1st click (primed=false): set primed, schedule a reset via scheduleFn
//   2nd click (primed=true):  cancel the timer, reset primed, call onConfirm
//
// clearFn and scheduleFn are injected so the logic can be tested with simple spies
// instead of real timers (which would require mock.timers, only available in Node 20+).
export function applyClickSafety(primed, onConfirm, setPrimed, clearFn, scheduleFn) {
  if (!primed) {
    setPrimed(true);
    clearFn();                              // cancel any previous pending reset
    scheduleFn(() => setPrimed(false));     // schedule auto-reset after timeout
  } else {
    clearFn();                              // cancel the pending reset
    setPrimed(false);
    onConfirm();
  }
}

// Preact hook wrapping applyClickSafety with real timers.
// Returns { primed, handleClick } — bind handleClick to the button's onClick.
// The button label / styling should change when primed is true (e.g. "Sure?").
export function useDoubleClickSafety(onConfirm, timeoutMs = 3000) {
  const [primed, setPrimed] = useState(false);
  const timerRef = useRef(null);

  function handleClick() {
    applyClickSafety(
      primed,
      onConfirm,
      setPrimed,
      () => clearTimeout(timerRef.current),
      (cb) => { timerRef.current = setTimeout(cb, timeoutMs); },
    );
  }

  return { primed, handleClick };
}
