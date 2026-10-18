// Copyright (C) 2026 HidayahTech, LLC
// Parses CHANGELOG.md into the entries build.mjs writes to src/lib/changelog.js.
//
// Heading format: ## [version] — date — Title
// Bullet lines (- ...) become strings in the changes array; backtick markers are
// stripped for plain-text display in the modal. A bullet wrapped across multiple
// physical lines is joined back into one string: continuation lines (non-empty,
// not a bullet, not a **group** header, not a --- rule, not a ### heading, which
// is skipped) append to the most recent
// bullet (#50 — they were previously dropped, truncating every wrapped bullet).
// A non-bullet line with no item directly above it starts a { para } prose
// paragraph (BUG-084 — prose entries, v1.45.0 onward, were dropped entirely).
export function parseChangelog(src) {
  const entries = [];
  const sections = src.split(/^## /m).slice(1); // drop preamble
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0].trim();
    const m = header.match(/^\[([^\]]+)\]\s+—\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+))?$/);
    if (!m) continue;
    const [, version, date, title] = m;
    // Two-level parse: **Bold lines** become group labels; following bullet lines
    // are nested under them. Bullet lines before any group remain plain strings.
    // Older entries with no bold headers produce a flat string array (unchanged).
    const rawChanges = [];
    let currentGroup = null;
    let afterBlank = true; // the heading line counts as a break
    for (const line of lines.slice(1)) {
      const t = line.trim();
      const groupMatch = t.match(/^\*\*(.+)\*\*$/);
      const list = currentGroup ? currentGroup.items : rawChanges;
      const last = list[list.length - 1];
      if (groupMatch) {
        currentGroup = { group: groupMatch[1], items: [] };
        rawChanges.push(currentGroup);
      } else if (t.startsWith('- ')) {
        list.push(t.slice(2).trim());
      } else if (t && !/^-+$/.test(t) && !t.startsWith('#')) {
        if (!afterBlank && typeof last === 'string') list[list.length - 1] += ' ' + t;
        else if (!afterBlank && last?.para) last.para += ' ' + t;
        else {
          currentGroup = null;
          rawChanges.push({ para: t });
        }
      }
      afterBlank = !t;
    }
    // Plain-text cleanup for modal display: strip backtick and inline **bold**
    // markers. Runs AFTER continuation-line joining, because a marker pair can
    // span physical lines in the wrapped source (e.g. the v1.33.0 entry).
    const clean = (t) => t.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
    const changes = rawChanges.map((c) =>
      typeof c === 'string'
        ? clean(c)
        : c.para !== undefined
          ? { para: clean(c.para) }
          : { group: c.group, items: c.items.map(clean) },
    );
    entries.push({ version, date, ...(title ? { title: title.trim() } : {}), changes });
  }
  return entries;
}
