// Copyright (C) 2026 HidayahTech, LLC
// Base-prefix (connection floor) primitives — prefix-scoped access keys (#60).
// Contract shared with the whole codebase: '' = unscoped; non-empty prefixes end in '/'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasePrefix, withinFloor, clampToFloor, discoveredFloor } from '../src/lib/base-prefix.js';

test('normalizeBasePrefix appends a trailing slash', () => {
  assert.equal(normalizeBasePrefix('team/alice'), 'team/alice/');
});

test('normalizeBasePrefix keeps an existing trailing slash (idempotent)', () => {
  assert.equal(normalizeBasePrefix('team/alice/'), 'team/alice/');
  assert.equal(normalizeBasePrefix(normalizeBasePrefix('team/alice')), 'team/alice/');
});

test('normalizeBasePrefix strips a leading slash', () => {
  assert.equal(normalizeBasePrefix('/team/alice/'), 'team/alice/');
});

test('normalizeBasePrefix collapses duplicate slashes', () => {
  assert.equal(normalizeBasePrefix('team//alice/'), 'team/alice/');
});

test('normalizeBasePrefix trims surrounding whitespace', () => {
  assert.equal(normalizeBasePrefix('  team/alice  '), 'team/alice/');
});

test('normalizeBasePrefix maps empty and whitespace-only input to unscoped', () => {
  assert.equal(normalizeBasePrefix(''), '');
  assert.equal(normalizeBasePrefix('   '), '');
  assert.equal(normalizeBasePrefix(undefined), '');
  assert.equal(normalizeBasePrefix(null), '');
});

test('normalizeBasePrefix preserves spaces inside segments', () => {
  assert.equal(normalizeBasePrefix('Team Notes/2026'), 'Team Notes/2026/');
});

test('withinFloor: empty floor admits everything', () => {
  assert.equal(withinFloor('', ''), true);
  assert.equal(withinFloor('anything/at/all/', ''), true);
});

test('withinFloor: floor admits itself and descendants', () => {
  assert.equal(withinFloor('team/alice/', 'team/alice/'), true);
  assert.equal(withinFloor('team/alice/2026/', 'team/alice/'), true);
});

test('withinFloor: rejects root, ancestors, and siblings', () => {
  assert.equal(withinFloor('', 'team/alice/'), false);
  assert.equal(withinFloor('team/', 'team/alice/'), false);
  assert.equal(withinFloor('team/bob/', 'team/alice/'), false);
});

test('withinFloor: prefix-boundary safety — "ab/" is not within floor "a/"', () => {
  assert.equal(withinFloor('ab/', 'a/'), false);
  assert.equal(withinFloor('ab/file.txt', 'a/'), false);
});

test('clampToFloor is identity for every input when floor is empty', () => {
  assert.equal(clampToFloor('', ''), '');
  assert.equal(clampToFloor('photos/2024/', ''), 'photos/2024/');
});

test('clampToFloor passes through in-floor prefixes unchanged', () => {
  assert.equal(clampToFloor('team/alice/2026/', 'team/alice/'), 'team/alice/2026/');
  assert.equal(clampToFloor('team/alice/', 'team/alice/'), 'team/alice/');
});

test('clampToFloor substitutes the floor for out-of-floor prefixes', () => {
  assert.equal(clampToFloor('', 'team/alice/'), 'team/alice/');
  assert.equal(clampToFloor('team/', 'team/alice/'), 'team/alice/');
  assert.equal(clampToFloor('team/bob/', 'team/alice/'), 'team/alice/');
});

// #67: a floor discovered on recovery is persisted into an empty-floor record only.
test('discoveredFloor returns the live floor when the record has none', () => {
  assert.equal(discoveredFloor('', 'team/alice/'), 'team/alice/');
  assert.equal(discoveredFloor(undefined, 'team/alice'), 'team/alice/', 'normalized on the way out');
});

test('discoveredFloor never overrides a stored floor', () => {
  assert.equal(discoveredFloor('team/alice/', 'team/bob/'), null);
  assert.equal(discoveredFloor('team/alice/', 'team/alice/'), null);
});

test('discoveredFloor is null when nothing was discovered', () => {
  assert.equal(discoveredFloor('', ''), null);
  assert.equal(discoveredFloor('', undefined), null);
  assert.equal(discoveredFloor('', '  '), null);
});
