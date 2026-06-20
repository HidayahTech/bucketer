// Structural validation for a move. These guards depend only on the selected keys and
// the chosen destination prefix — not on the destination's actual contents (that is the
// runtime collision check in move-queue.js). validateMove returns the first violation
// message, or null if the move is structurally valid. The picker uses it to disable
// "Move here" with an inline reason.
//
// Prefixes (source folders and dest) end in '/'; the root is ''.
import { parentPrefix } from './format.js';

export function validateMove({ files = [], prefixes = [], dest = '' }) {
  for (const p of prefixes) {
    // Into itself or a descendant: dest starts with the folder's own prefix. Both p
    // and dest end in '/', so 'photos/' is not falsely seen as inside 'photo/'.
    if (dest.startsWith(p)) {
      return 'Cannot move a folder into itself or one of its subfolders.';
    }
    // No-op: the folder already lives directly under dest.
    if (parentPrefix(p.slice(0, -1)) === dest) {
      return 'That folder is already in this location.';
    }
  }

  for (const key of files) {
    // No-op: the file already lives directly under dest (that would be a rename).
    if (parentPrefix(key) === dest) {
      return 'That file is already in this location.';
    }
  }

  return null;
}
