// Copyright (C) 2026 HidayahTech, LLC
// Generic modal wrapper: overlay closes on click, dialog stops propagation.
// Dialog contract (R07): role=dialog + aria-modal, labelled by its .modal-title,
// focus moves in on open, Tab is trapped, Escape closes, focus returns on close.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let titleSeq = 0;

export function Modal({ onClose, class: extraClass, children }) {
  const dialogRef = useRef(null);
  // Captured during the first render, before any child can grab focus.
  const [opener] = useState(() => document.activeElement);
  const [labelId, setLabelId] = useState(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const title = dialog.querySelector('.modal-title');
    if (title) {
      if (!title.id) title.id = `modal-title-${++titleSeq}`;
      setLabelId(title.id);
    }
    if (!dialog.contains(document.activeElement)) {
      (dialog.querySelector(FOCUSABLE) ?? dialog).focus();
    }
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        class={extraClass ? `modal-dialog ${extraClass}` : 'modal-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId ?? undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
