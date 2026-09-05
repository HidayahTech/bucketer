// Copyright (C) 2026 HidayahTech, LLC
// Rename state + handlers, extracted from Browser.jsx (following the usePreview/
// useNewFolder precedent). Files rename inline (CopyObject + DeleteObject — S3 has no
// rename); folders dispatch to the move queue (a folder can hold many objects).
//
// Behavior is preserved exactly from the pre-extraction Browser component; the two
// characterization tests (browser-file-rename, browser-folder-rename) pin it.
//
// NOTE (pre-existing, not changed here): commitRename builds CopySource by raw string
// interpolation (`${bucket}/${oldKey}`), so a key with a character above U+00FF is not
// percent-encoded — the same class as BUG-060, which was fixed for MOVE (move-key.js)
// but not for inline file rename. Worth a follow-up; left as-is to keep this a pure
// extraction.
import { useState } from 'preact/hooks';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { showToast } from './toast.js';
import { validateObjectName } from './validate-object-name.js';
import { leafName } from './format.js';

export function useRename({ client, bucket, prefix, items, setItems, commonPrefixes, invalidateCache, onMoveRequest }) {
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(null);
  const [renameSaving, setRenameSaving] = useState(false);

  function startRename(key) {
    setRenamingKey(key);
    setRenameValue(leafName(key));
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingKey(null);
  }

  // S3 has no rename. Rename = CopyObject + DeleteObject.
  // Copy FIRST: if copy fails, the original is untouched. MetadataDirective: 'COPY' preserves
  // Content-Type and custom metadata — the default 'REPLACE' would strip them.
  async function commitRename(oldKey) {
    const newName = renameValue.trim();
    const nameErr = validateObjectName(newName);
    if (nameErr) { setRenameError(nameErr); return; }
    const newKey = prefix + newName;
    if (newKey === oldKey) { setRenamingKey(null); return; }
    if (items.some(o => o.Key === newKey)) { setRenameError('A file with that name already exists.'); return; }
    setRenameSaving(true);
    setRenameError(null);
    try {
      await client.send(new CopyObjectCommand({
        Bucket: bucket, CopySource: `${bucket}/${oldKey}`,
        Key: newKey, MetadataDirective: 'COPY',
      }));
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
      invalidateCache(prefix);
      setItems(prev => prev.map(o => o.Key === oldKey ? { ...o, Key: newKey } : o));
      setRenamingKey(null);
      showToast(`Renamed to "${newName}"`);
    } catch (err) {
      setRenameError(err.message || String(err));
    } finally {
      setRenameSaving(false);
    }
  }

  function startFolderRename(cp) {
    setRenamingKey(cp);
    setRenameValue(leafName(cp.slice(0, -1)));
    setRenameError(null);
  }

  // Folder rename dispatches to the move queue (a folder can hold many objects) rather
  // than blocking inline. The queued task shows progress; the row is removed on success
  // via the existing movedPrefixes handling.
  function commitFolderRename(oldPrefix) {
    const newName = renameValue.trim();
    const nameErr = validateObjectName(newName);
    if (nameErr) { setRenameError(nameErr); return; }
    if (newName === leafName(oldPrefix.slice(0, -1))) { setRenamingKey(null); return; }
    if (commonPrefixes.includes(prefix + newName + '/')) {
      setRenameError('A folder with that name already exists.');
      return;
    }
    setRenamingKey(null);
    onMoveRequest?.({ prefixes: [oldPrefix], renameTo: newName, mode: 'rename', capturedPrefix: prefix });
  }

  return {
    renamingKey, renameValue, renameError, renameSaving,
    setRenameValue, setRenameError,
    startRename, cancelRename, commitRename, startFolderRename, commitFolderRename,
  };
}
