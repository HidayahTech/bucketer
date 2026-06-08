// Copyright (C) 2026 HidayahTech, LLC
// Object name validation for rename and folder-create operations.
//
// WHY THIS FILE EXISTS: the same validation rules (non-empty, no slashes) were
// duplicated in two places in Browser.jsx — the rename handler and the new-folder
// handler. If a rule changes (e.g. adding a length limit or forbidding other
// characters), it must only be changed here.
//
// WHAT BELONGS HERE: validation rules for S3 object name segments (the leaf part
// after the prefix). Rules apply to both rename and folder creation.
//
// WHAT DOES NOT BELONG HERE: validation of full S3 keys (which may contain slashes),
// bucket name validation, or credential validation (see credential-validation.js).

// Returns null if the name is valid, or a human-readable error string if not.
export function validateObjectName(name) {
  if (!name || !String(name).trim()) return 'Name cannot be empty.';
  if (String(name).includes('/')) return 'Name cannot contain slashes.';
  return null;
}
