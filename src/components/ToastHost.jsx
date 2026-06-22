// Copyright (C) 2026 HidayahTech, LLC
// Renders transient success toasts from the shared toast store (src/lib/toast.js).
// Mounted once near the App root. The aria-live container is always present so
// screen readers announce toasts that are added later; each toast is a button so
// it can be dismissed by click or keyboard.
import { useState, useEffect } from 'preact/hooks';
import { toastStore } from '../lib/toast.js';

export function ToastHost() {
  const [toasts, setToasts] = useState(toastStore.get());
  useEffect(() => toastStore.subscribe(setToasts), []);

  return (
    <div class="toast-host" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map(t => (
        <button
          type="button"
          key={t.id}
          class={`toast toast-${t.type}`}
          onClick={() => toastStore.dismiss(t.id)}
          title="Dismiss"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
