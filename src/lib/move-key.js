// Key remapping for the move feature. S3 has no native move, so a move recomputes
// each object's key under a new destination prefix, then copies + deletes. These are
// pure functions (no SDK) so the remapping is exhaustively unit-tested in isolation.
//
// Prefixes end in '/'; the root prefix is ''. See parentPrefix/leafName in format.js.
import { parentPrefix, leafName } from './format.js';

// Destination key for a loose file moved into destPrefix. Only the leaf name carries
// over — the file's old parent prefix is dropped.
//   destKeyForFile('reports/q1.pdf', 'archive/') -> 'archive/q1.pdf'
export function destKeyForFile(fileKey, destPrefix) {
  return destPrefix + leafName(fileKey);
}

// Base prefix for a folder being moved: the parent of the folder itself. Slicing each
// discovered key from here preserves the moved folder's own name under the destination.
//   folderBase('photos/2024/') -> 'photos/'   (so '2024/...' is kept)
//   folderBase('docs/')        -> ''          (top-level folder, whole name kept)
export function folderBase(folderPrefix) {
  return parentPrefix(folderPrefix.slice(0, -1));
}

// Destination key for an object discovered under a folder being moved. The folder's
// name and all nested sub-prefixes are preserved relative to its parent.
//   destKeyForFolderObject('photos/2024/', 'photos/2024/jan/a.jpg', 'archive/')
//     -> 'archive/2024/jan/a.jpg'
// The 0-byte folder-marker object ('photos/2024/') flows through the same formula,
// recreating the marker at the destination ('archive/2024/').
export function destKeyForFolderObject(folderPrefix, objectKey, destPrefix) {
  return destPrefix + objectKey.slice(folderBase(folderPrefix).length);
}
