// Copyright (C) 2026 HidayahTech, LLC
// Read-only confirmation of what actually landed in the destination folder.
//
// WHY THIS EXISTS. The browser-managed tier hands a URL to the download manager and can
// observe only that it issued it — never bytes, completion, or failure. Every item's
// terminal state is therefore ISSUED, not DONE. Reading the folder afterwards is the only
// mechanism that can promote one to DONE, and it costs zero requests: no GET, no HEAD, no
// egress. It is strictly better than pre-flighting every key, which still cannot promise
// the download that follows it succeeds.
//
// WHY NAME ALONE IS NOT ENOUGH. A file called a.txt sitting in Downloads is not proof that
// OUR a.txt is the one there — it may predate the job entirely. Size is recorded at
// enumeration and `FileSystemFileHandle.getFile()` exposes it read-only, so name AND size
// is a materially stronger claim for no extra cost. A truncated transfer leaves the right
// name and the wrong size; calling that DONE is exactly the lie this feature prevents.
//
// WHAT IT REFUSES TO CLAIM. Flatten mode can map two keys onto one local name, and the
// browser silently renames collisions to "a (1).txt" without telling the page. Neither case
// is attributable to a specific download, so neither is ever confirmed — they are reported
// as their own outcomes so the user knows the difference between "not there" and
// "cannot tell".

import {
  loadJob, saveJob, updateItem, eachItemByStatus, ITEM_STATUS,
} from './download-records.js';

export const VERIFY = {
  CONFIRMED:  'confirmed',
  MISSING:    'missing',
  MISMATCHED: 'mismatched',
  AMBIGUOUS:  'ambiguous',
  RENAMED:    'renamed',
};

// "a (1).txt" -> "a.txt". Chromium's collision suffix goes before the extension; a name
// with no extension gets "a (1)". Anything not matching that shape is returned unchanged.
function collisionBase(name) {
  const withExt = /^(.*) \(\d+\)(\.[^.]*)$/.exec(name);
  if (withExt) return `${withExt[1]}${withExt[2]}`;
  const noExt = /^(.*) \(\d+\)$/.exec(name);
  return noExt ? noExt[1] : name;
}

// readFolder(dirHandle) -> Map<name, sizeInBytes>
//
// Kept separate from matchDownloads so the matching stays pure and testable without any
// browser API. The handle comes from showDirectoryPicker(), which requires a user gesture —
// which is why verification is a button the user presses and never something automatic.
//
// Subdirectories are not descended: this tier delivers a flat list into one folder, and a
// real Downloads directory is full of unrelated trees that would cost time and confirm
// nothing. One unreadable entry is skipped rather than abandoning the whole read — a single
// permission-denied file must not cost the user the verification of everything else.
export async function readFolder(dirHandle) {
  const out = new Map();
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    try {
      const file = await entry.getFile();
      out.set(entry.name, file.size);
    } catch { /* unreadable entry — skip it, keep the rest */ }
  }
  return out;
}

// matchDownloads(items, filesOnDisk)
//   items       — [{ key, localName, size }] as recorded at enumeration
//   filesOnDisk — Map<name, sizeInBytes> read from the chosen folder
//
// Returns { confirmed, missing, mismatched, ambiguous, renamed } — arrays of item keys,
// except `mismatched`, which carries the sizes so the UI can say what it saw.
export function matchDownloads(items, filesOnDisk) {
  // A local name claimed by more than one item can never be attributed, however many
  // files are on disk. Counted first so those items are excluded from every other verdict.
  const claims = new Map();
  for (const it of items) claims.set(it.localName, (claims.get(it.localName) || 0) + 1);

  // Collision-renamed variants, indexed by the name they were derived from.
  const renamedBases = new Set();
  for (const name of filesOnDisk.keys()) {
    const base = collisionBase(name);
    if (base !== name) renamedBases.add(base);
  }

  const out = { confirmed: [], missing: [], mismatched: [], ambiguous: [], renamed: [] };

  for (const it of items) {
    if (claims.get(it.localName) > 1) { out.ambiguous.push(it.key); continue; }

    if (!filesOnDisk.has(it.localName)) {
      // Absent under its own name, but a collision variant of it exists: the file very
      // likely arrived and was renamed by the browser. Reporting it plainly missing would
      // send the user hunting for something already on disk.
      if (renamedBases.has(it.localName)) out.renamed.push(it.key);
      else out.missing.push(it.key);
      continue;
    }

    const actual = filesOnDisk.get(it.localName);
    if (actual === it.size) out.confirmed.push(it.key);
    else out.mismatched.push({ key: it.key, expected: it.size, actual });
  }

  return out;
}

// verifyJob(jobId, filesOnDisk) -> { confirmed, missing, mismatched, ambiguous, renamed }
//
// Turns one folder reading into durable status changes, and only ever examines items still
// ISSUED — a previous verification's DONE items are never re-examined or downgraded.
//
// WHAT IT MARKS FAILED IS WHAT A RESUME WILL RETRY, which is the whole reason the verdicts
// are kept separate. A file that is absent, or present at the wrong size, provably did not
// arrive: marking it FAILED lets the existing resume path re-issue exactly those, and
// nothing else. A file that is ambiguous or collision-renamed is *unknown*, not absent —
// retrying it would re-download something already sitting on disk and bill the user egress
// for the privilege. Unknown is therefore left strictly alone.
export async function verifyJob(jobId, filesOnDisk) {
  const items = [];
  await eachItemByStatus(jobId, ITEM_STATUS.ISSUED, it => { items.push(it); });

  const result = matchDownloads(items, filesOnDisk);

  for (const key of result.confirmed) {
    await updateItem(jobId, key, { status: ITEM_STATUS.DONE, verifiedAt: Date.now() });
  }
  for (const key of result.missing) {
    await updateItem(jobId, key, { status: ITEM_STATUS.FAILED, error: 'Not found in the folder you chose.' });
  }
  for (const m of result.mismatched) {
    await updateItem(jobId, m.key, {
      status: ITEM_STATUS.FAILED,
      error: `Wrong size on disk — expected ${m.expected} bytes, found ${m.actual}.`,
    });
  }

  // Recorded so a verified job stops being offered for verification. Failures it found are
  // still resumable; this only says the check has been run.
  const job = await loadJob(jobId);
  if (job) await saveJob({ ...job, verifiedAt: Date.now() });

  return {
    confirmed:  result.confirmed.length,
    missing:    result.missing.length,
    mismatched: result.mismatched.length,
    ambiguous:  result.ambiguous.length,
    renamed:    result.renamed.length,
  };
}
