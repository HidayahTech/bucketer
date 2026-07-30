// Copyright (C) 2026 HidayahTech, LLC
// Turn arbitrary S3 keys into safe local filenames.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// S3 keys are arbitrary byte strings — they can contain "..", path separators, control
// characters, Windows-reserved device names, and characters no filesystem accepts. The
// WHATWG fs spec's "valid file name" check only rejects "", ".", ".." and the path
// separator, and explicitly leaves everything else to the OS, so this module does the
// rest. Nothing here may ever produce a name that escapes the destination directory.

export const NAMING_MODES = { LEAF: 'leaf', FLATTEN: 'flatten' };

// Reserved on Windows with or without an extension: CON.txt is still CON.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Control characters are invisible garbage rather than meaningful text, so they are
// removed outright; turning them into underscores would only pad the name with noise.
// Written as escapes rather than literal bytes so the source stays readable and greppable.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

// Anything Windows rejects, plus both path separators.
const ILLEGAL = /[<>:"/\\|?*]/g;

const MAX_SEGMENT_BYTES = 255;

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}

// Trim to a byte budget one code point at a time so a surrogate pair is never split.
function truncateToBytes(str, budget) {
  let out = str;
  while (utf8Length(out) > budget && out.length > 0) out = out.slice(0, -1);
  return out;
}

export function sanitizeSegment(segment) {
  let s = String(segment ?? '').normalize('NFC').replace(CONTROL, '');

  // A segment of nothing but dots is the traversal case. Mapping each dot to an
  // underscore keeps the name recognisable while making traversal impossible.
  if (/^\.+$/.test(s)) return '_'.repeat(s.length);

  s = s.replace(ILLEGAL, '_');
  s = s.replace(/[. ]+$/, '');   // Windows silently drops trailing dots and spaces

  if (!s) return '_';

  const dot = s.indexOf('.');
  const base = dot === -1 ? s : s.slice(0, dot);
  const ext = dot === -1 ? '' : s.slice(dot);
  if (RESERVED.test(base)) s = `${base}_${ext}`;

  if (utf8Length(s) > MAX_SEGMENT_BYTES) {
    // Keep a short extension so the file still opens with the right application.
    const keepExt = utf8Length(ext) <= 20 ? ext : '';
    s = truncateToBytes(s.slice(0, s.length - keepExt.length), MAX_SEGMENT_BYTES - utf8Length(keepExt)) + keepExt;
  }

  return s || '_';
}

// Split a key into sanitised path segments. Empty segments (from "//", a leading "/",
// or a trailing "/") are dropped, so an absolute-looking key is always relative.
export function segmentsForKey(key) {
  return String(key ?? '')
    .split('/')
    .filter(Boolean)
    .map(sanitizeSegment);
}

// A zero-byte key ending in "/" is a folder marker, not a file to download.
export function isDirectoryMarker(key) {
  const k = String(key ?? '');
  return k.length > 0 && k.endsWith('/');
}

export function flatNameForKey(key, mode = NAMING_MODES.LEAF) {
  const segments = segmentsForKey(key);
  if (segments.length === 0) return '_';
  return mode === NAMING_MODES.FLATTEN ? segments.join('__') : segments[segments.length - 1];
}

// NOTE ON COLLISIONS: names here are deterministic, not de-duplicated. In the
// browser-managed tier the app cannot control the final filename anyway — the `download`
// attribute is only a suggestion, and the browser renames collisions to "file (1).ext"
// on its own. Verification therefore matches on the suggested name and treats an
// ambiguous name (two keys in the same job producing one name) as unverifiable rather
// than pretending otherwise. Stage 3, which does control the filesystem, allocates unique
// names per directory where the bookkeeping is bounded.
