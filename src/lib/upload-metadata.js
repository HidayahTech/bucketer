// Copyright (C) 2026 HidayahTech, LLC
// Builds the S3 custom-metadata map sent with every upload.
//
// WHY THIS FILE EXISTS: both upload paths (single PUT and multipart create) attach the
// same metadata. Centralizing it keeps the two call sites identical and makes the rule —
// always stamp the file mtime, stamp the content hash only when one is available — easy to
// test in isolation. Metadata values must be strings, so the hash key is omitted (not set
// to null/empty) when there is no hash to record.

import { FILE_MTIME_KEY, CONTENT_HASH_KEY } from './constants.js';

export function buildUploadMetadata(file, contentHashValue) {
  const meta = { [FILE_MTIME_KEY]: new Date(file.lastModified).toISOString() };
  if (contentHashValue) meta[CONTENT_HASH_KEY] = contentHashValue;
  return meta;
}
