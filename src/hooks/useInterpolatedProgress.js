// Copyright (C) 2026 HidayahTech, LLC
// Smoothly interpolated byte-counter driven by requestAnimationFrame.
//
// WHY THIS FILE EXISTS: the rAF byte-counter animation was duplicated between
// BatchSummary and UploadItem in UploadQueue.jsx. Both used the same 66ms throttle,
// document.visibilityState guard, and floor-clamping logic. Extracting the math as
// a pure function (interpolateBytes) and the hook separately means the behavior is
// tested once and the component code is substantially shorter.
//
// WHAT BELONGS HERE: interpolateBytes() pure math function (exported for testing)
// and the useInterpolatedProgress() hook that drives a rAF loop.
//
// WHAT DOES NOT BELONG HERE: rolling-window speed calculation (that stays in the
// component because it depends on component-owned sample history), S3 operations,
// or upload state. This hook has no knowledge of uploads — it only smooths a number.

import { useState, useEffect, useRef } from 'preact/hooks';

// Pure interpolation math — exported for unit testing without a DOM/rAF environment.
//
// prev:            the current displayed value
// speed:           bytes/second (instantaneous, from caller)
// dt:              elapsed seconds since last frame
// floor:           minimum value (confirmed bytes — display never goes backward)
// max:             ceiling (file size)
// visibilityHidden: true when document.visibilityState === 'hidden' — pause animation
export function interpolateBytes(prev, speed, dt, floor, max, visibilityHidden) {
  if (visibilityHidden) return prev;
  return Math.min(Math.max(prev + speed * dt, floor), max);
}

// Hook: drives a rAF loop that advances displayedBytes at the given speed between
// real progress events, floored at confirmedBytes and capped at fileSize.
//
// isActive:      start/stop the animation loop
// confirmedBytes: the authoritative byte count (snaps display forward if lagging)
// speed:         bytes/second to extrapolate at
// fileSize:      upper ceiling for the display value
export function useInterpolatedProgress({ isActive, confirmedBytes, speed, fileSize }) {
  const [displayedBytes, setDisplayedBytes] = useState(confirmedBytes);
  const animRef  = useRef(null);
  const speedRef = useRef(speed);
  const floorRef = useRef(confirmedBytes);

  // Keep refs in sync with props so the rAF closure reads fresh values.
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    floorRef.current = confirmedBytes;
    setDisplayedBytes(prev => Math.max(prev, confirmedBytes));
  }, [confirmedBytes]);

  useEffect(() => {
    if (!isActive) {
      cancelAnimationFrame(animRef.current);
      setDisplayedBytes(confirmedBytes);
      return;
    }
    let last = performance.now();
    function tick(now) {
      // 66ms throttle (≈15fps) prevents excessive re-renders during concurrent uploads.
      // Visibility check skips updates while the tab is hidden but keeps the loop alive.
      if (document.visibilityState === 'hidden' || now - last < 66) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      setDisplayedBytes(prev =>
        interpolateBytes(prev, speedRef.current, dt, floorRef.current, fileSize, false),
      );
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isActive, fileSize]); // eslint-disable-line react-hooks/exhaustive-deps

  return { displayedBytes };
}
