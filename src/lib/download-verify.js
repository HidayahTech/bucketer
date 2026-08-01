// Copyright (C) 2026 HidayahTech, LLC
// Read-only confirmation of what actually landed in the destination folder.
//
// WHY THIS EXISTS. The browser-managed tier hands a URL to the download manager and can
// observe only that it issued it — never bytes, completion, or failure. Every item's
// terminal state is therefore ISSUED, not DONE. Reading the folder afterwards is the only
// mechanism that can promote one to DONE, and it costs zero requests: no GET, no HEAD, no
// egress.
//
// WHY NAME ALONE IS NOT ENOUGH. A file called a.txt sitting in Downloads is not proof that
// OUR a.txt is the one there — it may predate the job entirely. Size is recorded at
// enumeration and `FileSystemFileHandle.getFile()` exposes it read-only, so name AND size
// is a materially stronger claim for no extra cost. A truncated transfer leaves the right
// name and the wrong size; calling that DONE is exactly the lie this feature prevents.
//
// WHAT IT REFUSES TO CLAIM. Flatten mode can map two keys onto one local name, and the
// browser silently renames collisions to "a (1).txt" without telling the page. Neither
// case is attributable to a specific download, so neither is ever confirmed — they are
// reported as their own outcomes so the user knows the difference between "not there" and
// "cannot tell". A collision-renamed variant only counts as "probably ours" when its SIZE
// matches too: the user's own unrelated "report (1).pdf" must not silence a genuinely
// missing report.pdf (postmortem catalog defect 20).
//
// MEMORY. A job can hold a million items and this module must never materialise them
// (BUG-021's rule, stated in download-records.js). Items are walked in key-ordered pages;
// each item's file is looked up directly by name (O(1)); the one full folder pass retains
// only collision-suffixed names, bounded by how many files the browser actually renamed.

import {
  loadJob, updateJob, updateItem, takeItemsPage, countItemsByLocalName,
  ITEM_STATUS, JOB_STATUS,
} from './download-records.js';

const VERIFY_PAGE = 500;

// "a (1).txt" -> "a.txt". Chromium's collision suffix goes before the extension; a name
// with no extension gets "a (1)". Anything not matching that shape is returned unchanged.
export function collisionBase(name) {
  const withExt = /^(.*) \(\d+\)(\.[^.]*)$/.exec(name);
  if (withExt) return `${withExt[1]}${withExt[2]}`;
  const noExt = /^(.*) \(\d+\)$/.exec(name);
  return noExt ? noExt[1] : name;
}

// matchDownloads(items, filesOnDisk) — the PURE reference implementation of the verdict
// logic, for tests and small inputs. verifyJob below is the streaming implementation the
// browser path uses; the two must agree on verdicts.
//
//   items       — [{ key, localName, size }] as recorded at enumeration
//   filesOnDisk — Map<name, sizeInBytes> read from the chosen folder
//
// Returns { confirmed, missing, mismatched, ambiguous, renamed } — arrays of item keys,
// except `mismatched`, which carries the sizes so the UI can say what it saw.
export function matchDownloads(items, filesOnDisk) {
  const claims = new Map();
  for (const it of items) claims.set(it.localName, (claims.get(it.localName) || 0) + 1);

  // Collision-renamed variants on disk, base name -> size of the variant.
  const renamedBySize = new Map();
  for (const [name, size] of filesOnDisk) {
    const base = collisionBase(name);
    if (base !== name) renamedBySize.set(base, size);
  }

  const out = { confirmed: [], missing: [], mismatched: [], ambiguous: [], renamed: [] };

  for (const it of items) {
    if (claims.get(it.localName) > 1) { out.ambiguous.push(it.key); continue; }

    if (!filesOnDisk.has(it.localName)) {
      // Absent under its own name, but a collision variant of the right SIZE exists: the
      // file very likely arrived and was renamed by the browser. A variant of a different
      // size is somebody else's file, and the item is genuinely missing.
      if (renamedBySize.get(it.localName) === it.size) out.renamed.push(it.key);
      else out.missing.push(it.key);
      continue;
    }

    const actual = filesOnDisk.get(it.localName);
    if (actual === it.size) out.confirmed.push(it.key);
    else out.mismatched.push({ key: it.key, expected: it.size, actual });
  }

  return out;
}

// verifyJob(jobId, dirHandle) -> { confirmed, missing, mismatched, ambiguous, renamed }
//
// Turns one folder reading into durable status changes, and only ever examines items
// still ISSUED — a previous verification's DONE items are never re-examined or
// downgraded. Re-verification is always allowed: `verifiedAt` and the summary are
// recorded on the job as information, never used to gate anything (postmortem F3).
//
// WHAT IT MARKS FAILED IS WHAT A RESUME WILL RETRY. A file that is absent, or present at
// the wrong size, provably did not arrive: marking it FAILED lets the resume path
// re-issue exactly those. And because failures must actually be reachable, a DONE job
// that gains failures here is demoted to PAUSED — the classifier then lists it as
// unfinished, which is the whole point (the old code left it DONE, and DONE was excluded
// from every list: the retry this comment promises was unreachable).
//
// Ambiguous and renamed items are *unknown*, not absent — retrying them would re-download
// something already on disk and bill the user egress for the privilege. They stay ISSUED,
// and stay re-checkable forever.
export async function verifyJob(jobId, dirHandle) {
  // One streaming pass over the folder, retaining ONLY collision-renamed names.
  const renamedBySize = new Map();
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    const base = collisionBase(entry.name);
    if (base === entry.name) continue;
    try { renamedBySize.set(base, (await entry.getFile()).size); }
    catch { /* unreadable entry — treat as not present */ }
  }

  const counts = { confirmed: 0, missing: 0, mismatched: 0, ambiguous: 0, renamed: 0 };

  // Key-ordered pages: stable under the status updates this loop itself makes.
  let afterKey = null;
  for (;;) {
    const page = await takeItemsPage(jobId, afterKey, VERIFY_PAGE);
    if (page.length === 0) break;
    afterKey = page[page.length - 1].key;

    for (const it of page) {
      if (it.status !== ITEM_STATUS.ISSUED) continue;

      if (await countItemsByLocalName(jobId, it.localName) > 1) {
        counts.ambiguous += 1;
        continue;
      }

      let size = null;
      try {
        const handle = await dirHandle.getFileHandle(it.localName);
        size = (await handle.getFile()).size;
      } catch { /* not found or unreadable — absent */ }

      if (size === null) {
        if (renamedBySize.get(it.localName) === it.size) {
          counts.renamed += 1;
        } else {
          counts.missing += 1;
          await updateItem(jobId, it.key, {
            status: ITEM_STATUS.FAILED, error: 'Not found in the folder you chose.',
          });
        }
      } else if (size === it.size) {
        counts.confirmed += 1;
        await updateItem(jobId, it.key, { status: ITEM_STATUS.DONE, verifiedAt: Date.now() });
      } else {
        counts.mismatched += 1;
        await updateItem(jobId, it.key, {
          status: ITEM_STATUS.FAILED,
          error: `Wrong size on disk — expected ${it.size} bytes, found ${size}.`,
        });
      }
    }
  }

  const job = await loadJob(jobId);
  if (job) {
    const failuresFound = counts.missing + counts.mismatched > 0;
    await updateJob(jobId, {
      verifiedAt: Date.now(),
      lastVerify: { ...counts, at: Date.now() },
      // Failures must be resumable, and only non-DONE jobs are listed as unfinished.
      ...(failuresFound && job.status === JOB_STATUS.DONE ? { status: JOB_STATUS.PAUSED } : {}),
    });
  }

  return counts;
}
