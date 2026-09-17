# Live probe: what Backblaze B2 actually returns to a prefix-restricted key

**Item P1 of the prefix-access run** (design: `../specs/2026-09-16-prefix-access-design.md`,
"Research gaps"). Operator action; no version bump. Not a blocker — v1.62.4–v1.63.1 are
correct under either outcome — but it settles four things the harness cannot represent, and
the answers belong in the design record and in the 2026-08-13 prefix-scoped-keys record's
"Unresolved" bullet.

## You need

- A Backblaze B2 bucket you control, with the Setup Guide's CORS rules applied for the
  Bucketer origin you will use.
- An application key created with a **Name Prefix** (e.g. `probe/`) and file-level
  capabilities (listFiles, readFiles, writeFiles, deleteFiles). Keep the key ID and secret.
- Chromium (or Firefox) with DevTools open on the Network tab, "Preserve log" on.
- Bucketer v1.62.4 or later.

## Probe 1 — the denial's wire shape (decides which explanation B2 users see)

1. Open Bucketer, fill endpoint / bucket / key ID / secret, leave **Base folder empty**,
   press Connect.
2. In the Network tab find the `GET …/?list-type=2…` (or `GET /<bucket>?list-type=2…`)
   request. Record:
   - HTTP **status** and the `<Code>` in the XML body (expected `403` / `AccessDenied`, but
     B2 has returned `401` for other denials — write down what you see).
   - Whether the response carries `Access-Control-Allow-Origin` (Response Headers). If it
     does, Bucketer shows "Access Denied" with the readable-403 explanation. If it does
     not, the browser shows "Failed to fetch" and Bucketer shows the two-cause block; note
     which one you saw on screen.
3. Screenshot the Bucketer error block as displayed.

## Probe 2 — bad-credential codes (decides whether the scope hint is correctly suppressed)

1. Same as Probe 1 but with a **wrong secret**. Record status + `<Code>` (AWS convention is
   `403 SignatureDoesNotMatch`).
2. Same with a **wrong key ID**. Record status + `<Code>` (AWS convention is
   `403 InvalidAccessKeyId`).
3. Note whether Bucketer showed the base-folder hint in either case. It must not; if B2
   uses different codes, the suppression list in `src/components/ErrorBlock.jsx`
   (`BAD_CREDENTIAL_CODES`) needs those codes — file a follow-up.

## Probe 3 — a non-folder Name Prefix

1. Create a second key whose Name Prefix has no trailing slash and is not a folder, e.g.
   `photos-2024`, with objects `photos-2024/a.txt` and `photos-2024-raw/b.txt` in the bucket.
2. Connect with Base folder `photos-2024` (Bucketer normalizes it to `photos-2024/`).
   Record whether the listing succeeds and whether `photos-2024-raw/…` is (correctly)
   invisible. B2's documented rule is "the same prefix as the key, or a more restrictive
   one", so `photos-2024/` should be accepted; confirm.

## Probe 4 — recovery end to end

1. From the failed screen of Probe 1, click **Set base folder**, type the key's Name
   Prefix, press Connect. Confirm the listing renders inside the prefix.
2. Save the connection, sign out, quick-switch back through the header tab. Confirm it
   connects without a detour to the failed screen (v1.62.6) and that the saved record shows
   the base folder.

## Record the answers

Append a "Live probe results (YYYY-MM-DD)" section to
`docs/superpowers/specs/2026-09-16-prefix-access-design.md` under "Research gaps", and
update the "Unresolved" bullet in `docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md`.
If Probe 2's codes differ from the S3 convention, open an issue referencing #65.
