// Copyright (C) 2026 HidayahTech, LLC
// Renders children into a DOM element owned by the caller, as their own Preact root (the core
// portal pattern; preact/compat's createPortal would add ~10 KB for the same thing).
//
// Layout A (v1.67.0) needs it: the upload queue, task panel and upload history sit visually
// between the file toolbar and the file list, but Browser is remounted (key={browserKey}) on
// every reconnect, and anything rendered inside it would lose in-flight upload state. App owns a
// detached element, renders the Activity tree into it here, and Browser only moves the element
// into place (BelowToolbarHost), so a Browser remount re-attaches the same live tree.
import { render } from 'preact';
import { useLayoutEffect } from 'preact/hooks';

export function Portal({ container, children }) {
  useLayoutEffect(() => {
    render(children, container);
  });
  useLayoutEffect(() => () => render(null, container), [container]);
  return null;
}
