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

// Copy-and-keep collision renaming (#17). A copy must never overwrite, so a colliding
// destination is disambiguated with a " (n)" suffix rather than skipped.

// Insert a " (n)" disambiguator before the file extension (or at the end if there is
// none, including for leading-dot dotfiles).
export function suffixName(name, n) {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

// Non-colliding destination key for a file: keep it if free, else suffix its leaf name
// (preserving the directory) until isTaken() returns false.
export function freeFileKey(destKey, isTaken) {
  if (!isTaken(destKey)) return destKey;
  const leaf = leafName(destKey);
  const dir  = destKey.slice(0, destKey.length - leaf.length);
  for (let n = 1; ; n++) {
    const candidate = dir + suffixName(leaf, n);
    if (!isTaken(candidate)) return candidate;
  }
}

// Non-colliding destination folder prefix (ends in '/'): keep it if free, else suffix the
// leaf folder name (preserving the parent) until isTakenPrefix() returns false. Children
// are then remapped under the returned prefix so the folder stays coherent.
export function freeFolderPrefix(folderTop, isTakenPrefix) {
  if (!isTakenPrefix(folderTop)) return folderTop;
  const inner = folderTop.slice(0, -1);
  const leaf  = leafName(inner);
  const base  = inner.slice(0, inner.length - leaf.length);
  for (let n = 1; ; n++) {
    const candidate = `${base}${leaf} (${n})/`;
    if (!isTakenPrefix(candidate)) return candidate;
  }
}

// Folder rename (#18): a folder relabeled at the same parent. renamedFolderPrefix computes
// the target prefix; renameFolderKey prefix-swaps every key (including the 0-byte marker)
// from the old prefix onto the new one.
//   renamedFolderPrefix('photos/2024/', 'memories') -> 'photos/memories/'
export function renamedFolderPrefix(oldPrefix, newName) {
  return parentPrefix(oldPrefix.slice(0, -1)) + newName + '/';
}

//   renameFolderKey('photos/2024/', 'photos/2024/jan/a.jpg', 'photos/memories/')
//     -> 'photos/memories/jan/a.jpg'
export function renameFolderKey(oldPrefix, objectKey, newPrefix) {
  return newPrefix + objectKey.slice(oldPrefix.length);
}
