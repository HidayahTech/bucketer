# Provider-Feasibility Lane — `ListBuckets` Bucket-Discovery Flow

Panel: multi-bucket redesign, PROVIDER-FEASIBILITY lane. Research only — no source
changes. Scope: can Bucketer replace/augment its mandatory manual bucket-name entry
with an S3 `ListBuckets`-based "pick a bucket from a list" flow, for each of the six
providers it supports?

**Method note:** every provider/API claim below carries an inline vendor-doc URL and a
fetch date. Where official docs didn't answer a sub-question directly, that's stated
explicitly rather than inferred as fact — see the "not directly confirmed" flags.

---

## 0. The client-init claim — checked and found FALSE

The codebase currently asserts, in three places, that **"AWS SDK v3 calls `ListBuckets`
during client initialisation"**:

- `src/components/SetupGuide.jsx:112` (B2 guide text, user-facing)
- `test/source-invariants.test.js:244-258` (enforces the SetupGuide text stays in sync
  with this claim)
- `docs/intent/action-plan-v1.14.0-review.md` T3-5 / PV-11, sourced from
  `docs/review-v1.14.0/06-provider-verification.md` PV-11

This claim is **not correct** for the SDK version this project actually ships
(`@aws-sdk/client-s3` `^3.1051.0`, per `package.json`), and I could not find it
substantiated by any AWS SDK v3 documentation either. I verified this two ways:

**1. Empirical reproduction**, run against the exact pinned package in this repo's
`node_modules`:

```js
const { S3Client } = require('@aws-sdk/client-s3');
let fetchCalled = false;
global.fetch = (...args) => { fetchCalled = true; ...; };
const client = new S3Client({ endpoint: '...', region: '...', credentials: {...}, forcePathStyle: true });
// fetchCalled === false immediately after construction
// fetchCalled === false 500ms later
```

Result: **no network call fires on construction**, immediately or after a 500ms grace
window. `new S3Client(...)` only builds a config object and a command-dispatch
pipeline; it performs no I/O. This matches the general SDK v3 architecture (documented
behavior: SDK v3 clients are lazy — a command only executes when `.send()` is called;
see the [AWS SDK for JavaScript v3 client S3 API reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html)'s
own "See Also" section listing the JS v3 SDK's per-command `send`-based invocation
model — fetched 2026-09-04). I did not find an AWS statement that explicitly says
"the constructor never makes calls," but the reproduction against the shipped version
is direct, primary evidence and is stronger than a documentation quote either way.

**2. Source confirmation of what Bucketer actually does on connect.** `src/components/App.jsx`
line 8 states the real flow in its own state-machine comment: *"connecting: credentials
saved, initial ListObjectsV2 probe in flight."* `grep` across `src/` and `test/` for
`ListBuckets`/`listBuckets` turns up **zero** calls to the `ListBucketsCommand` anywhere
in the current codebase — the only two hits are the SetupGuide prose and the test that
enforces that prose. Bucketer's connect probe is `ListObjectsV2`, scoped to the
already-known bucket name, not `ListBuckets`.

**Conclusion:** the "SDK calls ListBuckets on init, so B2 keys need `listAllBucketNames`"
reasoning is backwards. `listAllBucketNames` is real and does matter (see §1), but not
because of a phantom init-time call — it matters only if/when Bucketer code is later
*written* to call `ListBucketsCommand` explicitly (e.g. for the v2.0 discovery flow this
panel is evaluating). **This is a live doc/test/UI defect, not a hypothetical:** the
SetupGuide line and the enforcing test currently describe a mechanism that does not
exist in the shipped app. That's a fix for whoever owns SetupGuide.jsx, not something
this research lane should change, but it should be flagged to the panel synthesis and,
if you build ListBuckets discovery, the same misdiagnosis in PV-11 should be corrected
alongside it — the underlying advice ("bucket-restricted B2 keys need listAllBucketNames
to use ListBuckets") stays right, but the "why" attached to it in the UI is wrong and
will mislead a curious user or a future maintainer.

---

## 1. Backblaze B2

**1. Does `ListBuckets` work at all?** Yes, via the S3-compatible API root endpoint. B2's
own docs enumerate it as one of the S3-compatible operations
([List All Buckets in Your Backblaze Account](https://www.backblaze.com/apidocs/s3-list-buckets),
fetched 2026-09-04), and confirm *"Aside from the S3 List Buckets operation, all bucket
operations use an endpoint in the form `https://s3.<region>.backblazeb2.com/<your-bucket-name>`.
The ListBuckets operation itself uses the root endpoint"* (same source).

**2. CORS on the service root — the crux.** B2 CORS rules are set per-bucket via
`b2_update_bucket` (or the AWS CLI equivalent), and — critically — the set of operations
a B2 CORS rule can even be scoped to is a **closed, enumerated list** that does not
include bucket-listing at all. Per
[Cloud Storage Cross-Origin Resource Sharing Rules](https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules)
(fetched 2026-09-04), the valid `allowedOperations` values are limited to native-API
file operations (`b2_download_file_by_name`, `b2_download_file_by_id`, `b2_upload_file`,
`b2_upload_part`) and S3-compatible object operations (`s3_delete`, `s3_get`, `s3_head`,
`s3_put` — Bucketer's own `cors-config.js` sets `AllowedMethods: ['GET','PUT','HEAD','POST','DELETE']`
against this same rule shape). **There is no `s3_list_all_buckets`-equivalent operation a
CORS rule can name, and because CORS rules live on a specific bucket, they structurally
cannot apply to a request against the account root** (`GET /`, not scoped to any bucket).
This mirrors AWS S3's own limitation (§ below) almost exactly. **Verdict: B2 `ListBuckets`
cannot be made to work over browser CORS, under any key scope, by any means B2 exposes.**

**3. Key scope.** A key restricted to one bucket needs the `listAllBucketNames`
capability to enumerate all bucket names/IDs; an unrestricted (account-level) key can
already do this via the plain `listBuckets` capability. Source:
[B2 Application Key Capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities)
(fetched 2026-09-04): *"listAllBucketNames: List the names and IDs of all of the buckets
in the account, even app keys that are restricted to a bucket... access only to the
S3-Compatible API List Buckets."* This is the one part of the codebase's existing PV-11
finding that is correct and independently verified.

**4. Regional quirks.** A Backblaze account (and every key/bucket in it) is pinned to a
single B2 region — *"A Backblaze B2 account is associated with a single region, and it
is not currently possible to create buckets outside of an account's region"*
([Getting Started with the S3 Compatible API](https://help.backblaze.com/hc/en-us/articles/360047425453-Getting-Started-with-the-S3-Compatible-API),
fetched 2026-09-04). So there's no cross-region ambiguity to resolve for B2 — every
bucket the key can see lives behind the same regional endpoint already in the connection.

---

## 2. Cloudflare R2

**1. Does `ListBuckets` work at all?** Yes — R2's S3-compatibility matrix marks it fully
implemented: *"ListBuckets is fully implemented"* in the "Implemented bucket-level
operations" table,
[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) (fetched
2026-09-04).

**2. CORS on the service root — same crux as B2/AWS.** R2's CORS docs are exclusively
framed per-bucket: configuration is applied by "select[ing] your bucket from the list"
and the policy is described as applying "when you interact with **a bucket** from a web
browser" ([Configure CORS](https://developers.cloudflare.com/r2/buckets/cors/), fetched
2026-09-04). The doc does not discuss account-level/service-root operations at all —
i.e. there is no documented mechanism to CORS-enable a request that isn't scoped to one
bucket. I could not find an explicit "CORS does not cover ListBuckets" statement from
Cloudflare (unlike the AWS case below, where there's a direct GitHub issue trail), so
**this is inference from architecture, not a confirmed-by-name limitation** — but the
shape of the problem (CORS lives on a bucket resource; `ListBuckets` targets the
account root, not a bucket) is identical to AWS and B2 and should be assumed to apply
until tested against a live R2 bucket.

**3. Key scope.** R2 API tokens are either bucket-scoped or account-scoped. Per
[R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/) (fetched 2026-09-04):
object-level permissions ("Object Read & Write", "Object Read only") let a token "read,
write, and list objects in **specific buckets**" — no bucket-enumeration ability.
Listing buckets requires "Admin Read only" or "Admin Read & Write" scope, which grants
"the ability to list buckets and view bucket configuration." **Note for the panel:** the
project's own earlier finding (PV-06, `action-plan-v1.14.0-review.md` line 227) names
the required scope as *"account-scoped 'Workers R2 Storage Read'"* — that permission
name does not appear in R2's current token-permission documentation, which instead uses
"Admin Read only" / "Admin Read & Write." This may be Cloudflare having renamed the
permission group since PV-06 was written (2026-06-04), or PV-06 may have named it
imprecisely; either way, treat "Workers R2 Storage Read" as stale and use "Admin Read
(only/& write)" going forward, re-verified at implementation time since permission
group names in the R2 dashboard have changed at least once already.

**4. Regional quirks.** R2 buckets are optionally created in a "jurisdiction" (default,
`eu`, `us`, `fedramp`), each with its own hostname
(`https://<account_id>.<jurisdiction>.r2.cloudflarestorage.com`). Per
[Data location](https://developers.cloudflare.com/r2/reference/data-location/) (fetched
2026-09-04): *"when using a jurisdiction endpoint, you will not be able to access R2
resources outside of that jurisdiction"* — this is stated to apply to S3 API operations
generally, and by the same logic a `ListBuckets` call against one jurisdiction's
S3-compatible endpoint will only enumerate buckets created in that jurisdiction.
Bucketer's `provider.js` `extractRegion()` hardcodes R2's region to `'auto'` and its
endpoint detection pattern (`\.r2\.cloudflarestorage\.com$`) matches only the default
(non-jurisdictional) hostname — buckets created under `eu`/`us`/`fedramp` jurisdictions
would need a distinct endpoint Bucketer doesn't currently construct or detect. This is a
pre-existing gap unrelated to `ListBuckets` specifically (it would also affect ordinary
object operations against a jurisdictional bucket) but would also limit what a
`ListBuckets` discovery flow could show.

---

## 3. AWS S3

**1. Does `ListBuckets` work at all?** Yes — this is the canonical operation the others
imitate. `GET /` against `s3.amazonaws.com` returns `ListAllMyBucketsResult`. Source:
[ListBuckets API reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html)
(fetched 2026-09-04).

**2. CORS on the service root — confirmed as the blocker, with a direct trail.** AWS's
own CORS documentation frames CORS evaluation strictly as a bucket property: *"When
Amazon S3 receives a preflight request from a browser, it evaluates the CORS
configuration **for the bucket**..."*
([Using cross-origin resource sharing (CORS)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html),
fetched 2026-09-04) — there is no bucket in a `ListBuckets` request, so there is no CORS
configuration for S3 to consult. This is corroborated directly (not just inferred) by a
long-standing, labeled AWS SDK issue:
[aws/aws-sdk-js#1939 "S3 listBuckets CORS is not available"](https://github.com/aws/aws-sdk-js/issues/1939)
(fetched 2026-09-04) — tagged `service-api` (i.e. AWS's own triage says this is a
service limitation, not an SDK bug) and `documentation`. Community reproductions
consistently report the browser preflight (`OPTIONS` to the service root) returning
`403 Forbidden` / *"No 'Access-Control-Allow-Origin' header is present on the requested
resource"* regardless of bucket CORS configuration, because bucket-level CORS rules
have no bucket to attach to for this call. **Verdict: confirmed — AWS S3 `ListBuckets`
cannot be called from browser JS across origins, full stop, for any key/IAM scope.**
This is not a niche edge case; it's the load-bearing reason a browser-only S3 frontend
can't do what the feature request assumes AWS itself supports out of the box.

**3. Key scope.** `s3:ListAllMyBuckets` (also referred to as `ListAllMyBuckets` /
mapped to the `ListBuckets` API action) is required, targeted at `Resource: "*"` (an
account-wide resource, not a specific bucket ARN) — confirmed directly in the API doc's
description: *"To grant IAM permission to use this operation, you must add the
`s3:ListAllMyBuckets` policy action"* (ListBuckets API reference, above). A narrowly
bucket-scoped IAM policy (the kind users are steered toward for least-privilege
per-bucket credentials — exactly the shape Bucketer's own docs recommend for safety)
will not carry this permission by default and must be explicitly granted it.

**4. Regional quirks.** `ListBuckets` (called against the global/regional
`s3.amazonaws.com` or any regional endpoint — AWS does not require a jurisdiction match
the way R2 does) returns buckets **across all regions** in the account by default; each
returned `<Bucket>` element optionally carries a `<BucketRegion>` field (added per the
Oct-2024 API update — [Amazon S3 adds new Region and bucket name filtering for the
ListBuckets API](https://aws.amazon.com/about-aws/whats-new/2024/10/amazon-s3-new-region-bucket-name-filtering-listbuckets-api),
referenced from the same API reference doc, fetched 2026-09-04), or can be filtered to
one region via the `bucket-region` query parameter — but *"requests made to a Regional
endpoint that is different from the `bucket-region` parameter are not supported."* A
discovered bucket in a region other than the one the current client/connection is
configured for **would then need a second `S3Client` instance built for its own
region** (Bucketer's `createS3Client()` already supports building a second client with
different config for the multi-origin sharding path in `s3-client.js` — the same
pattern would apply here) before any object operation against it could succeed; using
the wrong region for the discovered bucket's SigV4 signing / endpoint would fail.

---

## 4. Wasabi

**1. Does `ListBuckets` work at all?** Yes, and unlike the above three, real-world usage
suggests apps that "only allow you to enter your API key set and then offer up all of
the buckets in your account" already exist against Wasabi, i.e. this pattern is already
in the wild for Wasabi specifically.

**2. CORS on the service root — the one where Wasabi may differ.** This is the most
interesting result of this survey. Wasabi does **not** gate CORS behind a per-bucket
configuration the way AWS/B2/R2/DO do — `needsCorsConfig(WASABI)` already returns
`false` in Bucketer's own `provider.js`, and Wasabi's official docs explain why: *"the
Wasabi server will return the cross-origin resource sharing (CORS) headers when the
header 'Origin' is given in an HTTP request"* — i.e. Wasabi echoes CORS headers
**automatically for any request carrying an `Origin` header**, not gated by a bucket
owner having opted a specific bucket into CORS. Source:
[Bucket CORS Support With the Wasabi S3 API](https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api)
(fetched 2026-09-04). **Caveat, stated plainly:** the doc's own examples and prose are
all framed around bucket/object requests ("either buckets or objects") — it does not
explicitly test or claim this for the service-root `ListBuckets` call, so I am **not**
promoting "Wasabi ListBuckets works over CORS" to a confirmed fact. Given the described
mechanism (blanket echo of `Origin`, not a per-resource allowlist check tied to a
bucket's stored CORS config), it is plausible this also covers the service root, in
contrast to the other four providers where the CORS *mechanism itself* is structurally
bucket-bound and could not cover it even in principle. **This should be empirically
tested against a live Wasabi account (a real preflight `OPTIONS /` request from a
browser) before being relied on** — it's the one place in this survey where the answer
plausibly differs from "definitely blocked," and it's cheap to verify directly.

**3. Key scope.** Wasabi's IAM policy language is AWS-compatible, and
`s3:ListAllMyBuckets` is likewise required to enumerate buckets: Wasabi's own docs on
setting up user access separation state *"to perform any bucket/object operations
through the Console, the sub-user MUST have 'ListAllMyBuckets' permission"* — a
narrowly-scoped IAM sub-user policy needs it added explicitly, same shape as AWS. Source:
[How do I set up Wasabi for user access separation?](https://docs.wasabi.com/v1/docs/how-do-i-set-up-wasabi-for-user-access-separation)
(fetched 2026-09-04).

**4. Regional quirks.** Wasabi accounts are not region-locked the way B2 accounts are —
buckets can exist in multiple Wasabi regions under one account, and `ListBuckets`
against one region's endpoint is reported to return the whole account's buckets across
regions (apps built against Wasabi "offer up all of the buckets in your account" from a
single key entry, implying cross-region enumeration). I did not find this stated as an
explicit, quotable quotable line in the primary Wasabi API docs (it's the weakest-cited
claim in this report), so **treat as likely, not confirmed**. If true, a discovered
bucket outside the connection's current region would need `buildEndpoint()` re-run for
that bucket's actual region — Wasabi's redirect/location-discovery behavior (client
libraries report Wasabi provides "location redirection information" when you hit the
wrong regional endpoint for a bucket) suggests this is a solvable, known pattern, not a
dead end.

---

## 5. MinIO (self-hosted)

**1. Does `ListBuckets` work at all?** Yes — MinIO implements the full S3 API surface
including `ListBuckets`, and is the reference self-hosted target for AWS SDK
compatibility generally.

**2. CORS on the service root — MinIO is structurally different from every hosted
provider above.** MinIO supports CORS at two levels: a **global, server-wide** setting
(`MINIO_API_CORS_ALLOW_ORIGIN`, part of the server's `api` config subsystem, default
`*`) and an optional **per-bucket** override that takes precedence when set. The global
setting is described in MinIO's own config reference as governing "global HTTP API
call specific features" ([minio/minio `docs/config/README.md`](https://raw.githubusercontent.com/minio/minio/master/docs/config/README.md),
fetched 2026-09-04) — language that describes the whole deployment's API surface, not a
specific bucket resource. This is the one provider where the *mechanism* for CORS is not
inherently bucket-scoped: it's an operator-controlled server setting, and it already
defaults to allow-all. **This env var is confirmed present in the open-source
`minio/minio` GitHub repo's own config docs** (not gated to the commercial "AIStor"
rebrand — several of MinIO's current docs pages have moved under an `aistor` URL prefix
after MinIO's 2026 rebrand, but the setting itself, and its GitHub source, predate that
and are not marked enterprise-only). **Caveat:** I could not find MinIO's own docs
stating in so many words "this global CORS setting applies to `ListBuckets`
specifically" — the strongest available quote just says it governs the `api` subsystem
globally. Given the description and that it's a deployment-wide switch rather than
something a bucket owner sets, this should work for `ListBuckets` too, but — same as
Wasabi — this is the kind of claim worth a five-minute empirical check against a real
MinIO instance rather than shipping on inference alone.

**3. Key scope.** MinIO uses AWS-compatible IAM policy JSON, including
`s3:ListAllMyBuckets`. One MinIO-specific wrinkle worth flagging: a filed MinIO issue
([`s3:ListAllMyBuckets` is allowed on single bucket #9475](https://github.com/minio/minio/issues/9475),
fetched 2026-09-04) reports that MinIO's policy engine, unlike AWS's, did not (at least
at the time of that report) enforce that `s3:ListAllMyBuckets` only be attachable to the
`arn:aws:s3:::*` account-wide resource — a policy scoped to `arn:aws:s3:::foo` and
granted `ListAllMyBuckets` worked when it arguably shouldn't have per AWS semantics.
This is a minor compatibility quirk, not a blocker, but means MinIO admins may see
`ListAllMyBuckets` behave slightly more permissively than the AWS IAM model implies.

**4. Regional quirks.** Largely not applicable — a MinIO deployment is typically a
single endpoint/single "region" as far as Bucketer is concerned (no region string is
embedded in MinIO's URL scheme the way it is for the hosted providers; Bucketer already
treats MinIO as forcePathStyle with no region extraction in `provider.js`). MinIO's
multi-site replication/federation features exist but are an operator topology choice
Bucketer has no visibility into and doesn't need to model for this feature.

---

## 6. DigitalOcean Spaces

**1. Does `ListBuckets` work at all?** Yes. Per
[How to Manage Access to DigitalOcean Spaces](https://docs.digitalocean.com/products/spaces/how-to/manage-access/)
(fetched 2026-09-04): *"Full access allows all supported S3 APIs on all buckets...
as well as listing all buckets."*

**2. CORS on the service root — same crux as AWS/B2/R2.** DO's CORS docs are
exclusively bucket-scoped in their configuration flow: *"To configure CORS, go to the
DigitalOcean Control Panel... under the Buckets tab, click the bucket you want to
configure CORS for"* ([Configure CORS](https://docs.digitalocean.com/products/spaces/how-to/configure-cors/),
fetched 2026-09-04). The doc does not address account-level operations like
`ListBuckets` at all. As with R2, I found no explicit "CORS doesn't cover ListBuckets"
statement from DigitalOcean specifically — but the configuration flow (per-bucket, in
the bucket's own settings page) is architecturally identical to AWS/B2/R2, all of which
are per-bucket by construction. **Treat as blocked by default, same as AWS/B2/R2, pending
live verification** — DO Spaces is explicitly built to be S3-API-compatible and mirrors
AWS's CORS model closely enough that AWS's confirmed block is the best available proxy.

**3. Key scope.** DO Spaces access keys come in two scopes: **Full Access** ("all
supported S3 APIs on all buckets... including... listing all buckets") and **Limited
Access** (scoped to specific buckets with Read/Read-Write/Delete grants per bucket). The
same source states Full Access is what includes bucket listing; it does not explicitly
say Limited Access keys are refused `ListBuckets` (as opposed to simply being scoped so
narrowly they'd see nothing useful), so the practical effect for a Limited Access key is
either an outright denial or a response limited to buckets the key can see — either way,
a Limited Access key cannot be relied on to *discover* new buckets by definition, since
its access is already pre-declared per bucket.

**4. Regional quirks.** DO Spaces bucket names are **unique per region**
([How to Create a DigitalOcean Spaces Bucket](https://docs.digitalocean.com/products/spaces/how-to/create/),
fetched 2026-09-04) and every bucket is addressed via a region-specific endpoint
(`https://<region>.digitaloceanspaces.com`). I did not find an explicit doc statement
that `ListBuckets` against one region's endpoint only returns that region's buckets —
this is **inferred from the region-is-part-of-the-namespace architecture**, not
confirmed by a direct doc quote, but it would be surprising if it worked any other way
given how strongly region-siloed DO's naming model is. If confirmed true at
implementation time, discovering "all of a user's Spaces buckets" would require the
same regional endpoint the connection is already using — DO Spaces gives no single
account-wide root the way AWS/Wasabi appear to.

---

## 7. Verdict table

| Provider | `ListBuckets` API exists | CORS reaches service root? | Key scope needed | Practical verdict |
|---|---|---|---|---|
| **AWS S3** | Yes | **No — confirmed blocked** (AWS's own CORS doc + a labeled `service-api` AWS SDK issue) | `s3:ListAllMyBuckets` on `Resource:"*"` | **Cannot offer discovery from the browser.** Manual entry (or single-bucket mode) is the only option regardless of key scope. |
| **Backblaze B2** | Yes | **No — confirmed blocked** (CORS rules are per-bucket AND the operation isn't even in the CORS-rule vocabulary) | `listAllBucketNames` (bucket-restricted keys) or `listBuckets` (unrestricted) | **Cannot offer discovery from the browser**, even for a fully-permissioned key. |
| **Cloudflare R2** | Yes | **Presumed blocked** (per-bucket CORS model, same shape as AWS/B2; not directly confirmed by an explicit "ListBuckets+CORS" statement) | Account-scoped "Admin Read (only/& write)" token (current naming; PV-06's "Workers R2 Storage Read" appears stale) | **Very likely cannot offer discovery from the browser.** Same architecture as AWS/B2. Worth one live test to be sure, but don't build against an assumption it works. |
| **DigitalOcean Spaces** | Yes | **Presumed blocked** (same per-bucket CORS config flow as AWS/B2/R2; not directly confirmed) | "Full Access" key scope; "Limited Access" keys are pre-scoped and can't discover new buckets by design | **Very likely cannot offer discovery from the browser.** |
| **Wasabi** | Yes | **Plausibly works** — Wasabi's CORS is a blanket server-side echo of any `Origin` header, not a per-bucket allowlist; mechanism is not resource-scoped the way the four above are, but the docs never explicitly test the service root | `s3:ListAllMyBuckets`, same as AWS | **The one hosted provider worth actually testing.** If it works, it's the strongest case for shipping the feature at all — but confirm with a live request before committing to it. |
| **MinIO (self-hosted)** | Yes | **Plausibly works** — global `MINIO_API_CORS_ALLOW_ORIGIN` is a deployment-wide setting (default allow-all), not bucket-owner-configured, so there's no structural reason it wouldn't cover the service root; not explicitly confirmed for `ListBuckets` by name | `s3:ListAllMyBuckets` in an IAM policy scoped to `arn:aws:s3:::*` | **Likely works, and is operator-controlled anyway** (a self-hosting user who wants this can just set the env var). Second-best candidate to verify live. |

**The CORS-on-service-root problem is the dominant blocker**, exactly as the panel brief
suspected — not key scope, not the (previously misdiagnosed) SDK init behavior. For 4 of
6 providers (AWS, B2, R2, DO Spaces) it's a structural dead end: CORS configuration is a
property attached to a bucket resource, and `ListBuckets` addresses the account/service
root, which is not a bucket and has no CORS configuration to satisfy. AWS confirms this
with a direct doc statement plus a labeled `service-api` SDK issue; B2 confirms it even
more strongly by not offering any CORS-rule vocabulary that could cover the operation at
all; R2 and DO Spaces share the identical bucket-scoped CORS architecture without an
explicit doc statement calling out `ListBuckets` by name, so they're "very likely
blocked" rather than "confirmed blocked" — but nothing in their docs suggests a
different mechanism that would let them escape the same trap. Wasabi and MinIO are
structurally different (CORS isn't gated behind a specific bucket's configuration at
all) and are the only two providers where this might actually work — both flagged above
as needing a real empirical test, not a doc-only sign-off, before either is relied on.

---

## RECOMMENDATION

**Is `ListBuckets` discovery worth building?** Only as an **opportunistic, per-connection
capability probe with a graceful, silent fallback** — never as the primary or required
flow, and never gating the "pick a bucket" UI on it succeeding.

Reasoning:

- For 4 of Bucketer's 6 supported providers (AWS, B2, and very likely R2 and DO Spaces —
  which together probably cover most of the actual user base), the browser cannot call
  `ListBuckets` at all, regardless of how permissive the key is. Building a UI that
  *assumes* discovery works and only degrades on error would mean most users hit a
  broken/error-y first impression before falling back — bad UX for the common case.
- For Wasabi and MinIO, it plausibly works, but neither claim is nailed down by an
  explicit vendor doc line naming `ListBuckets` and CORS together — both need a real
  test (a live account, a real preflight, DevTools open) before Bucketer ships UI copy
  that promises it.
- Even where it works, `ListBuckets` needs an *account-scoped* or *unrestricted* key
  (B2 `listAllBucketNames`, AWS/Wasabi `s3:ListAllMyBuckets` on `Resource:"*"`, R2
  "Admin" token, DO "Full Access"). Bucketer's own existing security guidance already
  steers users toward narrowly bucket-scoped keys for safety — the exact key shape that
  makes single-bucket use *safer* is the one that makes discovery *fail*. A feature that
  only works for the more dangerous, broader key shape is a bad trade for most users.

**Suggested design, if built:**

1. **Feature-detect per connection, don't gate the UI on provider identity alone.** On
   connect, attempt `ListBucketsCommand` once, opportunistically, alongside (not
   instead of) the existing `ListObjectsV2` probe against the already-known/entered
   bucket. Cache the result (works / CORS-blocked / access-denied / unknown) against the
   connection profile so it isn't re-attempted every session.
2. **Never block the primary flow on it.** Manual bucket-name entry (today's flow)
   remains the default and always-available path. A successful `ListBuckets` probe
   *augments* it with a "browse other buckets" affordance; a failed probe (CORS error,
   `AccessDenied`, `NotImplemented`) silently falls back to manual entry with **no error
   surfaced to the user** for the discovery attempt itself — only the deliberate
   `ListObjectsV2` probe against the bucket the user actually wants should produce
   user-visible errors, same as today.
3. **Distinguish the failure modes in code, even if the UI hides most of them**, since
   they imply different remedies: a CORS-shaped failure (opaque network error on the
   preflight, no readable response) means "this provider probably can't do this, don't
   retry, don't nag the user to fix their key" — whereas an `AccessDenied`/403-with-body
   failure means "the key is real and reachable but under-scoped," which is worth a
   one-line, optional hint ("add `listAllBucketNames` / a broader key scope to browse
   buckets") rather than silence, since that one is actually fixable by the user.
4. **Ship the Wasabi/MinIO live test before writing any UI code that depends on the
   answer.** Both are cheap to check (a real Wasabi trial account; a local MinIO
   container is already presumably available for this project's e2e harness) and the
   whole value proposition of the feature rides on at least one hosted provider actually
   supporting it — if Wasabi's blanket-echo CORS behavior turns out not to cover the
   service root either, the feature only meaningfully helps self-hosted MinIO users,
   which changes whether it's worth building at all.
5. **Fix the SetupGuide/test/action-plan misdiagnosis (§0) as a small, separate cleanup**
   regardless of whether discovery ships — the current "SDK calls ListBuckets on init"
   claim is user-facing (SetupGuide.jsx) and wrong, and will actively mislead anyone who
   later tries to reason about why a B2 key needs `listAllBucketNames`.
