// Copyright (C) 2026 HidayahTech, LLC
// App-level modal open/close state management.
//
// WHY THIS FILE EXISTS: App.jsx has three separate pairs of modal open/close state
// (changelog, about, storage). Grouping them here signals that these are a unit —
// if a new modal is added to App, its state should be added here, not scattered
// among other App-level state declarations.
//
// WHAT BELONGS HERE: boolean open/close state for modals that are rendered at the
// App root level (i.e., not nested inside a specific component).
//
// WHAT DOES NOT BELONG HERE: modal content, session state, credentials, or any
// logic that belongs to the individual modal components.

import { useState } from 'preact/hooks';

export function useModalStates() {
  const [changelogOpen,   setChangelogOpen]   = useState(false);
  const [aboutOpen,       setAboutOpen]       = useState(false);
  const [storageOpen,     setStorageOpen]     = useState(false);
  const [duplicatesOpen,  setDuplicatesOpen]  = useState(false);
  return {
    changelogOpen, setChangelogOpen,
    aboutOpen, setAboutOpen,
    storageOpen, setStorageOpen,
    duplicatesOpen, setDuplicatesOpen,
  };
}
