# Design: Storage Viewer & Privacy Controls

A debug/advanced tool giving users full visibility into what Bucketer has stored
about their sessions, and the ability to clear any or all of it.

**Status:** Design only — no code changes yet.

---

## Motivation

Bucketer makes a privacy promise: "your credentials never leave your browser."
But a user who wants to verify that promise, or a user troubleshooting a
corrupted state, has no way to inspect what's actually in the browser without
opening DevTools. This feature closes that gap.

Three concrete use cases:

1. **Trust verification.** A user wants to confirm the secret key is not in
   localStorage before handing their laptop to someone else.

2. **Debug and repair.** A user encounters strange behaviour (wrong profile name,
   stale capabilities, an upload that won't resume). They want to see raw values
   and reset specific parts of the state.

3. **Complete erasure.** A user is done with the app and wants one button to
   remove every trace of it from their browser without having to open DevTools
   and manually hunt down an IndexedDB database.

---

## Placement in the UI

**A modal, accessible from the footer — always visible regardless of session state.**

Not a sidebar panel. The sidebar only renders when connected, and privacy
controls should be reachable even on the splash screen. The footer is always
visible; a link there reaches the widest set of situations.

Footer link text: **"Storage & Privacy"**

This sits next to the existing "About" link:
```
Bucketer — About — Storage & Privacy — Copyright © 2026 HidayahTech, LLC
```

The modal is triggered by `setStorageOpen(true)` in App.jsx, alongside the
existing `changelogOpen` and `aboutOpen` state variables. It renders
`<StorageModal onClose={...} />` conditionally at the top of the App render.

**Why not the sidebar?**

- Sidebar is only rendered in the connected state
- Debug/privacy actions are most urgent when something is broken (pre-connect)
- Keeps the sidebar focused on connection settings rather than meta-tooling
- Avoids making the sidebar longer for most users who never need this

---

## Modal Structure

The modal follows the existing `AboutModal` / `ChangelogModal` pattern:

```
┌─────────────────────────────────────────────────┐
│  Storage & Privacy                          [✕]  │
│─────────────────────────────────────────────────│
│  [Section: Connection] ───────────────────────  │
│  [Section: Profiles] ─────────────────────────  │
│  [Section: Upload History] ───────────────────  │
│  [Section: Settings] ─────────────────────────  │
│  [Section: Runtime State] ────────────────────  │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │  ⚠ Clear All App Data                   │   │
│  │  [explanation text]     [Clear everything]│  │
│  └─────────────────────────────────────────┘   │
│                                    [Close]       │
└─────────────────────────────────────────────────┘
```

**Dimensions:** 560px max-width (wider than About's 480px to accommodate tables).
**Max-height:** 82vh with `overflow-y: auto` on the body div.
**Escape key:** closes the modal (same pattern as other modals).

---

## Sections

Each section is a collapsible `<details>` block with `open` by default on first
render. The user can collapse sections they don't care about. Sections that
contain no data are still shown (with an empty-state message) so the user can
confirm nothing is stored there.

### 1. Connection

**Displays:**
- Endpoint URL (`s3b_endpoint`)
- Bucket (`s3b_bucket`)
- Key ID (`s3b_key_id`)
- Provider (`s3b_provider`)
- Region override (`s3b_region_override`)
- Secret key status: `s3b_secret_key` is shown as **"Present (session only)"**
  or **"Not stored"** — the actual value is never displayed, only its presence

**Empty state:** "No connection data stored."

**Clear action:** **"Clear connection"** button — calls `clearCredentials()` and
reloads the section. If the app is currently connected, shows a warning:
"This will disconnect you."

**Design rationale for secret key display:** The secret key should never be shown
in plaintext, even inside the app. Showing "Present (session only)" confirms the
value is there (or not) without creating a visual attack surface. A shoulder-
surfer or screenshot cannot steal the key from this view.

---

### 2. Profiles

**Displays:**
A table of all saved profiles, one row per profile:

| Name | Endpoint | Bucket | Key ID | Provider |
|---|---|---|---|---|
| B2 — my-photos | https://s3.us-west-004... | my-photos | 000a87... | b2 |

Endpoint and Key ID are truncated to 28 chars with ellipsis. Full values shown
in `title` attribute (tooltip on hover).

Below the table: total count and storage size estimate.

**Empty state:** "No saved profiles."

**Per-profile action:** Each row has a **"Delete"** button (matches the existing
profile-row-delete pattern from `ProfilePicker`).

**Section clear action:** **"Delete all profiles"** button, with confirmation:
"This will remove all N saved profiles. Your secret key is not stored in
profiles — only connection details. This cannot be undone."

---

### 3. Upload History

**Displays:**
Summary line: `N uploads · X failed · last activity: RELATIVE_TIME`

Then the existing `UploadLog` table, or a condensed version of it. The full
`UploadLog` component already exists — the Storage Viewer can simply embed it
or render the same table structure with the same data.

**Empty state:** "No upload history."

**Clear action:** **"Clear history"** button — calls `clearUploadLog()`. Same
button as exists in the `UploadLog` component. The storage viewer can reuse the
same function; no new logic required.

---

### 4. Multipart Resume Records

**Displays:**
Active resume records from `s3browser_uploads`, one row per record:

| Destination | Bucket | Provider | Started | Size |
|---|---|---|---|---|
| uploads/large-file.zip | my-bucket | b2 | 3 hours ago | 2.4 GB |

**Empty state:** "No incomplete uploads being tracked." (The common case — these
are cleaned up when uploads complete.)

**Per-record action:** **"Discard"** button — calls `deleteResumeRecord()` for
that record. Warning: "Discarding this record means you cannot resume this
upload. The in-progress multipart session on the server may need to be cleaned
up manually." (Only shown if the record's UploadId is present.)

**Section clear action:** **"Discard all resume records"** button.

---

### 5. Settings

**Displays:**
A two-column table of all current setting values:

| Setting | Value |
|---|---|
| Max keys per listing | 200 |
| Part concurrency | 4 |
| Part size (MB) | 16 |
| File concurrency | 3 |
| Listing cache TTL | 120 s |
| Background update check | Enabled |

Values shown as-read from storage (defaulting to `—` for not set).

**Empty state / all defaults:** Shown as a table with "— (default)" for each
unset value.

**Clear action:** **"Reset settings to defaults"** button — removes the six
settings keys from localStorage. No app state is harmed; the app will simply
read defaults on the next render.

---

### 6. Runtime State

**Displays:**
- Capability state (`s3b_capabilities`): four rows, one per operation, with
  icon (✓ / ✕ / ?) and label ("Permitted", "Denied", "Unknown")
- Active uploads tracker (`s3b_active_uploads`): number of in-flight upload
  slots currently registered. In normal operation this is 0 when no uploads
  are running.

**Empty state:** Capabilities show all "Unknown" (default state). Active
uploads shows 0.

**Clear actions:**
- **"Reset capabilities"** — calls `clearCapabilities()`. Safe to do at any
  time; the app will re-probe on the next operation.
- **"Clear active uploads tracker"** — removes `s3b_active_uploads`. Only
  useful if the tracker is stuck due to a crashed tab.

---

## "Clear All App Data" Panel

A visually distinct block at the bottom of the modal body, below all sections.
Uses a warning-coloured border (`var(--warn-bg)` / `var(--danger)`) to signal
its severity.

```
┌─────────────────────────────────────────────────────┐
│  ⚠  Remove all Bucketer data from this browser      │
│                                                     │
│  This removes every key Bucketer has written to     │
│  localStorage, sessionStorage, and IndexedDB:       │
│                                                     │
│  • Connection details and credentials               │
│  • All saved profiles                               │
│  • Upload history and resume records                │
│  • All settings                                     │
│  • Capability state and transient trackers          │
│                                                     │
│  After clearing, the app reloads to a fresh state.  │
│  Your files on the storage provider are untouched.  │
│                                                     │
│            [Cancel]  [Clear everything →]           │
└─────────────────────────────────────────────────────┘
```

"Clear everything" button: `btn btn-danger`.

**Confirmation flow:** The button triggers an inline confirmation (no separate
modal): the button is replaced by a second "Are you sure?" row with
**"Yes, clear everything"** and **"Cancel"** buttons. This is a single-level
confirmation — the action is reversible only by re-entering credentials, which
users are accustomed to doing.

**What happens after clear:** The function `wipeAllAppData()` (new, described
below) is called, then `window.location.reload()` to return the app to a clean
slate. The reload is necessary because several pieces of state (credentials,
profiles, session) are held in component memory and cannot be reset without
remounting.

---

## Implementation Plan

### New function: `wipeAllAppData()` in `src/lib/storage.js`

```js
export async function wipeAllAppData() {
  // localStorage: all s3b_* keys
  const knownKeys = [
    ...Object.values(LS_KEYS),
    LS_KEY_PROFILES,
    LS_KEY_LAST_PROFILE_ID,
    's3b_active_uploads',
  ];
  knownKeys.forEach(k => safeRemove(localStorage, k));

  // sessionStorage
  safeRemove(sessionStorage, SS_KEY_SECRET);
  safeRemove(sessionStorage, 's3b_file_banner_dismissed');

  // IndexedDB: delete the entire database
  await deleteDatabase();
}

async function deleteDatabase() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;   // best-effort: don't throw on failure
    req.onblocked = resolve; // another tab has the DB open — proceed anyway
  });
}
```

`wipeAllAppData()` is the only function that deletes the IndexedDB database
entirely (vs. clearing individual stores). The existing `clearUploadLog()` and
`deleteResumeRecord()` functions clear records but leave the database open.
Calling `indexedDB.deleteDatabase()` is the correct way to fully remove all
traces of the IndexedDB.

**Note on `onblocked`:** If another Bucketer tab has the database open,
`deleteDatabase` will block until that tab closes. For simplicity, resolve
immediately on `onblocked` rather than waiting. The database will be deleted
when the last tab holding it closes, which is fine for the "wipe" use case.

### New component: `src/components/StorageModal.jsx`

Props:
```js
function StorageModal({ onClose })
```

Internal state:
```js
const [lsData, setLsData] = useState({});            // raw localStorage snapshot
const [profiles, setProfiles] = useState([]);
const [uploadLog, setUploadLog] = useState([]);
const [resumeRecords, setResumeRecords] = useState([]);
const [confirmWipe, setConfirmWipe] = useState(false);
```

On mount, the component reads all storage and populates these state variables.
A **"Refresh"** button at the top re-reads all storage and re-populates state
(useful if the user performs an action in another panel and wants to see the
updated values).

### App.jsx wiring

```jsx
const [storageOpen, setStorageOpen] = useState(false);

// In render:
{storageOpen && <StorageModal onClose={() => setStorageOpen(false)} />}

// In footer:
<button class="footer-link-btn" onClick={() => setStorageOpen(true)}>
  Storage & Privacy
</button>
```

No new state management beyond a single boolean.

---

## Data Display Conventions

**Sensitive fields:**
- `s3b_secret_key`: always shown as status text only, never value
- `s3b_key_id`: shown truncated to first 8 + `…` — enough to identify which key
  without being a full disclosure risk in a screenshot
- Profile `keyId` fields: same truncation

**Timestamps:** displayed as both relative ("3 hours ago") and absolute
(ISO 8601 on hover via `title` attribute)

**Byte sizes:** formatted with `formatBytes()` (already exists in `src/lib/format.js`)

**Long strings:** truncated with CSS `text-overflow: ellipsis` at `max-width: 28ch`,
full value in `title` attribute

**JSON fields:** not shown raw; each field is decoded into a human-readable row

**Empty / unset values:** shown as `—` (em dash) in grey (`var(--text-muted)`)

---

## Edge Cases

**Private browsing mode:** All localStorage writes throw silently in some private
browsing implementations. The storage viewer should handle the case where all
reads return empty and display a note: "Storage may not be available in private
browsing mode. The values shown reflect what could be read."

**IndexedDB unavailable:** `openDB()` may fail (e.g. in some sandboxed contexts).
Wrap the IndexedDB reads in try/catch; show an inline error for the affected
sections ("Could not read IndexedDB — may not be available in this context.")
rather than crashing the modal.

**Active session:** If the user clears credentials or wipes all data while
connected, the app will be in an inconsistent state (in-memory credentials still
live but storage is gone). The clear actions that affect credentials should:
1. Show a warning if connected: "You are currently connected. Clearing this will
   disconnect you."
2. Call `handleDisconnect()` after clearing (passed as a prop or via a callback).

Alternatively, both credential-clear and wipe-all end with a `window.location.reload()`,
which is clean and eliminates all consistency concerns. Document whichever
approach is chosen.

**Multiple tabs:** If two tabs have Bucketer open and one wipes all data, the
other tab's in-memory state is unaffected but any attempt to save to localStorage
will succeed (the keys will simply be recreated). This is acceptable — there is
no cross-tab coordination mechanism for privacy operations.

---

## What "Clear All App Data" Covers

For full transparency in the UI copy and in code documentation:

| Item | Cleared | Notes |
|---|---|---|
| Endpoint URL | Yes | |
| Bucket name | Yes | |
| Key ID | Yes | |
| Secret key | Yes | Already cleared on tab close |
| Provider hint | Yes | |
| Region override | Yes | |
| Saved profiles | Yes | All N profiles deleted |
| Last selected profile | Yes | |
| Upload history | Yes | All N log entries deleted |
| Resume records | Yes | In-progress uploads cannot be resumed |
| Settings | Yes | All revert to defaults |
| Capabilities state | Yes | |
| Active uploads tracker | Yes | |
| FileBanner dismiss | Yes | Banner will show again on reload |
| In-memory listing cache | N/A | Already gone (in-memory only) |
| Files on storage provider | **No** | App data only; S3 objects untouched |
| Browser history / cookies | **No** | App does not use cookies |
| Auth sessions / accounts | **No** | App has no accounts |

The last three rows are important to call out in the UI so users understand the
scope: this clears what the **app** stored, not anything the user uploaded.

---

## Scope Note: What This Design Does Not Include

- **Export:** Downloading a JSON export of all stored data. Useful but out of
  scope for this feature.
- **Import:** Re-importing a data export. Out of scope.
- **Fine-grained profile editing:** Profiles can be deleted from this view but
  editing their fields remains in the ProfilePicker component.
- **Live updates:** The modal reads storage at open time and on explicit refresh.
  It does not subscribe to storage change events (localStorage `storage` event).
  This is intentional — the viewer is a point-in-time debugger, not a reactive
  dashboard.
