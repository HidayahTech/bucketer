// Copyright (C) 2026 HidayahTech, LLC
// Confirm-then-act button used in StorageModal. The parent owns the
// single-active-dialog state and the action dispatcher; this component is a
// pure view bound to one `id`.
export function ConfirmDialog({
  id, label, warning, danger = false, reload = false, controller,
}) {
  const { confirmAction, cleared, setConfirm, act } = controller;
  const pending = confirmAction === id;
  const done    = cleared === id;
  return (
    <div class="sv-actions">
      {done && !pending && <span class="sv-cleared-msg">✓ Cleared</span>}
      {pending ? (
        <>
          {(warning || reload) && (
            <span class="sv-confirm-warn">
              {warning ?? (reload ? 'This will reload the page.' : '')}
            </span>
          )}
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
          <button type="button" class={`btn btn-sm ${danger ? 'btn-danger' : 'btn-ghost'}`}
            onClick={() => act(id)}>{label}</button>
        </>
      ) : (
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(id)}>{label}</button>
      )}
    </div>
  );
}
