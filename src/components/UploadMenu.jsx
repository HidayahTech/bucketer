// Copyright (C) 2026 HidayahTech, LLC
// "Upload ▾" in the file toolbar (layout A, v1.67.0): replaces the always-open destination form
// and its Choose files / Choose folder buttons, which pushed the file list down the page
// (REPORT W1). Owns the hidden file inputs; the picked files go to onFiles, which feeds the
// upload queue. A disclosure like Bucket tools ▾: Escape and a click outside close it.
import { useState, useRef, useEffect } from 'preact/hooks';
import { Icon } from './Icon.jsx';

export function UploadMenu({ onFiles, disabled = false, disabledTitle }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(ref) {
    setOpen(false);
    ref.current?.click();
  }

  return (
    <div class="upload-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        class="btn btn-primary btn-sm upload-menu-btn"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="upload-menu"
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="upload" /> Upload <Icon name="chevron-down" />
      </button>
      {open && (
        <div id="upload-menu" class="copy-link-popover upload-menu">
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => pick(fileInputRef)}>
            Upload files…
          </button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => pick(folderInputRef)}>
            Upload a folder…
          </button>
          <div class="copy-link-note">Or drag files and folders anywhere onto this window.</div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="file-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          onFiles(Array.from(e.target.files).map((f) => ({ file: f, relativePath: f.name })));
          e.target.value = '';
        }}
      />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          if (el) el.webkitdirectory = true;
        }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          onFiles(
            Array.from(e.target.files).map((f) => ({
              file: f,
              relativePath: f.webkitRelativePath || f.name,
            })),
          );
          e.target.value = '';
        }}
      />
    </div>
  );
}
