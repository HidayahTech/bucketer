# Bucketer Improvement Plan

> Analysis date: 2026-05-21. Current `dist/index.html`: **360 KB**. Node ≥ 20 required.

---

## 1. Node.js / npm version requirements

### Findings

| Constraint | Current | Minimum possible |
|---|---|---|
| `engines.node` in package.json | `>=20.0.0` | `>=18.0.0` |
| esbuild 0.28.x (`engines`) | requires `>=18` | `>=18` |
| `build.mjs` / `serve.mjs` features | top-level await, ESM | stable since Node 14.8 |
| npm (package-lock v3) | 10.x | npm 7+ |

**Bottom line:** the only thing that gates the lower bound is esbuild 0.28.x, which declares `"node":">=18"`. Everything else in the build scripts (top-level await in ESM, `fs`, `http`, `path`) has been stable since Node 14.

### Recommendation

Change the `engines` field to `"node": ">=18.0.0"`. This is a one-line change in `package.json` and requires no code changes.

If you need to support Node 16 systems as the *build host*, you would have to pin esbuild to an older release (0.17–0.20 range) that still supports Node 16. However, since `dist/index.html` is a static file with **no runtime Node.js dependency**, the simpler path is to build on a modern machine and deploy the artifact. Node.js is only needed at build time.

### Action

```json
// package.json
"engines": {
  "node": ">=18.0.0"
}
```

---

## 2. Dependency audit

### `@anthropic-ai/claude-code` — **remove immediately**

This is a CLI application, not a library. It is listed as a runtime dependency but nothing in `src/` imports it. esbuild will never include it in the bundle. Its only effect is bloating `node_modules`.

**Measured cost:** 227 MB out of 259 MB total `node_modules` (87%).

The most recent commit (`5cedc12`) carries the message "Remove @anthropic-ai/claude-code from dependencies" but the working-tree `package.json` still lists it. This needs to be resolved — remove it from `package.json` and run `npm install` to regenerate `package-lock.json`. This has **zero impact on the built output** but shrinks `node_modules` from ~259 MB to ~32 MB.

### `@aws-sdk/lib-storage` — **remove (unused)**

`@aws-sdk/lib-storage` provides the `Upload` helper class for high-level multipart uploads. However, the codebase implements multipart upload fully by hand in `UploadQueue.jsx` using the low-level `CreateMultipartUploadCommand` / `UploadPartCommand` / `CompleteMultipartUploadCommand` primitives. A grep of all `src/` files confirms this package is **never imported**.

It is safe to remove from `package.json` with no code changes. Disk impact: 236 KB in `node_modules`. Bundle impact: none (it was never bundled).

### Current `package.json` dependencies after cleanup

| Package | Keep? | Purpose |
|---|---|---|
| `preact` | Yes | UI framework |
| `@aws-sdk/client-s3` | Yes (for now) | S3 API commands |
| `@aws-sdk/s3-request-presigner` | Yes (for now) | Presigned download URLs |
| `@aws-sdk/lib-storage` | **Remove** | Not imported |
| `@anthropic-ai/claude-code` | **Remove** | Not related to project |
| `esbuild` (dev) | Yes | Bundler |

---

## 3. Bundle size — analysis and reduction plan

### Current breakdown (approximate, minified)

| Contributor | Est. size |
|---|---|
| AWS SDK v3 (client-s3 + presigner) | ~345 KB |
| CSS (main.css inlined) | ~9 KB |
| App code (all components + lib) | ~6 KB |
| **Total** | **~360 KB** |

The app code and CSS are lean. The AWS SDK dominates completely.

### Why the AWS SDK is large even with tree-shaking

AWS SDK v3 was designed with tree-shaking in mind, but the browser bundle still includes:

- **SigV4 signing** — HMAC-SHA256 key derivation, canonical request construction
- **XML serialization/deserialization** — S3 returns XML for list and error responses
- **Middleware stack** — retry logic, checksum, redirect handling, user-agent injection
- **Credential resolution chain** — multiple providers tried in order
- **HTTP/fetch adapter** — a full fetch-based HTTP handler
- **Smithy runtime** — the code-generated protocol layer shared by all SDK commands

Using 12 different S3 commands plus the presigner means almost nothing is shaken out.

### Option A — Replace AWS SDK with a lightweight S3 client (recommended)

Replace all three AWS SDK packages with:

- **`aws4fetch`** (~2 KB minified): a fetch-based SigV4 request signer designed for browser/edge environments. No dependencies.
- **`DOMParser`** (built into all browsers): parse S3 XML responses. No extra library needed.
- A thin handwritten S3 HTTP layer (~15–20 KB of new source code in `src/lib/s3-http.js`)

The browser's `DOMParser` handles S3 XML cleanly. Presigned URL generation also becomes straightforward with aws4fetch's URL pre-signing support.

**Estimated bundle after change: ~25–40 KB** (roughly 9× smaller).

**Scope:** `src/lib/s3-client.js` is replaced; `src/components/Browser.jsx`, `UploadQueue.jsx`, and `HiddenVersions.jsx` need their SDK imports swapped for the new HTTP layer calls. The external interface (command names) can be preserved if you write the thin layer to match, so component code stays largely the same.

**Risk:** The AWS SDK handles edge cases in XML parsing, error normalization, retry on 5xx, and CRC64 checksums. A hand-rolled client will initially lack some of these. This is the right trade-off for a browser app, but the new client should be tested against each supported provider.

### Option B — Keep AWS SDK, reduce what gets bundled (minor improvement)

Remove `@aws-sdk/lib-storage` (already unused). This saves nothing in the bundle since it's not imported, but confirms the dependency list is clean.

There is no easy way to significantly shrink the AWS SDK v3 bundle while keeping the SDK. The middleware, Smithy runtime, and XML layer are all mandatory once you import even a single command.

### Option C — CSS minification via esbuild (small, free win)

`build.mjs` reads CSS with `readFileSync` and inlines it verbatim — it is **not** passed through esbuild's minifier. Passing the CSS through esbuild's transform API would reduce the already-small 9 KB CSS by roughly 20–30% (~2 KB savings). Low effort, low reward, but costs nothing.

```js
// In build.mjs — replace the readFileSync line with:
const cssResult = await esbuild.transform(readFileSync('src/styles/main.css', 'utf8'), {
  loader: 'css', minify: !dev,
});
const css = cssResult.code;
```

### Option D — Dead code: `FileBanner` browser detection strings

`FileBanner.jsx` ships detailed browser-specific caveat text for Chrome, Firefox, Safari, and an "unknown" fallback. This is good UX but is always-present in the bundle. These strings are a few hundred bytes — not significant, but could be code-split (lazy-loaded only on `file://`) if bundle size were critical. Not worth doing at current scale; revisit only if the bundle grows back.

### Recommended sequence

1. Remove `@anthropic-ai/claude-code` and `@aws-sdk/lib-storage` (cleanup, zero risk)
2. Add CSS minification to `build.mjs` (1-line change, free win)
3. Implement Option A (aws4fetch replacement) — highest impact, most work

---

## 4. URL-based pre-population (new feature)

### Goal

Share a URL that pre-fills `endpoint`, `bucket`, `provider`, and `regionOverride` so a recipient only needs to type their personal Key ID and Secret Key, then click Connect.

### What goes in the URL

| Field | In URL? | Reason |
|---|---|---|
| `endpoint` | Yes | Not sensitive |
| `bucket` | Yes | Not sensitive |
| `provider` | Yes | Not sensitive |
| `regionOverride` | Yes | Not sensitive |
| `keyId` | No | Access key ID is not a secret but is account-specific; user should enter it |
| `secretKey` | **Never** | Credential — must never appear in URL |

### Proposed URL format

Use query parameters, since the app is served over HTTP in its primary use case:

```
https://bucketer.example.com/?endpoint=https%3A%2F%2Fs3.us-west-004.backblazeb2.com&bucket=my-bucket&provider=b2
```

Parameters: `endpoint`, `bucket`, `provider`, `region` (maps to `regionOverride`).

### Implementation design

**`src/lib/url-params.js`** (new file, ~30 lines):

```js
export function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const out = {};
  if (p.has('endpoint')) out.endpoint = p.get('endpoint');
  if (p.has('bucket'))   out.bucket   = p.get('bucket');
  if (p.has('provider')) out.provider = p.get('provider');
  if (p.has('region'))   out.regionOverride = p.get('region');
  return out;
}

export function buildShareUrl(credentials) {
  const p = new URLSearchParams();
  if (credentials.endpoint) p.set('endpoint', credentials.endpoint);
  if (credentials.bucket)   p.set('bucket',   credentials.bucket);
  if (credentials.provider) p.set('provider', credentials.provider);
  if (credentials.regionOverride) p.set('region', credentials.regionOverride);
  const base = window.location.origin + window.location.pathname;
  return `${base}?${p.toString()}`;
}
```

**`App.jsx`** changes:
1. In the `useState(() => loadCredentials())` initializer, merge URL params on top:
   ```js
   const [credentials, setCredentials] = useState(() => {
     const stored = loadCredentials();
     const fromUrl = readUrlParams();
     return { ...stored, ...fromUrl };  // URL wins for pre-fill
   });
   ```
2. Add a "Copy share link" button in the connected sidebar (next to Disconnect or inside SettingsPanel). Calls `buildShareUrl(credentials)` and copies to clipboard.
3. Show an informational banner when URL params are present: "Endpoint and bucket pre-filled from URL — enter your Key ID and Secret Key to connect."

**`CredentialForm.jsx`** changes:
- Accept an optional `readOnly` prop for `endpoint` and `bucket` fields when they came from a URL param, or simply leave them editable (user can change before connecting). Editable is simpler and safer.

### UX notes

- URL params pre-fill the form but do not auto-connect (the user must still click Connect after entering their credentials).
- After a successful connect, `saveCredentials()` persists the full state. On next page load, stored credentials take precedence unless new URL params override them.
- The feature works identically for `file://` users.
- No special routing needed — `window.location.search` is available in all contexts.

---

## 5. Back button / history navigation (new feature)

### Goal

When a user navigates into a subfolder in the bucket browser, the browser back button should return them to the previous folder (not leave the app).

### Proposed approach: `history.pushState` with a query parameter

Use the History API to push a state entry on each navigation, encoding the current prefix as a query parameter. This integrates cleanly with the URL prepopulation feature in section 4.

**URL format:** `?prefix=photos/2024/` (combined with section 4 params: `?endpoint=...&bucket=...&prefix=photos/2024/`)

**Why not the hash?** Hash changes do not trigger a page reload on any browser and work from `file://`. However, if you use query params for section 4, mixing `?` and `#` in the same URL is ugly and confusing. Using query params for both is consistent. Hash-based navigation is a valid alternative if `file://` support is a priority (query params work fine from `file://` too, but `pushState` is blocked on `file://` in Chrome; `hashchange` is not).

**Why not `replaceState` for initial load?** `pushState` on every navigation creates a back stack, which is exactly what we want.

### Implementation design

**`Browser.jsx`** changes:

```js
// Read initial prefix from URL on mount
const [prefix, setPrefix] = useState(() => {
  const p = new URLSearchParams(window.location.search);
  return p.get('prefix') || '';
});

// Push to history on every navigation
function navigateTo(newPrefix) {
  // ... existing abort + state reset ...
  const p = new URLSearchParams(window.location.search);
  p.set('prefix', newPrefix);
  window.history.pushState({ prefix: newPrefix }, '', '?' + p.toString());
  setPrefix(newPrefix);
  // ... fetchPage ...
}

// Listen for back/forward navigation
useEffect(() => {
  function handlePopState(e) {
    const newPrefix = e.state?.prefix ?? '';
    // Re-use the internal navigate path but without pushing a new history entry
    setPrefix(newPrefix);
    setItems([]);
    setCommonPrefixes([]);
    setContinuationToken(null);
    setIsTruncated(false);
    setListError(null);
    fetchPage(newPrefix, null, true);
  }
  window.addEventListener('popstate', handlePopState);
  return () => window.removeEventListener('popstate', handlePopState);
}, []);
```

**`App.jsx` integration:** the `browserKey` mechanism (used to force Browser re-mount on reconnect) should call `window.history.replaceState` with `{prefix: ''}` when resetting, to clear stale history state.

### `file://` caveats

`history.pushState` is blocked in Chrome from `file://` (throws `SecurityError`). The fix is to wrap `pushState`/`replaceState` calls in a try/catch and fall back to silent no-op — navigation still works normally, the back button just won't remember folder history from `file://`.

```js
function pushPrefixHistory(prefix) {
  try {
    const p = new URLSearchParams(window.location.search);
    if (prefix) p.set('prefix', prefix); else p.delete('prefix');
    window.history.pushState({ prefix }, '', '?' + p.toString());
  } catch { /* file:// — silently ignore */ }
}
```

### Interaction with URL prepopulation

Both features share the query string. A combined share URL looks like:

```
?endpoint=https://s3.us-west-004.backblazeb2.com&bucket=my-bucket&provider=b2&prefix=uploads/2024/
```

When parsing URL params (section 4), `prefix` is read separately by the Browser component, not by `readUrlParams()`. This keeps the two features independent: section 4 reads config params; section 5 reads and writes `prefix`.

---

## Summary table

| Item | Effort | Impact | Risk |
|---|---|---|---|
| Lower Node engines to `>=18` | 1 line | Unblocks older build hosts | None |
| Remove `@anthropic-ai/claude-code` | 1 line + npm install | node_modules: 259 MB → 32 MB | None |
| Remove `@aws-sdk/lib-storage` | 1 line | Cleaner dep list | None |
| CSS minification in build.mjs | 3 lines | ~2 KB saved | None |
| Replace AWS SDK with aws4fetch | Large (~400 LOC) | Bundle: ~360 KB → ~35 KB | Medium — needs testing per provider |
| URL pre-population | Medium (~80 LOC) | New feature, shareable links | Low |
| Back button history | Medium (~50 LOC) | New feature, improved UX | Low |

### Recommended order of implementation

1. **Cleanup** (no-risk, immediate): remove `@anthropic-ai/claude-code` and `@aws-sdk/lib-storage`, lower engines, add CSS minification.
2. **URL pre-population** (low risk, high value): enables the shared-link use case.
3. **Back button** (low risk, clear scope): integrates cleanly with #2.
4. **AWS SDK replacement** (medium risk, highest size impact): plan a separate session; write the new HTTP layer first, keep the old one in parallel until tested against B2, R2, and Wasabi.
