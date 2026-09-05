// Copyright (C) 2026 HidayahTech, LLC
// New-folder state + creation, extracted from Browser.jsx (following the usePreview
// precedent) so the browser's heaviest component sheds a self-contained cluster.
//
// S3 has no folders; a "folder" is a zero-byte marker object at `prefix/name/`. Creation
// PUTs that marker, invalidates the listing cache, and adds the prefix to the in-memory
// list so the row appears without a re-list.
import { useState } from 'preact/hooks';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { validateObjectName } from './validate-object-name.js';

export function useNewFolder({ client, bucket, prefix, commonPrefixes, setCommonPrefixes, invalidateCache }) {
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState(null);
  const [newFolderSaving, setNewFolderSaving] = useState(false);

  function openNewFolder() {
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderOpen(true);
  }

  function closeNewFolder() {
    setNewFolderOpen(false);
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    const nameErr = validateObjectName(name);
    if (nameErr) { setNewFolderError(nameErr); return; }
    const key = prefix + name + '/';
    if (commonPrefixes.includes(key)) { setNewFolderError('A folder with that name already exists.'); return; }
    setNewFolderSaving(true);
    setNewFolderError(null);
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: '', ContentType: 'application/x-directory',
      }));
      invalidateCache(prefix);
      setCommonPrefixes(prev => [...prev, key].sort());
      setNewFolderOpen(false);
    } catch (err) {
      setNewFolderError(err.message || String(err));
    } finally {
      setNewFolderSaving(false);
    }
  }

  return {
    newFolderOpen, newFolderName, setNewFolderName, newFolderError, setNewFolderError,
    newFolderSaving, openNewFolder, closeNewFolder, handleCreateFolder,
  };
}
