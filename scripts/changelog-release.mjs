// Copyright (C) 2026 HidayahTech, LLC
// Finds one version's entry in CHANGELOG.md for its GitLab Release (scripts/release.mjs).
// Returns { title, description } or null when the version has no entry.
export function releaseNotes(changelog, version) {
  for (const section of changelog.split(/^## /m).slice(1)) {
    const [heading, ...body] = section.split('\n');
    const m = heading.trim().match(/^\[([^\]]+)\]\s+—\s+\S+\s+—\s+(.+)$/);
    // The whole body, prose or bullets: keeping only "- " lines published every prose entry
    // (v1.45.0 onward) with an empty description (BUG-083).
    if (m && m[1] === version) return { title: m[2].trim(), description: body.join('\n').trim() };
  }
  return null;
}
