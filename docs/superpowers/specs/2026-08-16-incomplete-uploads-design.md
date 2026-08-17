# Incomplete uploads — discovery & cleanup panel

**Date:** 2026-08-16
**Status:** approved. The deferred `ListMultipartUploads` slice from the move-resume design.

## Problem

An interrupted multipart operation (a move's server-side copy, or an upload) can leave an
incomplete multipart upload on the server — occupying billable storage until a lifecycle rule
or provider auto-expiry clears it. Bucketer could not see these: v1.53.0 resumes only uploads
it has a *record* for (written at start), so record-less orphans — pre-1.53.0 moves, a tab that
crashed before the first record write, or uploads from other tools — were invisible.

## Goal

An on-demand "Incomplete uploads" panel: scan the bucket (via `ListMultipartUploads`), list the
incomplete uploads Bucketer isn't already tracking, and let the user **Discard** each (abort →
reclaim storage), individually or all at once.

## Non-goals

- **Resuming** a record-less orphan. Resuming a *move* needs the source→destination mapping,
  which lives only in a move-job record; the server listing gives only the destination key. So
  orphans are discard-only. Record-backed uploads keep surfacing as paused Resume rows (v1.53.0),
  and the panel deliberately excludes them — no duplicate resume UI.

## Discovery — `multipart-uploads.js`

- `listIncompleteUploads(client, bucket, prefix)` — paginate `ListMultipartUploadsCommand`
  (Prefix scoped to the connection's base folder if the key is prefix-scoped), returning
  `[{ key, uploadId, initiated }]`.
- `classifyIncompleteUploads(uploads, moveJobs)` — pure. Tags each upload with
  `{ moveJobId, resumable }` by matching its `uploadId` against every move-job record's
  `inflightUploads`. `resumable: true` ones are already paused rows; the panel shows the rest.
- Discard reuses `abortMultipartSession` (upload-cleanup.js): `AbortMultipartUpload(bucket, key,
  uploadId)`.

## Surfacing — `IncompleteUploadsModal.jsx`, on demand

- An entry point in the connected UI ("Check for incomplete uploads") opens a modal that runs the
  scan. Not auto-on-connect: avoids a request per connect and surfacing noise; it is a deliberate
  maintenance action.
- Rows: destination key + relative initiation time; per-row **Discard** and a **Discard all**.
- Header note (honest labeling): these are unfinished uploads, *possibly created by other tools*;
  Discard is safe for abandoned ones but destructive to an upload another tool is actively
  running. Rows already tracked as resumable (paused rows) are excluded.
- Empty state: "No incomplete uploads found."

## Evidence

- Unit: `listIncompleteUploads` pagination (KeyMarker/UploadIdMarker) with a mock client;
  `classifyIncompleteUploads` matching/tagging.
- Component: modal renders rows, empty state, Discard/Discard-all fire handlers, resumable
  excluded.
- E2E: the mock server gains `ListMultipartUploads`. Seed an incomplete upload (Create + one
  UploadPart, no Complete), open the panel, assert it lists, Discard, assert the server no longer
  lists it. Matched-pair: the Discard button's absence/inaction leaves the upload listed.

## Delivery

Checkpointed stages: (1) discovery lib + classifier, (2) modal UI, (3) App wiring + entry point,
(4) mock `ListMultipartUploads` + e2e, then ship as a minor bump.
