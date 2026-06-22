// Copyright (C) 2026 HidayahTech, LLC
// Browser keyboard shortcuts. resolveShortcut maps a keydown event + a small
// context object to an action string the Browser dispatches, or null when no
// shortcut applies. Pure (no DOM), so it unit-tests in plain Node.
//
//   "/"            → focus-filter
//   Ctrl/Cmd + A   → select-all
//   Delete         → delete  (only when something is selected)
//
// Shortcuts are suppressed while typing in a text field and while the preview is
// open (which owns Esc / arrow navigation). Backspace deliberately does NOT
// delete — too easy to hit by accident.

export function isEditableTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function resolveShortcut(e, ctx) {
  if (ctx.previewOpen) return null;   // preview owns Esc / arrows
  if (ctx.inTextField) return null;   // don't hijack typing

  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.key === 'a' || e.key === 'A') return 'select-all';
    return null;                      // leave other Ctrl/Cmd combos to the browser
  }
  if (e.key === '/') return 'focus-filter';
  if (e.key === 'Delete' && ctx.hasSelection) return 'delete';
  return null;
}
