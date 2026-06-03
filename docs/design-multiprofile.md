<!-- Implementation plan: multi-profile credential management
     Status: APPROVED, ready to implement
     Target version: 1.13.0
     Captured 2026-06-02 — use this to resume if context is lost mid-implementation. -->

# Multi-Profile Implementation Plan

## Background and motivation

Current state: Bucketer stores one set of credentials in localStorage as flat keys
(`s3b_endpoint`, `s3b_bucket`, `s3b_key_id`, `s3b_provider`, `s3b_region_override`).
There is no concept of a "profile" — just one form's worth of fields.

Immediate need: testing Bucketer against multiple S3-compatible backends (B2, R2,
Wasabi, AWS S3, MinIO, etc.) without re-typing endpoint URLs and Key IDs each session.

Medium-term: personal multi-account convenience.

Long-term: end-user feature, potentially with encrypted secret key persistence and
export/import. Those are deliberately deferred but the architecture must not make
them hard to add.

## What is in scope for 1.13.0

- Named profile storage (N profiles, no secret keys persisted)
- Profile picker UI on the splash/connect screen
- "Save as profile" explicit action (not auto-save)
- Delete profile
- Silent migration of existing flat localStorage credentials into a default profile
- Current profile name shown in connected sidebar
- Block profile switch while upload queue is active

## What is explicitly deferred (but must not be made harder)

- Profile editing (rename, change endpoint) — delete and re-add for now
- Profile reordering
- Export/import profiles (see docs/design-encrypted-share-links.md for related future work)
- Encrypted secret key persistence (Web Crypto API approach)
- Multiple simultaneously connected accounts
- Profile management in a dedicated modal or settings panel

---

## Data model

### Profile object schema

```js
{
  id: 1748892000000,          // Date.now() at creation — stable identifier
  name: 'B2 — test-bucket',   // user-defined display name
  endpoint: 'https://...',
  bucket: 'my-bucket',
  keyId: 'my-key-id',
  provider: 'b2',             // PROVIDERS constant value or null
  regionOverride: '',         // empty string if not set
}
```

Secret key is NEVER stored in a profile. It remains sessionStorage-only, entered
fresh each session. This is unchanged from the current security model.

### localStorage envelope

Stored under key `s3b_profiles` as JSON:

```js
{
  version: 1,
  profiles: [ /* array of profile objects, ordered by creation */ ]
}
```

The `version` field enables future schema migration without heuristic detection.
A separate key `s3b_last_profile_id` stores the ID of the last-used profile so
the picker pre-selects it on load.

### Tolerant loading invariant

`loadProfiles()` must handle all of: missing key, invalid JSON, missing fields on
individual profiles, and — critically — UNKNOWN fields on profile objects. Unknown
fields must survive the load/save round-trip unchanged (use spread copy, never
destructure-and-reconstruct). This preserves forward compatibility when future
fields (e.g. `secretKeyEncrypted`) are added by a newer version.

---

## Storage layer (src/lib/storage.js)

New keys to add to `LS_KEYS`:
```js
profiles:       's3b_profiles',
lastProfileId:  's3b_last_profile_id',
```

New functions to add:

```
loadProfiles()         → { version, profiles } with safe defaults on any error
saveProfiles(data)     → writes { version: 1, profiles } envelope
saveProfile(profile)   → upsert by id (replace if exists, append if new)
deleteProfile(id)      → remove by id, re-save
loadLastProfileId()    → string | null
saveLastProfileId(id)  → void
migrateProfilesFromLegacy() → idempotent; reads flat keys, creates profile named
                              "${providerLabel} — ${bucket}" or "Default",
                              writes to s3b_profiles, does nothing if profiles
                              already exist. Safe to call on every mount.
```

`saveProfile` is the key primitive — one function handles both create and update
by ID. This is the right interface for future export/import (which is just
"saveProfile for each item in the imported array").

---

## Component: ProfilePicker (new — src/components/ProfilePicker.jsx)

Pure presentational component — takes all data as props, no direct storage reads.
App.jsx holds profiles in state and passes them down.

Props:
```js
{
  profiles,           // array of profile objects
  selectedId,         // currently highlighted profile id | null
  onSelect(id),       // user clicked a profile row
  onDelete(id),       // user clicked delete on a profile row
  onSave(name),       // user confirmed "save as profile" with a given name
  currentFormData,    // { endpoint, bucket, provider } — used to generate default name
}
```

Renders:
- Nothing if profiles.length === 0 (invisible to first-time users)
- Section heading "Saved profiles" + compact list when profiles exist
- Each row: display name, provider hint, delete button (✕)
- "Save current as profile…" link/button below the list (or above the form)
  that expands inline to a name input + confirm button
- Selected profile row is visually highlighted

Design note: list, not dropdown. There won't be more than ~10 profiles for the
foreseeable use case. Lists are more scannable and easier to add delete actions to.

Defensively: the component is designed to be renderable anywhere — splash screen
now, sidebar later, export/import modal in the future. No internal state tied to
its position in the tree.

---

## App.jsx changes

### New state
```js
const [profiles, setProfiles] = useState(() => loadProfiles().profiles);
const [selectedProfileId, setSelectedProfileId] = useState(() => loadLastProfileId());
```

### Migration on mount
Call `migrateProfilesFromLegacy()` before reading profiles, inside the existing
`useEffect([], [])` that also handles auto-connect. After migration, reload profiles
from storage into state. Idempotent — safe every mount.

### Profile selection handler
```js
function handleSelectProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) return;
  setSelectedProfileId(id);
  saveLastProfileId(id);
  setCredentials({ ...profile, secretKey: '' }); // pre-fill form, clear secret key
}
```

### Profile save handler
```js
function handleSaveProfile(name) {
  const profile = {
    id: Date.now(),
    name,
    endpoint: credentials.endpoint,
    bucket: credentials.bucket,
    keyId: credentials.keyId,
    provider: credentials.provider,
    regionOverride: credentials.regionOverride,
  };
  saveProfile(profile);
  setProfiles(loadProfiles().profiles);
  setSelectedProfileId(profile.id);
  saveLastProfileId(profile.id);
}
```

### Profile delete handler
```js
function handleDeleteProfile(id) {
  deleteProfile(id);
  setProfiles(loadProfiles().profiles);
  if (selectedProfileId === id) {
    setSelectedProfileId(null);
    saveLastProfileId(null);
  }
}
```

### CredentialForm key prop
The CredentialForm uses lazy useState initialisation that only runs on mount.
To re-initialise it when a profile is selected, pass a key prop:

```jsx
<CredentialForm
  key={selectedProfileId ?? 'manual'}
  initial={credentials}
  onSave={handleConnect}
  loading={session === 'connecting'}
/>
```

When `selectedProfileId` changes, the key changes, CredentialForm remounts,
and lazy initialisation runs with the new credentials. No changes to CredentialForm
internals required.

### ProfilePicker placement in splash view
Between the "Connect to a bucket" heading and the CredentialForm:

```jsx
<h2>Connect to a bucket</h2>
<ProfilePicker
  profiles={profiles}
  selectedId={selectedProfileId}
  onSelect={handleSelectProfile}
  onDelete={handleDeleteProfile}
  onSave={handleSaveProfile}
  currentFormData={credentials}
/>
{/* url params banner */}
<CredentialForm key={selectedProfileId ?? 'manual'} ... />
```

### Current profile name in connected sidebar
Above the CredentialForm in the sidebar, if `selectedProfileId` is set:

```jsx
{selectedProfileId && profiles.find(p => p.id === selectedProfileId) && (
  <div class="profile-active-name">
    {profiles.find(p => p.id === selectedProfileId).name}
  </div>
)}
```

### Profile switch while connected
In the connected state, switching profiles requires disconnecting first. The
handleSelectProfile handler should be wrapped to check for active uploads:

```js
function handleSelectProfile(id) {
  if (session === 'connected') {
    const hasActive = /* check upload queue via ref */;
    if (hasActive) {
      // show warning — don't switch
      return;
    }
    handleDisconnect();
  }
  // ... rest of selection logic
}
```

For the first iteration, the sidebar does not expose a profile picker — switching
profiles while connected means the user manually disconnects and the splash picker
is used. The profile name display in the sidebar is read-only for now.

---

## CSS additions (src/styles/main.css)

New classes needed:
```
.profile-picker          — container for the profile section on splash
.profile-picker-heading  — "Saved profiles" label (same style as splash-info-heading)
.profile-list            — ul/div containing profile rows
.profile-row             — individual profile entry (flex, space-between)
.profile-row-name        — display name
.profile-row-hint        — provider + bucket hint (muted, small)
.profile-row-selected    — highlighted state
.profile-row-delete      — ✕ button (ghost, danger color on hover)
.profile-save-form       — inline name input + confirm area
.profile-active-name     — current profile indicator in connected sidebar
```

---

## Version bump

Target version: 1.13.0

This is a MINOR bump (new feature, backward compatible, existing credentials
migrated silently). All prior 1.12.x patch increments were correct for their scope.
Going forward, user-visible feature additions = MINOR, fixes/docs/build = PATCH.

CHANGELOG entry to write before final build:
```
## [1.13.0] — 2026-06-02 — Multi-profile credential management

- Add named profile storage: save N connection profiles (endpoint, bucket, key ID,
  provider) to localStorage; secret key is never stored
- Profile picker on connect screen: select a saved profile to pre-fill the form
- "Save as profile" explicit action with user-defined display name
- Delete profile from picker
- Silent migration: existing credentials become a named default profile on first load
- Current profile name shown in connected sidebar
- Profile switching blocked while upload queue has active items
- Storage layer: versioned envelope, upsert primitive, tolerant loading (unknown
  fields preserved for forward compatibility)
```

---

## Implementation order

1. `src/lib/storage.js` — profile CRUD + migration (everything else depends on this)
2. `src/components/ProfilePicker.jsx` — new component (pure presentational)
3. `src/styles/main.css` — new CSS classes for ProfilePicker
4. `src/components/App.jsx` — state, handlers, wiring, key prop on CredentialForm
5. Build, test, manual verification
6. Bump version (1.12.24 → 1.13.0), write CHANGELOG entry, commit, push

No changes required to: CredentialForm internals, UploadQueue, Browser, any lib
module other than storage.js.

---

## Defensive coding checklist (things that make deferred features easier)

- [ ] Storage envelope has `version: 1` field
- [ ] `saveProfile` is an upsert (handles both create and update by ID)
- [ ] `loadProfiles` preserves unknown fields on round-trip (spread copy only)
- [ ] `migrateProfilesFromLegacy` is a named, standalone, idempotent function
- [ ] ProfilePicker takes all data as props (no internal storage reads)
- [ ] `currentProfileId` is nullable App state (not a ref or local variable)
- [ ] Profile IDs are stable opaque values (Date.now() — survive export/import)
- [ ] Profiles stored as ordered array (enables future reordering without schema change)
- [ ] No empty/null placeholder fields added for unimplemented features
