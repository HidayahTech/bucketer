# Manual check — pre-flight probe classification against real providers

**Why this exists.** The download pre-flight's status-code table (`download-preflight.js`)
was originally validated only against a mock whose status codes the author chose — and the
one provider-specific behavior that matters most was wrong in exactly the way that habit
invites: AWS returns **403, not 404**, for a missing key when the caller lacks
`s3:ListBucket`, so a single deleted object could stop an entire job (postmortem catalog
defect 7). The engine now requires a streak of consecutive denials before blocking, which
bounds that failure — but the classification itself has **still never been measured against
a real provider**. A mock cannot honestly test a table whose values the mock copied from
the table's author.

**When to run it.** Before any release that changes `download-preflight.js`'s
classification (`kindForStatus`) or the engine's blocking rule (`DENIED_BLOCK_STREAK`, and
the streak logic that consumes it in `runDownloadJob`, `download-queue.js`), and once
against each newly supported provider. Record the results in the table below with the date,
credentials shape, and observed codes — this file is the log.

## The checks

Use a scratch bucket. Every probe is `GET` with `Range: bytes=0-0` on a presigned URL, the
exact shape the engine sends.

1. **Missing key, full-permission credentials.** Delete an object, probe its presigned
   URL. Expected: `404` → MISSING → that file fails, job continues.
2. **Missing key, no `s3:ListBucket`.** Same probe with credentials lacking ListBucket.
   AWS documents `403` here. Expected: DENIED for that file only; job must continue unless
   a streak follows. *This is the catalog-7 scenario.*
3. **Expired/rotated credentials.** Probe any live key with a revoked keypair. Expected:
   `403` on every key → DENIED streak → job blocks with the credentials message.
4. **Clock skew.** Presign with system clock offset > 15 min. Expected: `403`
   (RequestTimeTooSkewed surfaces as 403 at the HTTP layer) → streak → block.
5. **Archived object (AWS).** The primary path does **not** probe these: `download-manifest.js`
   reads `StorageClass` from the ListObjectsV2 listing and records GLACIER / DEEP_ARCHIVE
   objects as `SKIPPED` (`skipReason: 'archived'`) at enumeration, so they never become
   PENDING and never reach the probe (`storage-class.js`, `isArchivedStorageClass`). What
   this check measures is the **post-enumeration race**: an object archived *after* the
   listing but *before* its turn in the queue. Probe such an object and record the actual
   status (`403 InvalidObjectState` expected). Note that this classifies as DENIED, so a
   *cluster* of freshly-archived objects would count toward the `DENIED_BLOCK_STREAK` and
   block the job — it is not an unconditional per-file failure.
6. **Empty object.** Probe a 0-byte object. Expected: `416` → OK (readable). This is the
   one the table already gets right by design; confirm per provider anyway.
7. **Missing CORS rule.** Probe from a browser origin the bucket's CORS does not allow.
   Expected: thrown fetch → NETWORK → immediate job-wide block.

## Running it against AWS (copy-paste)

The minimum bar is checks 1 and 2 — they are the catalog-7 discriminator and the only thing
that has never been measured. Checks 3, 5 and 6 are quick add-ons on the same setup. Checks 4
(clock skew) and 7 (missing CORS) cannot be done with `curl` — 4 needs the signer's clock
moved, and 7 is a browser-origin behaviour with no command-line equivalent; run 7 from the app
against a bucket whose CORS omits your origin.

Everything below replicates the engine exactly: a `GET` with `Range: bytes=0-0` on a presigned
URL. `Range` is CORS-safelisted and sent as a request header, not signed, so
`curl -H 'Range: bytes=0-0' "$(aws s3 presign …)"` is the same request `probeUrl` makes.

### 1. Two IAM identities

The whole test turns on one permission: `s3:ListBucket`. Create two access keys — one with it,
one without — and store them as named CLI profiles `bkt-full` and `bkt-nolist`. Replace
`SCRATCH` with your bucket name in both policies.

`bkt-full` (sets up objects, and gets 404 for a missing key because it may list):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"], "Resource": "arn:aws:s3:::SCRATCH/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::SCRATCH" }
  ]
}
```

`bkt-nolist` (GetObject only — no ListBucket, so a missing key comes back 403):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::SCRATCH/*" }
  ]
}
```

**Turnkey CLI setup** (assumes your default AWS CLI credentials can create IAM users — an
admin key on a personal account; if IAM is locked down, create the two users in the console
with the policies above, then run only the `aws configure set` lines). Needs `jq` to pipe the
freshly-created keys straight into the profiles:

```bash
export B=your-globally-unique-scratch-bucket-name
aws s3 mb "s3://$B" --region us-east-1

# Full identity — may list, so a missing key returns 404.
aws iam create-user --user-name bkt-full-user
aws iam put-user-policy --user-name bkt-full-user --policy-name s3full --policy-document "$(cat <<JSON
{ "Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::$B/*"},
  {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::$B"} ]}
JSON
)"
F=$(aws iam create-access-key --user-name bkt-full-user)
aws configure set aws_access_key_id     "$(echo "$F" | jq -r .AccessKey.AccessKeyId)"     --profile bkt-full
aws configure set aws_secret_access_key "$(echo "$F" | jq -r .AccessKey.SecretAccessKey)" --profile bkt-full
aws configure set region us-east-1 --profile bkt-full

# No-list identity — GetObject only, so a missing key returns 403 (the catalog-7 case).
aws iam create-user --user-name bkt-nolist-user
aws iam put-user-policy --user-name bkt-nolist-user --policy-name s3get --policy-document "$(cat <<JSON
{ "Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::$B/*"} ]}
JSON
)"
N=$(aws iam create-access-key --user-name bkt-nolist-user)
aws configure set aws_access_key_id     "$(echo "$N" | jq -r .AccessKey.AccessKeyId)"     --profile bkt-nolist
aws configure set aws_secret_access_key "$(echo "$N" | jq -r .AccessKey.SecretAccessKey)" --profile bkt-nolist
aws configure set region us-east-1 --profile bkt-nolist

# New keys take a few seconds to activate. If the first probe returns an auth error, wait ~10s and retry.
```

### 2. Seed the test objects

The bucket already exists from step 1; just add the two fixtures:

```bash
printf 'hello' | aws s3 cp - "s3://$B/present.txt" --profile bkt-full        # a readable object
aws s3api put-object --bucket "$B" --key empty.txt --profile bkt-full        # 0-byte object, for check 6
# do NOT create does-not-exist.txt — its absence is the point
```

One helper, so each probe is a single line printing just the HTTP status:

```bash
probe() { curl -s -o /dev/null -w "%{http_code}\n" -H 'Range: bytes=0-0' "$1"; }
```

### 3. The probes

```bash
# Sanity — present object, full creds. Expect 206 (partial content) → OK.
probe "$(aws s3 presign "s3://$B/present.txt" --profile bkt-full --expires-in 300)"

# CHECK 1 — missing key, FULL creds (has ListBucket). Expect 404 → MISSING.
probe "$(aws s3 presign "s3://$B/does-not-exist.txt" --profile bkt-full --expires-in 300)"

# CHECK 2 — missing key, NO ListBucket. Expect 403 → DENIED.   ← the catalog-7 measurement
probe "$(aws s3 presign "s3://$B/does-not-exist.txt" --profile bkt-nolist --expires-in 300)"

# CHECK 6 — empty (0-byte) object, full creds. Expect 416 → OK.
probe "$(aws s3 presign "s3://$B/empty.txt" --profile bkt-full --expires-in 300)"
```

To record the S3 error *code* (NoSuchKey / AccessDenied / …) next to the status, drop
`-o /dev/null` and read the XML `<Code>`:

```bash
curl -s -H 'Range: bytes=0-0' "$(aws s3 presign "s3://$B/does-not-exist.txt" --profile bkt-nolist --expires-in 300)"
```

### 4. Optional extras (same setup)

```bash
# CHECK 3 — revoked credentials. Deactivate the bkt-nolist access key in IAM, then re-run any
# bkt-nolist probe above. Expect 403 (InvalidAccessKeyId / SignatureDoesNotMatch).

# CHECK 5 — archived object (the post-enumeration race). Put a GLACIER object, GET it directly.
printf 'x' | aws s3 cp - "s3://$B/frozen.txt" --storage-class GLACIER --profile bkt-full
probe "$(aws s3 presign "s3://$B/frozen.txt" --profile bkt-full --expires-in 300)"   # expect 403 (InvalidObjectState)
```

### 5. What to paste back, and teardown

For each check, the observed status (and the `<Code>` where you grabbed it):

```
sanity present : 206
check 1 (404?) : ___
check 2 (403?) : ___   code: ___
check 6 (416?) : ___
check 5 (403?) : ___   code: ___
```

I will fill the results-log table below and write the BUG-LOG entry from those. Then tear
everything down — run this with your **default (admin) credentials**, not the scoped `bkt-*`
profiles (those can delete objects but not the bucket or the IAM users):

```bash
aws s3 rb "s3://$B" --force                                    # bucket + all objects
aws iam delete-user-policy --user-name bkt-full-user   --policy-name s3full
aws iam delete-user-policy --user-name bkt-nolist-user --policy-name s3get
for u in bkt-full-user bkt-nolist-user; do
  for k in $(aws iam list-access-keys --user-name "$u" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    aws iam delete-access-key --user-name "$u" --access-key-id "$k"
  done
  aws iam delete-user --user-name "$u"
done
# Optionally drop the [bkt-full] and [bkt-nolist] blocks from ~/.aws/credentials and ~/.aws/config.
```

## Results log

| Date | Provider | Check | Observed | Matches table? | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | No real-provider run recorded yet. Until a row exists for AWS checks 1–2, treat the 403-for-missing behavior as *documented, not measured*. |
