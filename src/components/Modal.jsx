// Copyright (C) 2026 HidayahTech, LLC
// Generic modal wrapper: overlay closes on click, dialog stops propagation.
export function Modal({ onClose, class: extraClass, children }) {
  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class={extraClass ? `modal-dialog ${extraClass}` : 'modal-dialog'} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
