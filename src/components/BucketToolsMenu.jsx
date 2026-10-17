// Copyright (C) 2026 HidayahTech, LLC
// Header "Bucket tools ▾" (layout A, v1.67.0): the occasional whole-bucket tools, out of the
// header's row of always-visible buttons (REPORT W8: power tools named by mechanism, crowding
// the header). A disclosure — a button with aria-expanded over plain buttons — so it needs no
// arrow-key model; Escape and a click outside close it, and Escape returns focus to the button.
import { useState, useRef, useEffect } from 'preact/hooks';
import { Icon } from './Icon.jsx';

export function BucketToolsMenu({ onFindDuplicates, onIncompleteUploads, onHiddenVersions }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

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

  const pick = (fn) => () => {
    setOpen(false);
    fn?.();
  };

  return (
    <div class="bucket-tools-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        class="btn btn-sm hdr-btn bucket-tools-btn"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="bucket-tools-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sliders" /> Bucket tools <Icon name="chevron-down" />
      </button>
      {open && (
        <div id="bucket-tools-menu" class="copy-link-popover bucket-tools-menu">
          <button type="button" class="btn btn-ghost btn-sm" onClick={pick(onFindDuplicates)}>
            Find duplicate files…
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="open-incomplete-uploads"
            onClick={pick(onIncompleteUploads)}
          >
            Incomplete uploads…
          </button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={pick(onHiddenVersions)}>
            Hidden versions and deleted files…
          </button>
        </div>
      )}
    </div>
  );
}
