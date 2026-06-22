// Copyright (C) 2026 HidayahTech, LLC
// Minimal pub-sub toast store. UI-framework-agnostic so any code — component
// handlers, queue callbacks — can raise a transient success message without prop
// drilling or context. ToastHost.jsx subscribes and renders the active toasts.
//
// createToastStore() returns an isolated store (used by tests); the module also
// exports a shared singleton plus showToast/dismissToast convenience wrappers
// that the app uses.

export function createToastStore() {
  let toasts = [];
  let nextId = 1;
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(toasts); };

  const dismiss = (id) => {
    toasts = toasts.filter(t => t.id !== id);
    emit();
  };

  const show = (message, { type = 'success', duration = 3000 } = {}) => {
    const id = nextId++;
    toasts = [...toasts, { id, message, type }];
    emit();
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    fn(toasts);
    return () => listeners.delete(fn);
  };

  return { subscribe, get: () => toasts, show, dismiss };
}

export const toastStore = createToastStore();
export const showToast = (message, opts) => toastStore.show(message, opts);
export const dismissToast = (id) => toastStore.dismiss(id);
