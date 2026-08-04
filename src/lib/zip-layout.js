// Copyright (C) 2026 HidayahTech, LLC
// Pure, deterministic byte layout for a store-only ZIP whose entry sizes are known up
// front (the manifest records them). This is the whole premise of in-place composition:
// every offset is fixed before any byte is downloaded. See
// docs/superpowers/specs/2026-08-04-inplace-offset-composition-design.md.
import { localHeaderBytes, dosDateTime } from './zip-writer.js';
import { zipEntryPath } from './zip-job.js';

export function computeZipLayout(items, prefix = '', { zip64Limit = 0xFFFFFFFF, startOffset = 0 } = {}) {
  const entries = [];
  let offset = startOffset;
  for (const it of items) {
    const path = zipEntryPath(it.key, prefix);
    const { time, date } = dosDateTime(it.lastModified);
    const headerBytes = localHeaderBytes(path, { time, date }).length;
    const declaredSize = it.size || 0;
    const zip64 = declaredSize >= zip64Limit;
    const descriptorBytes = zip64 ? 24 : 16;
    const headerOffset = offset;
    const dataOffset = headerOffset + headerBytes;
    const descriptorOffset = dataOffset + declaredSize;
    const entryEnd = descriptorOffset + descriptorBytes;
    entries.push({ key: it.key, path, headerOffset, headerBytes, dataOffset, declaredSize, descriptorOffset, descriptorBytes, entryEnd, zip64, time, date });
    offset = entryEnd;
  }
  return { entries, centralDirOffset: offset, totalDataEnd: offset };
}
