# Security Review — Bucketer v1.14.0

## Summary

Bucketer v1.14.0 has a clean XSS surface (no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`), stores the secret key exclusively in `sessionStorage`, and has solid input validation on credential fields added since v1.0. The biggest standing concern is the documented gap between the deployment CSP example in `README.md` and the app's actual runtime needs — the suggested `img-src data:` policy breaks image previews while `script-src 'unsafe-inline'` (required by the inline-bundle architecture) prevents CSP from providing meaningful XSS protection in production. A secondary concern is that `clearCredentials()` still erases user settings on every disconnect, a bug flagged in the v1.0 review that remains unaddressed. The lowest-hanging fix is adding an `https:` protocol guard in `readUrlParams()` for the endpoint field, which currently accepts any scheme from a share URL.

---

## Findings

### [SEV-01] `clearCredentials()` still wipes all user settings on disconnect — Medium

- **Location**: `src/lib/storage.js:72–75`
- **Evidence**:
  ```js
  export function clearCredentials() {
    Object.values(LS_KEYS).forEach(k => safeRemove(localStorage, k));
    safeRemove(sessionStorage, SS_KEY_SECRET);
  }
  ```
  `LS_KEYS` at lines 19–34 includes `maxKeys`, `partConcurrency`, `partSizeMB`, `fileConcurrency`, `listingCacheTTL`, `updateCheckEnabled`, `prefetchSizeLimit`, `uploadExpandThreshold`, and `capabilities` — nine settings keys — in addition to the five credential fields. A separate `resetSettings()` function exists at line 292 but `clearCredentials()` does not use it.
- **Risk**: Any user who configures non-default part size, concurrency, cache TTL, or listing max-keys loses all those settings every time they disconnect or switch buckets. This is a data-loss bug, not a direct security risk, but it is the exact issue the v1.0 review flagged as a bug affecting production users.
- **Recommendation**: Split `LS_KEYS` into `CREDENTIAL_KEYS` (endpoint, bucket, keyId, provider, regionOverride) and `SETTINGS_KEYS`, and make `clearCredentials()` iterate only `CREDENTIAL_KEYS`. `resetSettings()` already exists for the settings half — this is a two-line refactor.

---

### [SEV-02] `readUrlParams()` passes endpoint from URL hash to the app without URL scheme validation — Medium

- **Location**: `src/lib/url-params.js:21`
- **Evidence**:
  ```js
  if (p.has('endpoint')) out.endpoint = p.get('endpoint');
  ```
  No validation is performed on the endpoint value. If a share URL like `bucketer.hidayahtech.net/#endpoint=javascript%3Aalert(1)&bucket=x` is crafted, the string `javascript:alert(1)` is returned by `readUrlParams()` and merged into the app's credential state. The `provider` field at line 24–28 has explicit whitespace/length validation added in BUG-016; the `endpoint` and `bucket` fields received no comparable guard.
- **Risk**: In the current code path, the endpoint is passed to `new S3Client({ endpoint })` in `s3-client.js`. The AWS SDK constructs fetch URLs from the endpoint value; `fetch("javascript:...")` throws a `TypeError` in all browsers rather than executing code, so there is no direct XSS vector here. However the string is also persisted to `localStorage` via `saveCredentials()`, displayed in the SetupGuide CORS command blocks as text content (safe), and included in the `buildShareUrl()` output. A `javascript:` endpoint would propagate across sessions and to anyone the share URL is forwarded to. More concretely: a malicious share URL could configure the app to point at an attacker-controlled HTTPS endpoint; if a user fills in credentials and connects before noticing, those credentials are sent to the attacker's server. The `type="url"` attribute on the endpoint input provides browser-level URL validation for user-typed values, but share URL params bypass that entirely.
- **Recommendation**: Add a URL scheme check in `readUrlParams()`:
  ```js
  if (p.has('endpoint')) {
    const v = p.get('endpoint');
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.endpoint = v;
    } catch { /* ignore */ }
  }
  ```
  Apply the same guard to `bucket` (reject values containing `..` or path separators). Note: the form input `type="url"` already performs this check for manually-typed values; the gap is the URL params path only.

---

### [SEV-03] Deployment CSP example in README.md breaks preview functionality and uses `unsafe-inline` — Medium

- **Location**: `README.md:163` (nginx example), `README.md:178` (Caddy example)
- **Evidence**:
  ```
  img-src data:; connect-src https://*.backblazeb2.com ...
  ```
  The CSP has `img-src data:` only. Presigned S3 URLs used by `<img src={previewUrl}>` (image preview), `<audio>`, `<video>`, and `<iframe>` (PDF preview) are all HTTPS URLs to third-party S3 hosts, not data URIs. These would all be blocked by the suggested CSP. Additionally, `script-src 'unsafe-inline'` is required by the inline-bundle architecture (the entire app is a single `<script>` tag); this effectively disables XSS protection from CSP for script injection. The spec (§4.9) correctly states that `script-src 'self'` is achievable, but the inline bundle cannot satisfy it without a nonce or hash.
- **Risk**: Two distinct sub-issues:
  1. **Functional**: A user deploying the app with the provided nginx/Caddy example verbatim will find that image, audio, video, and PDF previews silently fail to load with a CSP violation in the browser console.
  2. **Security**: The `script-src 'unsafe-inline'` CSP is weakened. While the vendored inline bundle is trustworthy itself, `unsafe-inline` means any injected `<script>` tag (via a future XSS bug or a compromised deployment serving modified HTML) would also execute. The spec calls for the CSP to be set as an HTTP response header; the example does this correctly, but the policy is incomplete.
- **Recommendation**: Update the `img-src` directive to include the S3 provider origins:
  ```
  img-src data: https://*.backblazeb2.com https://*.r2.cloudflarestorage.com https://*.wasabisys.com https://*.amazonaws.com https://*.digitaloceanspaces.com https:;
  ```
  Add `media-src` with the same values for audio/video preview. Add `frame-src` with the same values for PDF iframe preview. For `script-src`, document that the inline-bundle approach currently requires `unsafe-inline` and that a future hash-based approach (e.g. adding the SHA-256 of the inlined script in `build.mjs`) would allow `script-src 'sha256-<hash>'` instead.

---

### [SEV-04] PDF preview uses `sandbox=""` (fully sandboxed iframe) — may be overly restrictive, but currently correct — Low

- **Location**: `src/components/Browser.jsx:1041`
- **Evidence**:
  ```jsx
  <iframe src={previewUrl} class="preview-pdf" title={leafName(previewItem.Key)} sandbox="" />
  ```
  `sandbox=""` applies all restrictions: no scripts, no same-origin, no forms, no pointer lock, no popups. This is the most restrictive possible sandbox and is the correct posture for rendering user-controlled PDFs.
- **Risk**: Verified clean — the `sandbox=""` attribute prevents PDFs from executing scripts or navigating the parent frame. This finding is noted as a non-issue confirming correct implementation.
- **Recommendation**: No change needed. Consider adding `allow-same-origin` only if specific PDF viewer functionality requiring same-origin access is needed in future. The current empty sandbox is the correct secure default.

---

### [SEV-05] CORS `AllowedHeaders` includes `x-amz-*` wildcard — wildcard scope confirmed minimal but worth noting — Low

- **Location**: `src/lib/cors-config.js:12`
- **Evidence**:
  ```js
  AllowedHeaders: ['Authorization', 'Content-Type', 'Content-MD5', 'x-amz-*', 'amz-sdk-invocation-id', 'amz-sdk-request', 'ETag'],
  ```
  The `x-amz-*` wildcard permits any header beginning with `x-amz-` to be included in CORS preflights. This was the correct fix for BUG-012's B2 header gap.
- **Risk**: The `x-amz-*` wildcard is broader than strictly necessary. It allows any future custom `x-amz-*` header a provider might introduce (or a malicious relay could inject) to pass CORS preflight. For the current AWS SDK v3 usage, the specifically needed headers are `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` (for STS), and `x-amz-acl`. The wildcard covers all of these but also others.
- **Recommendation**: The risk is low — these are request headers only; a broader `x-amz-*` allowlist does not grant new access to response data beyond what `ExposeHeaders` covers. Accept as-is; narrowing the list would create fragility without meaningful security gain.

---

### [SEV-06] CORS guide embeds key ID in AWS CLI configure command — clipboard injection via shell metacharacters in endpoint/bucket — Low/Nit

- **Location**: `src/components/SetupGuide.jsx:74–79` (corsCmd function), lines 141, 188, 253, 282, 319, 348
- **Evidence**:
  ```js
  function corsCmd({ endpoint, bucket, origin, profile = 'bucketer' }) {
    return `aws s3api put-bucket-cors \\
    --profile ${profile} \\
    --endpoint-url ${endpoint || 'https://s3.<region>.backblazeb2.com'} \\
    --bucket ${bucket || '<your-bucket>'} \\
    --cors-configuration '${corsJson(origin)}'`;
  }
  ```
  The endpoint and bucket values are interpolated into a shell command string without quoting or escaping. If a user enters a bucket name containing a space or shell metacharacter (e.g., `my-bucket'; rm -rf /home`) it would appear in the displayed/copied command in a potentially dangerous form.
- **Risk**: The command is displayed in a `<pre>` text block and copied to clipboard via `navigator.clipboard.writeText(children)`. It is never executed by the app itself. The risk is exclusively that a user could copy the displayed command and paste it into a terminal, where the injected shell syntax would execute. This requires the user to have entered adversarial values themselves (self-harm scenario) or to be using a share URL where the endpoint/bucket was pre-filled by an attacker. Since the `endpoint` and `bucket` fields are user-controlled inputs validated at the form level (spaces rejected, >63 chars rejected), the attack surface in practice is limited to the URL params path.
- **Recommendation**: Shell-quote the endpoint and bucket values in `corsCmd()`:
  ```js
  const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
  `--endpoint-url ${q(endpoint)} --bucket ${q(bucket)}`
  ```
  This is a defense-in-depth fix even if no realistic exploit path currently exists through the form validation.

---

### [SEV-07] No Content Security Policy on the deployed artifact — Nit (deployment gap)

- **Location**: `src/index.html` (no CSP meta tag), `dist/index.html` (same)
- **Evidence**: The `<head>` in `src/index.html` contains no `<meta http-equiv="Content-Security-Policy">` tag. When deployed with the nginx/Caddy examples from `README.md`, the CSP is set via server headers. When served from S3 static hosting (e.g., "drop it into the bucket you're managing"), there is no server-side mechanism to set CSP headers.
- **Risk**: The spec (§4.9) explicitly notes that `<meta>` CSP is weaker than HTTP headers and cannot restrict navigation. However, for users deploying to S3 static hosting — a promoted use case in the README — there is no CSP at all. Any XSS introduced via a future bug or a supply-chain compromise of the build artifact would have no policy constraint.
- **Recommendation**: Add a `<meta http-equiv="Content-Security-Policy">` tag to `src/index.html` as a baseline for deployment contexts that cannot set HTTP headers. Note the 512-byte head constraint: this meta tag would need to come after the `build-id` and `app-version` tags (already within the first 512 bytes). Measure the byte offset before adding. Even a weak policy (`connect-src https:`) provides some protection in header-less deployments.

---

### [SEV-08] Share URL endpoint param accepted without HTTPS enforcement — attacker-controlled endpoint SSRF-like risk — Medium (see SEV-02 for combined fix)

This is covered under SEV-02. Factored out here for completeness: the mechanism by which a malicious share URL could redirect credentials to an attacker-controlled endpoint is the most concrete security risk in the share-URL handling. It requires a user to click a crafted link, have the app pre-fill with the attacker endpoint, and then enter their valid credentials and click Connect. The attacker endpoint must serve a valid S3 API response to the initial `ListObjectsV2` probe to avoid an obvious error. Sophisticated but plausible for a phishing scenario.

---

## Verification of prior review (eng-review-v1.0-2026-05-28.md)

### `clearCredentials()` deleting settings — **Still present**

The v1.0 review identified `clearCredentials()` at `src/lib/storage.js:59–61` (then) as deleting all `LS_KEYS` including settings. In v1.14.0, `clearCredentials()` at `src/lib/storage.js:72–75` still iterates `Object.values(LS_KEYS)` which now includes 14 keys (9 settings + 5 credentials). A `resetSettings()` function was added (lines 292–299) and a separate `wipeAllAppData()` (lines 278–288) but `clearCredentials()` was not refactored. This is SEV-01 above.

### `@anthropic-ai/claude-code` in dependencies — **Fixed**

`package.json` now lists only three `dependencies` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `preact`) and four `devDependencies` (`esbuild`, `fake-indexeddb`, `playwright`). `@anthropic-ai/claude-code` does not appear in either. `package-lock.json` contains zero matches for "anthropic". Confirmed fixed.

### No tests — **Fixed**

The v1.0 review noted zero tests. v1.14.0 has 14 test files covering lib modules with unit tests and structural assertions. Build output assertions cover the two original BUG-001/BUG-002 build-level findings.

### `HiddenVersions.handlePurgeAllConfirm` stops on first batch error — **Still present**

`src/components/HiddenVersions.jsx:122–132`: the batch-delete loop `throw`s on the first `Errors` entry, abandoning subsequent batches. This is the partial-failure-visibility issue the v1.0 review flagged. Not a security finding but noted.

---

## Non-findings worth noting

The following were checked and found clean:

- **No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or `document.write`** anywhere in `src/`. Object keys from S3 are rendered as React/Preact text children, not inserted as HTML. Confirmed via exhaustive grep.
- **Secret key never in `localStorage`**: `saveCredentials()` routes `secretKey` exclusively to `sessionStorage` via `SS_KEY_SECRET`. `saveProfile()` explicitly drops `secretKey` before persisting (`const { secretKey: _dropped, ...safeProfile } = profile`). The `StorageModal` displays only `'Present (session only)'` rather than the value.
- **Secret key not in console**: One `console.info` call exists in the codebase (`src/components/UploadQueue.jsx:570`) and pertains to tab-visibility state, not credentials.
- **Share URLs do not contain credentials**: `buildShareUrl()` includes only `endpoint`, `bucket`, `provider`, and `regionOverride`. `keyId` and `secretKey` are never serialized to the URL hash. Confirmed at `src/lib/url-params.js:42–52`.
- **Presigned URLs not in browser history**: Download presigned URLs are set as `a.href` on a detached anchor that is appended/clicked/removed synchronously. They are never assigned to `window.location` and never appear in `history.pushState()` calls. Preview presigned URLs are held in component state and a `useRef` cache; they are not serialized to the URL bar.
- **Presigned URL default expiry is 1 hour**: `PRESIGN_EXPIRES = 3600` at `src/components/Browser.jsx:27`. Custom copy-link duration is capped at 604800 seconds (7 days). The preview URL cache tracks expiry and serves stale-early (5 minutes before expiry) to avoid nearly-expired URLs.
- **SVG previewed via `<img>`, not inline**: `svg` maps to kind `'image'` in `media.js:15`. Image previews use `<img src={previewUrl}>`, which is sandboxed by the browser against SVG script execution. No inline SVG rendering.
- **PDF iframe sandbox is maximally restrictive**: `sandbox=""` at `Browser.jsx:1041` applies all restrictions. Correct implementation.
- **Text preview forces `text/plain`**: The signed URL for text-kind files overrides `ResponseContentType: 'text/plain; charset=utf-8'` regardless of stored Content-Type. HTML and JS files stored in the bucket are shown as source text, not rendered. Comment at `Browser.jsx:612–614` explicitly documents this security property.
- **`@anthropic-ai/claude-code` not in `package.json` or `package-lock.json`**: Confirmed absent.
- **`dist/index.html` has no source maps**: Zero `sourceMappingURL` occurrences in the built file. No external CDN `<script src=...>` tags. All content inlined.
- **`dist/index.html` has no leaked dev paths or secrets**: No matches for `/home/`, `process.env`, or unreplaced `<!-- BUILD_ID -->` / `<!-- APP_VERSION -->` placeholders in the built artifact.
- **localStorage shared-namespace warning is surfaced**: `FileBanner.jsx` correctly identifies Chrome's shared null-origin `localStorage` namespace as a caveat and displays it when running from `file://`.
- **Endpoint URL validated by browser via `type="url"` input**: For user-typed values in `CredentialForm.jsx:96`, the browser enforces valid URL format. The gap (URL params bypassing this) is covered in SEV-02.
- **Provider field validated at read and write boundaries**: `isValidProvider()` in `storage.js:187–189` enforces a short identifier with no whitespace. Applied in `loadCredentials()`, `saveCredentials()`, and `readUrlParams()` for the provider parameter. BUG-016 fix is complete.
- **No cross-tab leakage via storage events**: No `addEventListener('storage', ...)` or `window.onstorage` handlers anywhere in `src/`. The app does not reactively consume storage events, so a tab that modifies localStorage cannot trigger code execution in another tab.
- **No Credential Management API usage**: The spec mentions it as optional; the implementation does not use it. This is correct given reliability concerns (noted in spec §4.5).
