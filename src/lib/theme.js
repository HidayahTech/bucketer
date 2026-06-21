// Theme preference: 'system' follows the OS (via the prefers-color-scheme media
// query); 'light' / 'dark' force a mode. Pure helpers — no DOM access beyond the
// root element passed in, so they unit-test without a browser.

export const THEME_PREFS = ['system', 'light', 'dark'];

// Cycle order for the header toggle: system → light → dark → system. An unknown
// value restarts the cycle at 'system'.
export function nextThemePref(pref) {
  const i = THEME_PREFS.indexOf(pref);
  return THEME_PREFS[(i + 1) % THEME_PREFS.length];
}

// Reflect the preference on the document root. 'system' clears the attribute so
// the CSS prefers-color-scheme media query governs (and tracks OS changes live,
// even before JS runs — avoiding a flash). 'light' / 'dark' force the mode via
// the data-theme attribute, which CSS keys dark styling off.
export function applyThemeToRoot(pref, root) {
  if (!root) return;
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
  else root.removeAttribute('data-theme');
}
