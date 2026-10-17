// Unit tests for the GitLab Release name/description parser used by scripts/release.mjs.
// The upload and Release API calls run only in CI's release job, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotes } from '../scripts/changelog-release.mjs';

const changelog = `# Changelog

Heading format: \`## [version] — date — Title\`

---

## [1.2.0] — 2026-10-17 — Prose release

First paragraph with **bold** and a (BUG-001) note.

Second paragraph.

## [1.1.0] — 2026-10-16 — Bullet release

- one
- two

## [1.0.0] — 2026-10-15 — Older
`;

test('a prose entry keeps its whole body as the description', () => {
  assert.deepEqual(releaseNotes(changelog, '1.2.0'), {
    title: 'Prose release',
    description: 'First paragraph with **bold** and a (BUG-001) note.\n\nSecond paragraph.',
  });
});

test('a bullet entry keeps its bullets', () => {
  assert.equal(releaseNotes(changelog, '1.1.0').description, '- one\n- two');
});

test('an entry with no body has an empty description', () => {
  assert.deepEqual(releaseNotes(changelog, '1.0.0'), { title: 'Older', description: '' });
});

test('an unknown version returns null', () => {
  assert.equal(releaseNotes(changelog, '9.9.9'), null);
});

test('the top entry of the real CHANGELOG.md has a non-empty description', () => {
  const real = readFileSync('CHANGELOG.md', 'utf8');
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assert.ok(releaseNotes(real, version)?.description.length > 0);
});
