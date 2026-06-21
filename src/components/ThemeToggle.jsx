// Copyright (C) 2026 HidayahTech, LLC
// Header control that cycles the colour-theme preference system → light → dark.
// The chosen preference persists in localStorage and is reflected on the document
// root via data-theme (see src/lib/theme.js); 'system' clears the attribute so the
// prefers-color-scheme media query governs.
import { useState } from 'preact/hooks';
import { loadThemePref, saveThemePref } from '../lib/storage.js';
import { nextThemePref, applyThemeToRoot } from '../lib/theme.js';

const META = {
  system: { icon: '🖥', title: 'Theme: System (click for Light)' },
  light:  { icon: '☀', title: 'Theme: Light (click for Dark)' },
  dark:   { icon: '🌙', title: 'Theme: Dark (click for System)' },
};

export function ThemeToggle() {
  const [pref, setPref] = useState(loadThemePref());

  function cycle() {
    const next = nextThemePref(pref);
    setPref(next);
    saveThemePref(next);
    applyThemeToRoot(next, document.documentElement);
  }

  const meta = META[pref] || META.system;
  return (
    <button
      type="button"
      class="btn btn-ghost btn-sm theme-toggle"
      style={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
      onClick={cycle}
      title={meta.title}
      aria-label={meta.title}
    >
      <span aria-hidden="true">{meta.icon}</span>
    </button>
  );
}
