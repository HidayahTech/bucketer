// Pure decision logic for drag-and-drop moves. The Browser wiring is a thin shell over
// these — the full drag gesture (DragEvent/DataTransfer) can't run under node/jsdom, so the
// behavior that matters lives here and is unit-tested directly.
import { validateMove } from './move-guards.js';

// What a drag of a given row should move. Dragging a row that is part of the current
// selection moves the whole selection; dragging a row that isn't selected moves just that
// row (the existing selection is untouched). `selection` is the already-resolved current
// selection: { files: [{key, size}], prefixes: [pfx] }.
//   dragged: { fileKey, fileSize } for a file row, or { prefix } for a folder row.
export function dragPayload({ fileKey, fileSize, prefix }, selection) {
  const inSelection = fileKey
    ? selection.files.some(f => f.key === fileKey)
    : selection.prefixes.includes(prefix);

  if (inSelection) {
    return { files: selection.files, prefixes: selection.prefixes, fromSelection: true };
  }
  return fileKey
    ? { files: [{ key: fileKey, size: fileSize ?? 0 }], prefixes: [], fromSelection: false }
    : { files: [], prefixes: [prefix], fromSelection: false };
}

// Whether a drop onto `dest` is structurally allowed (not a folder-into-itself/descendant or
// a no-op). The runtime collision/never-overwrite concern is handled later by runMoveOperation.
export function dropAccepted(payload, dest) {
  return validateMove({
    files: payload.files.map(f => f.key),
    prefixes: payload.prefixes,
    dest,
  }) === null;
}
