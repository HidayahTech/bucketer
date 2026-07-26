# Connection Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user-triggered "Run diagnostics" button in `ErrorBlock` that runs static checks plus `no-cors` reachability probes and replaces the vague "may be CORS / auth / routing" note with a single precise verdict.

**Architecture:** A new pure-testable library `src/lib/connection-diagnostics.js` runs ordered checks (offline → mixed content → URL validity → endpoint probe → bucket-host probe) and derives one verdict; `ErrorBlock` gains an optional `diagnostics` prop that renders the button and results; call sites (App connect screen, Browser ×3, HiddenVersions) thread the prop from credentials App already holds. Spec: `docs/superpowers/specs/2026-07-26-connection-diagnostics-design.md`.

**Tech Stack:** Preact + esbuild; `node --test` for unit tests (no framework); jsdom + `preact/test-utils` via `npm run test:ui` for component tests. No new dependencies.

## Global Constraints

- No new npm dependencies.
- Probes are unauthenticated `no-cors` requests; credentials are never attached; nothing runs until the user clicks.
- All I/O injectable: `runDiagnostics` accepts `fetchFn`, `pageProtocol`, `onLine`, `timeoutMs` so unit tests never touch the network or globals.
- Verdict wording is copied verbatim from the spec's `VERDICT_MESSAGES` (defined in Task 1); `cors-blocked` says "almost certainly", never "definitely".
- Buttons must have explicit `type="button"` (house convention, BUG-006).
- `src/lib/changelog.js` is generated — never edit it.
- Unit tests: `npm test`. Component tests: `npm run test:ui` (NOT `npm test`).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Operator confirmation is required before each commit and before the version bump** (house rule). Pause and ask; do not commit unattended.
- Known pre-existing quirk, do NOT touch: `UploadQueue.jsx:44` imports `ErrorBlock` but never renders it. The spec listed UploadQueue as a call site; it has none. Leave the import alone (surgical-changes rule) — just don't add wiring there.

---

### Task 1: Diagnostics library

**Files:**
- Create: `src/lib/connection-diagnostics.js`
- Test: `test/connection-diagnostics.test.js`

**Interfaces:**
- Consumes: `requiresPathStyle(provider)` from `src/lib/provider.js` (existing).
- Produces (used by Tasks 2–3):
  - `async runDiagnostics({ endpoint, bucket, forcePathStyle, fetchFn?, pageProtocol?, onLine?, timeoutMs? })` → `{ checks: Array<{id, label, status: 'pass'|'fail'|'skip', detail: string|null}>, verdict: string }`
  - `VERDICT_MESSAGES` — object mapping every verdict id to its user-facing sentence
  - `diagnosticsProps(credentials)` → `{ endpoint, bucket, forcePathStyle }`
  - Check ids, in order: `online`, `mixed-content`, `url-valid`, `endpoint-reachable`, `bucket-host-reachable` (5 checks; the spec's "check 6" is the implicit fall-through to verdict `cors-blocked`).

- [ ] **Step 1: Write the failing test**

Create `test/connection-diagnostics.test.js`:

```js
// Unit tests for connection diagnostics (spec 2026-07-26).
// All I/O is injected — no network, no browser globals required.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics, diagnosticsProps, VERDICT_MESSAGES } from '../src/lib/connection-diagnostics.js';

const BASE = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'my-bucket',
  forcePathStyle: false,
  pageProtocol: 'https:',
  onLine: true,
};

const fetchOk = async () => ({ type: 'opaque' });
const fetchFail = async () => { throw new TypeError('NetworkError'); };

describe('runDiagnostics verdicts', () => {
  test('offline: navigator reports no connection', async () => {
    const { checks, verdict } = await runDiagnostics({ ...BASE, onLine: false, fetchFn: fetchOk });
    assert.equal(verdict, 'offline');
    assert.equal(checks[0].id, 'online');
    assert.equal(checks[0].status, 'fail');
    // everything after the verdict-determining check is skipped
    for (const c of checks.slice(1)) assert.equal(c.status, 'skip');
  });

  test('mixed-content: https page with http endpoint', async () => {
    const { verdict, checks } = await runDiagnostics({
      ...BASE, endpoint: 'http://minio.example.com:9000', fetchFn: fetchOk,
    });
    assert.equal(verdict, 'mixed-content');
    assert.equal(checks.find(c => c.id === 'mixed-content').status, 'fail');
  });

  test('http endpoint from an http page is NOT mixed content', async () => {
    const { verdict } = await runDiagnostics({
      ...BASE, endpoint: 'http://minio.example.com:9000', pageProtocol: 'http:', forcePathStyle: true, fetchFn: fetchOk,
    });
    assert.equal(verdict, 'cors-blocked');
  });

  test('bad-endpoint-url: unparseable endpoint', async () => {
    const { verdict } = await runDiagnostics({ ...BASE, endpoint: 'not a url', fetchFn: fetchOk });
    assert.equal(verdict, 'bad-endpoint-url');
  });

  test('endpoint-unreachable: probe of endpoint origin rejects', async () => {
    const { verdict, checks } = await runDiagnostics({ ...BASE, fetchFn: fetchFail });
    assert.equal(verdict, 'endpoint-unreachable');
    assert.equal(checks.find(c => c.id === 'endpoint-reachable').status, 'fail');
    assert.equal(checks.find(c => c.id === 'bucket-host-reachable').status, 'skip');
  });

  test('bucket-host-unreachable: endpoint ok, bucket vhost rejects', async () => {
    const fetchFn = async (url) => {
      if (String(url).includes('my-bucket.')) throw new TypeError('NetworkError');
      return { type: 'opaque' };
    };
    const { verdict } = await runDiagnostics({ ...BASE, fetchFn });
    assert.equal(verdict, 'bucket-host-unreachable');
  });

  test('bucket vhost probe targets bucket.<endpoint-host>', async () => {
    const urls = [];
    const fetchFn = async (url) => { urls.push(String(url)); return { type: 'opaque' }; };
    await runDiagnostics({ ...BASE, fetchFn });
    assert.ok(urls.some(u => u.startsWith('https://my-bucket.s3.us-west-004.backblazeb2.com')));
  });

  test('cors-blocked: everything reachable', async () => {
    const { verdict, checks } = await runDiagnostics({ ...BASE, fetchFn: fetchOk });
    assert.equal(verdict, 'cors-blocked');
    for (const c of checks) assert.equal(c.status, 'pass');
  });

  test('path-style skips the bucket-host probe', async () => {
    const urls = [];
    const fetchFn = async (url) => { urls.push(String(url)); return { type: 'opaque' }; };
    const { verdict, checks } = await runDiagnostics({ ...BASE, forcePathStyle: true, fetchFn });
    assert.equal(verdict, 'cors-blocked');
    assert.equal(checks.find(c => c.id === 'bucket-host-reachable').status, 'skip');
    assert.equal(urls.length, 1, 'only the endpoint origin is probed');
  });

  test('probe timeout counts as unreachable', async () => {
    // Never resolves; rejects only on abort — exercises the AbortController path.
    const hangingFetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const { verdict } = await runDiagnostics({ ...BASE, fetchFn: hangingFetch, timeoutMs: 10 });
    assert.equal(verdict, 'endpoint-unreachable');
  });

  test('every verdict has a user-facing message', async () => {
    for (const v of ['offline', 'mixed-content', 'bad-endpoint-url', 'endpoint-unreachable', 'bucket-host-unreachable', 'cors-blocked']) {
      assert.equal(typeof VERDICT_MESSAGES[v], 'string');
      assert.ok(VERDICT_MESSAGES[v].length > 20, `message for ${v} should be a real sentence`);
    }
    assert.ok(VERDICT_MESSAGES['cors-blocked'].includes('almost certainly'));
    assert.ok(!VERDICT_MESSAGES['cors-blocked'].toLowerCase().includes('definitely'));
  });
});

describe('diagnosticsProps', () => {
  test('derives forcePathStyle from provider', () => {
    const p = diagnosticsProps({ endpoint: 'https://x.example.com', bucket: 'b', provider: 'minio' });
    assert.deepEqual(p, { endpoint: 'https://x.example.com', bucket: 'b', forcePathStyle: true });
  });

  test('virtual-host provider yields forcePathStyle false', () => {
    const p = diagnosticsProps({ endpoint: 'https://s3.amazonaws.com', bucket: 'b', provider: 'aws' });
    assert.equal(p.forcePathStyle, false);
  });
});
```

Provider ids verified against `src/lib/provider.js`: `requiresPathStyle` returns true for `'b2'` and `'minio'`, false otherwise — the two `diagnosticsProps` tests above are correct as written. (Side effect worth knowing: B2 profiles will skip the bucket-host probe, matching how the app actually addresses B2 buckets.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connection-diagnostics.test.js`
Expected: FAIL — `Cannot find module '../src/lib/connection-diagnostics.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/connection-diagnostics.js`:

```js
// Copyright (C) 2026 HidayahTech, LLC
// Connection diagnostics (spec: docs/superpowers/specs/2026-07-26-connection-diagnostics-design.md).
//
// When a request dies before an HTTP response exists, the browser surfaces a bare
// TypeError regardless of cause — CORS, DNS, TLS, mixed content, offline, and
// extension blocking are indistinguishable from the error object alone. These
// checks gather the evidence the error cannot carry: static environment checks
// plus no-cors probes. A no-cors fetch bypasses the CORS layer entirely, so an
// opaque success proves reachability (DNS + TLS + listener) independent of the
// bucket's CORS configuration. If everything is reachable yet the SDK saw a
// network-shaped TypeError, the failure is at the CORS layer: correctly
// configured CORS would surface even bad credentials as a readable 403.
import { requiresPathStyle } from './provider.js';

export const PROBE_TIMEOUT_MS = 5000;

export const VERDICT_MESSAGES = {
  'offline': 'Your browser reports no network connection. Reconnect and try again.',
  'mixed-content': 'This page is served over HTTPS but the endpoint is HTTP — browsers silently block such requests. Use an HTTPS endpoint.',
  'bad-endpoint-url': 'The endpoint is not a valid URL. Check it for typos.',
  'endpoint-unreachable': 'The endpoint host did not respond — check the URL for typos. A blocking browser extension can also cause this.',
  'bucket-host-unreachable': 'The endpoint responds, but the bucket’s hostname does not — check the bucket name. For a brand-new bucket, DNS may still be propagating.',
  'cors-blocked': 'Your storage responded, but the browser blocked the request. This is almost certainly missing or incorrect CORS configuration on the bucket — see the Setup Guide for your provider’s exact command.',
};

// Builds the ErrorBlock `diagnostics` prop from a stored credentials object.
export function diagnosticsProps(credentials) {
  return {
    endpoint: credentials.endpoint,
    bucket: credentials.bucket,
    forcePathStyle: requiresPathStyle(credentials.provider),
  };
}

// Opaque success = reachable; rejection or timeout = unreachable from this browser.
async function probe(url, fetchFn, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchFn(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDiagnostics({ endpoint, bucket, forcePathStyle, fetchFn, pageProtocol, onLine, timeoutMs } = {}) {
  fetchFn = fetchFn || globalThis.fetch;
  pageProtocol = pageProtocol ?? globalThis.location?.protocol;
  onLine = onLine ?? (globalThis.navigator ? globalThis.navigator.onLine : true);
  timeoutMs = timeoutMs ?? PROBE_TIMEOUT_MS;

  const checks = [];
  let verdict = null;
  const push = (id, label, status, detail = null) => checks.push({ id, label, status, detail });

  // 1. Offline
  if (onLine === false) {
    push('online', 'Browser is online', 'fail');
    verdict = 'offline';
  } else {
    push('online', 'Browser is online', 'pass');
  }

  // 2. Mixed content (HTTPS page → HTTP endpoint is silently blocked by browsers)
  if (verdict) {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'skip');
  } else if (pageProtocol === 'https:' && /^\s*http:\/\//i.test(endpoint || '')) {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'fail');
    verdict = 'mixed-content';
  } else {
    push('mixed-content', 'Endpoint protocol allowed from this page', 'pass');
  }

  // 3. URL validity
  let endpointUrl = null;
  if (verdict) {
    push('url-valid', 'Endpoint is a valid URL', 'skip');
  } else {
    try {
      endpointUrl = new URL(endpoint);
      push('url-valid', 'Endpoint is a valid URL', 'pass');
    } catch {
      push('url-valid', 'Endpoint is a valid URL', 'fail');
      verdict = 'bad-endpoint-url';
    }
  }

  // 4. Endpoint reachability (no-cors probe of the endpoint origin)
  if (verdict) {
    push('endpoint-reachable', 'Endpoint host responds', 'skip');
  } else if (await probe(endpointUrl.origin, fetchFn, timeoutMs)) {
    push('endpoint-reachable', 'Endpoint host responds', 'pass');
  } else {
    push('endpoint-reachable', 'Endpoint host responds', 'fail');
    verdict = 'endpoint-unreachable';
  }

  // 5. Bucket virtual-host reachability (skipped for path-style addressing)
  if (verdict) {
    push('bucket-host-reachable', 'Bucket hostname responds', 'skip');
  } else if (forcePathStyle) {
    push('bucket-host-reachable', 'Bucket hostname responds', 'skip', 'Path-style addressing — bucket hostname not used');
  } else {
    const bucketUrl = new URL(endpointUrl.origin);
    bucketUrl.hostname = `${bucket}.${bucketUrl.hostname}`;
    if (await probe(bucketUrl.origin, fetchFn, timeoutMs)) {
      push('bucket-host-reachable', 'Bucket hostname responds', 'pass');
    } else {
      push('bucket-host-reachable', 'Bucket hostname responds', 'fail');
      verdict = 'bucket-host-unreachable';
    }
  }

  // 6 (implicit). Reachable everywhere yet the SDK saw a masked TypeError → CORS layer.
  if (!verdict) verdict = 'cors-blocked';
  return { checks, verdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/connection-diagnostics.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS (new file is picked up by the `test/*.test.js` glob; nothing else regresses)

- [ ] **Step 6: Commit (ask operator first)**

```bash
git add src/lib/connection-diagnostics.js test/connection-diagnostics.test.js
git commit -m "feat: connection-diagnostics lib — probe-based verdicts for masked network errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ErrorBlock UI — Run-diagnostics button and results

**Files:**
- Modify: `src/components/ErrorBlock.jsx`
- Test: `test/components/error-block.test.jsx` (extend)

**Interfaces:**
- Consumes: `runDiagnostics(opts)`, `VERDICT_MESSAGES` from Task 1.
- Produces: `ErrorBlock` accepts optional prop `diagnostics` — the object passed verbatim to `runDiagnostics`, so `{ endpoint, bucket, forcePathStyle }` in production and additionally `{ fetchFn, pageProtocol, onLine, timeoutMs }` in tests. Button renders only when `diagnostics` is provided AND the error is CORS-like. Task 3 relies on exactly this prop name.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('ErrorBlock', ...)` block in `test/components/error-block.test.jsx`:

```jsx
  test('no diagnostics button without the diagnostics prop', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, { error: new Error('Failed to fetch') }));
    assert.ok(!queryAll('button').some(b => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('no diagnostics button for non-CORS-like errors even with the prop', () => {
    const s3Error = Object.assign(new Error('Access Denied'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const { queryAll, cleanup } = mount(h(ErrorBlock, {
      error: s3Error,
      diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
    }));
    assert.ok(!queryAll('button').some(b => b.textContent.includes('Run diagnostics')));
    cleanup();
  });

  test('diagnostics button renders for CORS-like errors with the prop', () => {
    const { queryAll, cleanup } = mount(h(ErrorBlock, {
      error: new Error('Failed to fetch'),
      diagnostics: { endpoint: 'https://s3.example.com', bucket: 'b', forcePathStyle: false },
    }));
    const btn = queryAll('button').find(b => b.textContent.includes('Run diagnostics'));
    assert.ok(btn, 'button should be present');
    assert.equal(btn.getAttribute('type'), 'button');
    cleanup();
  });

  test('clicking the button runs diagnostics and shows the verdict', async () => {
    const { queryAll, text, cleanup } = mount(h(ErrorBlock, {
      error: new Error('Failed to fetch'),
      diagnostics: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        forcePathStyle: false,
        pageProtocol: 'https:',
        onLine: true,
        fetchFn: async () => ({ type: 'opaque' }),
      },
    }));
    const btn = queryAll('button').find(b => b.textContent.includes('Run diagnostics'));
    fire(btn, 'click');
    // flush the async runDiagnostics → setState round-trips
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    assert.ok(text().includes('almost certainly missing or incorrect CORS'),
      'cors-blocked verdict should be shown');
    assert.ok(text().includes('Endpoint host responds'), 'check list should be shown');
    cleanup();
  });
```

(`fire` is already imported in this file? Check the imports at the top — line 7 imports only `mount`; extend it to `import { mount, fire } from '../helpers/render.js';`.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test:ui`
Expected: the three new assertions about the button/verdict FAIL; existing ErrorBlock tests still pass.

- [ ] **Step 3: Implement in ErrorBlock.jsx**

Replace the full contents of `src/components/ErrorBlock.jsx` with:

```jsx
// Copyright (C) 2026 HidayahTech, LLC
// Structured error display (§4.10).
//
// Parses AWS SDK v3 error objects (Code, $metadata.httpStatusCode, $metadata.requestId)
// and renders them with optional consequence and guidance strings from the call site.
//
// CORS heuristic: when the parsed error has no HTTP status (null) or the message mentions
// 'fetch'/'network', the error is likely CORS-masked. In this case an extra note is shown
// explaining that the actual auth/routing error may be hidden by the browser's CORS layer.
// Users should verify with curl or the AWS CLI to see the real response.
//
// When the `diagnostics` prop ({ endpoint, bucket, forcePathStyle }) is provided and the
// error is CORS-like, a "Run diagnostics" button offers an in-browser differential
// diagnosis (see lib/connection-diagnostics.js). Nothing runs until the user clicks.
import { useState } from 'preact/hooks';
import { parseS3Error } from '../lib/format.js';
import { runDiagnostics, VERDICT_MESSAGES } from '../lib/connection-diagnostics.js';

const STATUS_ICONS = { pass: '✓', fail: '✗', skip: '–' };

export function ErrorBlock({ error, title, consequence, guidance, diagnostics }) {
  const [diag, setDiag] = useState(null); // null | 'running' | { checks, verdict }
  if (!error) return null;
  const parsed = typeof error === 'string' ? { message: error } : parseS3Error(error);
  const isCorsLike = parsed.message?.toLowerCase().includes('fetch') ||
                     parsed.message?.toLowerCase().includes('network') ||
                     parsed.status === null;

  async function handleDiagnose() {
    setDiag('running');
    setDiag(await runDiagnostics(diagnostics));
  }

  return (
    <div class="error-block" role="alert">
      <div class="error-title">{title || 'Error'}</div>
      <div>{parsed.message}</div>
      {consequence && <div style={{ marginTop: '.3rem', fontStyle: 'italic' }}>{consequence}</div>}
      {isCorsLike && (
        <div style={{ marginTop: '.3rem' }}>
          <strong>Note:</strong> This may be a CORS error, or it may be an authentication or
          routing failure masked by the browser's CORS layer. Verify your endpoint URL, bucket
          name, and credentials using a non-browser tool (e.g. curl or the AWS CLI) to see the
          actual error response.
        </div>
      )}
      {isCorsLike && diagnostics && !diag && (
        <div style={{ marginTop: '.3rem' }}>
          <button type="button" onClick={handleDiagnose}>Run diagnostics</button>
        </div>
      )}
      {diag === 'running' && (
        <div style={{ marginTop: '.3rem' }}>Running diagnostics…</div>
      )}
      {diag && diag !== 'running' && (
        <div style={{ marginTop: '.3rem' }}>
          <div><strong>{VERDICT_MESSAGES[diag.verdict]}</strong></div>
          <ul style={{ margin: '.3rem 0 0', paddingLeft: '1.2rem', listStyle: 'none' }}>
            {diag.checks.map(c => (
              <li key={c.id}>
                {STATUS_ICONS[c.status]} {c.label}
                {c.detail ? ` — ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {guidance && <div style={{ marginTop: '.3rem' }}>{guidance}</div>}
      {(parsed.code || parsed.status || parsed.requestId) && (
        <details>
          <summary>Provider response details</summary>
          <pre>{JSON.stringify({ code: parsed.code, status: parsed.status, requestId: parsed.requestId, message: parsed.message }, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
```

Implementation notes:
- The `useState` call must come before the `if (!error) return null` early return (hooks rule) — as written above.
- Inline styles match the file's existing idiom; no CSS file changes.
- If the repo has an existing button class used inside panels (check `class="btn` occurrences in `src/components/SetupGuide.jsx` for a suitable class), use it on the button for consistent styling; otherwise leave it unstyled.

- [ ] **Step 4: Run component tests to verify they pass**

Run: `npm run test:ui`
Expected: PASS (all, including the four new tests)

- [ ] **Step 5: Run the unit suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit (ask operator first)**

```bash
git add src/components/ErrorBlock.jsx test/components/error-block.test.jsx
git commit -m "feat: Run-diagnostics button in ErrorBlock for CORS-masked errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread the diagnostics prop through call sites

**Files:**
- Modify: `src/components/App.jsx` (connect-screen ErrorBlock, ~line 447)
- Modify: `src/components/Browser.jsx` (three ErrorBlocks: ~lines 826, 1087, 1095; HiddenVersions render ~line 1354)
- Modify: `src/components/HiddenVersions.jsx` (accept + forward `diagnostics`, ErrorBlock ~line 217)

**Interfaces:**
- Consumes: `diagnosticsProps(credentials)` from Task 1; `diagnostics` prop on `ErrorBlock` from Task 2.
- Produces: `HiddenVersions` gains an optional `diagnostics` prop (same shape), forwarded to its ErrorBlock.

- [ ] **Step 1: App.jsx — connect screen**

Add the import (App.jsx already imports from `../lib/`; place alongside them):

```js
import { diagnosticsProps } from '../lib/connection-diagnostics.js';
```

At `session === 'failed'` block (~line 447), `credentials` state holds the attempted values (`handleConnect` calls `setCredentials(fullCreds)` before the try — verified). Change:

```jsx
<ErrorBlock
  error={connectionError}
  title="Connection failed"
  guidance="Check your endpoint URL, bucket name, and credentials. If this looks like a CORS error, ensure CORS is configured on your bucket."
  diagnostics={diagnosticsProps(credentials)}
/>
```

- [ ] **Step 2: Browser.jsx — three ErrorBlocks + HiddenVersions forwarding**

Browser already receives `credentials` (verified: `Browser({ client, bucket, provider, credentials, ... })`, App passes `credentials={credentials}`). Add the import:

```js
import { diagnosticsProps } from '../lib/connection-diagnostics.js';
```

Add `diagnostics={diagnosticsProps(credentials)}` to all three ErrorBlocks (~lines 826 "Cannot list bucket contents", 1087 "Download failed", 1095 "Listing failed"), e.g.:

```jsx
<ErrorBlock
  error={listError}
  title="Cannot list bucket contents"
  guidance="Check that your key has ListObjects permission on this bucket."
  diagnostics={diagnosticsProps(credentials)}
/>
```

And forward to HiddenVersions (~line 1354):

```jsx
<HiddenVersions key={prefix} client={client} bucket={bucket} prefix={prefix} provider={provider} diagnostics={diagnosticsProps(credentials)} />
```

- [ ] **Step 3: HiddenVersions.jsx — accept and forward**

Add `diagnostics` to the component's destructured props, then:

```jsx
<ErrorBlock
  error={error}
  title="Failed to list versions"
  guidance="Check that your credentials have s3:ListObjectVersions permission and that versioning is supported by this provider."
  diagnostics={diagnostics}
/>
```

- [ ] **Step 4: Verify — build + both suites**

Run: `npm run build` → Expected: exit 0 (build invariants pass)
Run: `npm test` → Expected: PASS
Run: `npm run test:ui` → Expected: PASS (existing app/browser-internals/hidden-versions component tests unaffected — the prop is optional everywhere)

- [ ] **Step 5: Manual smoke test**

Run: `npm run serve`, open `http://localhost:3000`, enter a real-looking endpoint with a garbage bucket/hostname (e.g. endpoint `https://s3.definitely-not-a-real-host-xyz.example`), attempt to connect, click **Run diagnostics** → expect `endpoint-unreachable` verdict with the check list. Then repeat with a reachable endpoint (e.g. `https://s3.us-east-005.backblazeb2.com` + a nonsense bucket, no CORS) → expect `bucket-host-unreachable` or `cors-blocked` depending on provider wildcard DNS. Report what was seen — do not claim verified without doing it.

- [ ] **Step 6: Commit (ask operator first)**

```bash
git add src/components/App.jsx src/components/Browser.jsx src/components/HiddenVersions.jsx
git commit -m "feat: thread connection diagnostics into App, Browser, HiddenVersions error blocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Version bump + CHANGELOG

**Files:**
- Modify: `package.json` (version `1.37.5` → `1.38.0`)
- Modify: `CHANGELOG.md` (new top entry)

**Interfaces:**
- Consumes: nothing from other tasks (but must run last).
- Produces: release-ready main; the build invariant requires CHANGELOG top entry to match `package.json` in the same commit.

- [ ] **Step 1: Confirm the bump with the operator**

Present: minor bump 1.37.5 → 1.38.0 (new backwards-compatible user-facing feature, per the approved spec). Wait for explicit confirmation of both changes and level. Do not proceed without it.

- [ ] **Step 2: Update package.json**

Change `"version": "1.37.5"` → `"version": "1.38.0"`.

- [ ] **Step 3: Add CHANGELOG entry at the very top**

```markdown
## [1.38.0] — 2026-07-26 — Connection diagnostics

- New **Run diagnostics** button on CORS-masked network errors (connect screen,
  listing, download, and hidden-versions errors). Runs static checks (offline,
  mixed content, URL validity) plus unauthenticated `no-cors` reachability
  probes of the endpoint and bucket hostname, then reports a single precise
  verdict — e.g. "endpoint unreachable" vs. "almost certainly missing CORS
  configuration" — instead of the generic three-way guess. Nothing runs until
  clicked; credentials are never attached to probes.
```

(Match the exact heading format of existing entries in CHANGELOG.md — em-dash separators.)

- [ ] **Step 4: Verify build (enforces version/CHANGELOG match) and full suites**

Run: `npm run build` → Expected: exit 0
Run: `npm test` → Expected: PASS
Run: `npm run test:ui` → Expected: PASS

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add package.json CHANGELOG.md src/lib/changelog.js
git commit -m "chore: release v1.38.0 — connection diagnostics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Note: `src/lib/changelog.js` is regenerated by the build — include it if the build modified it (check `git status`); never hand-edit it.

- [ ] **Step 6: Push (operator decision)**

Ask the operator whether to push. The pre-push hook runs build + tests and auto-tags `v1.38.0`.
