// Copyright (C) 2026 HidayahTech, LLC
// Window-level file drag-over detection and drop handling.
//
// WHY THIS FILE EXISTS: the three drag-related event listeners (dragenter, dragleave,
// dragover) plus the drop handler totalled 60+ lines in App.jsx. Moving them here
// keeps App focused on its primary concern — session state and credential lifecycle.
//
// WHAT BELONGS HERE: window-level drag detection (shows a drop zone overlay) and
// file entry resolution from a DataTransfer object.
//
// WHAT DOES NOT BELONG HERE: upload queue management (App's addFilesRef handles
// enqueuing), session state, S3 operations, or credential logic.

import { useState, useEffect, useRef } from 'preact/hooks';
import { resolveDroppedFiles } from '../lib/file-entries.js';

// enabled:     true when the drop zone should be active (i.e. session is connected and upload is permitted)
// addFilesRef: ref to the UploadQueue's addFiles function — called when files are dropped
export function useWindowDragDrop({ enabled, addFilesRef }) {
  const [windowDragOver, setWindowDragOver] = useState(false);
  const counterRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      counterRef.current = 0;
      setWindowDragOver(false);
      return;
    }

    function onDragEnter(e) {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      if (document.querySelector('.modal-overlay')) return;
      counterRef.current++;
      setWindowDragOver(true);
    }
    function onDragLeave(e) {
      if (counterRef.current === 0) return;
      // relatedTarget is null when the drag exits the browser window entirely
      if (e.relatedTarget === null || !document.documentElement.contains(e.relatedTarget)) {
        counterRef.current = 0;
        setWindowDragOver(false);
        return;
      }
      counterRef.current = Math.max(0, counterRef.current - 1);
      if (counterRef.current === 0) setWindowDragOver(false);
    }
    function onDragOver(e) {
      if (counterRef.current > 0) e.preventDefault();
    }

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover',  onDragOver);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover',  onDragOver);
      counterRef.current = 0;
      setWindowDragOver(false);
    };
  }, [enabled]);

  function handleWindowDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    counterRef.current = 0;
    setWindowDragOver(false);
    resolveDroppedFiles(e.dataTransfer).then(fileEntries => {
      if (fileEntries.length) addFilesRef.current?.(fileEntries);
    }).catch(() => {});
  }

  return { windowDragOver, handleWindowDrop };
}
