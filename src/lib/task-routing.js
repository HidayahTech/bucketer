// Copyright (C) 2026 HidayahTech, LLC
// Routing a task's foreground-only side effects.
//
// A transfer keeps running against the connection it was launched under even after the
// user switches to another bucket (engines pin their client; the task store is a
// session-independent singleton). Its progress callbacks, though, reach into foreground
// state — the live Browser's listing (browserActionsRef) and the live capability display.
// After a switch those point at the WRONG connection, so a background task must NOT touch
// them. This predicate is the guard: true only when the task belongs to the connection
// currently in the foreground.
//
// The comparison intentionally allows null === null: an ad-hoc session (no saved
// connection selected) tags its tasks with connectionId null and is the foreground while
// nothing is selected. A null-tagged task stops being foreground the moment a saved
// connection is selected.
export function isForegroundTask(task, foregroundConnectionId) {
  return !!task && task.connectionId === foregroundConnectionId;
}
