# Endpoint ↔ Region Bidirectional Inference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the credential form infer the endpoint from a selected provider + typed region, and auto-fill the region field from the endpoint URL — both directions, with a visible "auto-filled" indicator that disappears when the user edits the field.

**Architecture:** Add `buildEndpoint(provider, region)` to `provider.js` as the inverse of `extractRegion`. Refactor `CredentialForm` to track user-edited vs auto-filled fields via a ref, compute inference inside a shared `applyChange` helper called by both `set` and `onPaste`, and always render the region field (removing the `needsRegion` conditional hide). Inferred values are flagged in form state (`_infEndpoint`, `_infRegion`) to drive the "Auto-filled" hints.

**Tech Stack:** Preact, plain Node test runner (`node --test`)

**Spec:** `docs/superpowers/specs/2026-06-07-endpoint-region-inference-design.md`

---

### Task 1: Add `buildEndpoint` to `provider.js` + tests

**Files:**
- Modify: `src/lib/provider.js`
- Modify: `test/provider.test.js`

- [ ] **Step 1: Write the failing tests**

Open `test/provider.test.js`. Import `buildEndpoint` alongside existing imports at the top of the file and add the test suite at the bottom:

```js
// Add to the import line (find the existing import of detectProvider etc.):
import { detectProvider, extractRegion, requiresPathStyle, defaultMaxKeys, needsCorsConfig, buildEndpoint } from '../src/lib/provider.js';

// Add at the bottom of the file, after existing test suites:
describe('buildEndpoint', () => {
  // B2 — template https://s3.{region}.backblazeb2.com, no exceptions
  // Source: https://www.backblaze.com/docs/cloud-storage-data-regions (fetched 2026-06-04)
  it('B2 us-west-004', () => assert.equal(buildEndpoint('b2', 'us-west-004'), 'https://s3.us-west-004.backblazeb2.com'));
  it('B2 eu-central-003', () => assert.equal(buildEndpoint('b2', 'eu-central-003'), 'https://s3.eu-central-003.backblazeb2.com'));
  it('B2 us-east-005', () => assert.equal(buildEndpoint('b2', 'us-east-005'), 'https://s3.us-east-005.backblazeb2.com'));

  // Wasabi — legacy us-east-1 exception (bare hostname, no region segment)
  // Source: https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions (fetched 2026-06-04, 2026-06-07)
  it('Wasabi us-east-1 legacy endpoint', () => assert.equal(buildEndpoint('wasabi', 'us-east-1'), 'https://s3.wasabisys.com'));
  it('Wasabi us-east-2 regional', () => assert.equal(buildEndpoint('wasabi', 'us-east-2'), 'https://s3.us-east-2.wasabisys.com'));
  it('Wasabi eu-central-1 regional', () => assert.equal(buildEndpoint('wasabi', 'eu-central-1'), 'https://s3.eu-central-1.wasabisys.com'));
  it('Wasabi ap-southeast-2 regional', () => assert.equal(buildEndpoint('wasabi', 'ap-southeast-2'), 'https://s3.ap-southeast-2.wasabisys.com'));
  // Legacy alias slug — builds alias URL (valid; extractRegion maps nl-1→eu-central-1 for signing)
  it('Wasabi nl-1 alias builds alias URL', () => assert.equal(buildEndpoint('wasabi', 'nl-1'), 'https://s3.nl-1.wasabisys.com'));

  // AWS — template https://s3.{region}.amazonaws.com, no exceptions
  // Source: https://docs.aws.amazon.com/general/latest/gr/s3.html (fetched 2026-06-04)
  it('AWS us-east-1', () => assert.equal(buildEndpoint('aws', 'us-east-1'), 'https://s3.us-east-1.amazonaws.com'));
  it('AWS eu-west-2', () => assert.equal(buildEndpoint('aws', 'eu-west-2'), 'https://s3.eu-west-2.amazonaws.com'));
  it('AWS ap-southeast-1', () => assert.equal(buildEndpoint('aws', 'ap-southeast-1'), 'https://s3.ap-southeast-1.amazonaws.com'));

  // DO Spaces — template https://{region}.digitaloceanspaces.com, no exceptions
  // Source: https://docs.digitalocean.com/products/spaces/details/availability/ (fetched 2026-06-04)
  it('DO Spaces nyc3', () => assert.equal(buildEndpoint('do_spaces', 'nyc3'), 'https://nyc3.digitaloceanspaces.com'));
  it('DO Spaces ams3', () => assert.equal(buildEndpoint('do_spaces', 'ams3'), 'https://ams3.digitaloceanspaces.com'));
  it('DO Spaces syd1', () => assert.equal(buildEndpoint('do_spaces', 'syd1'), 'https://syd1.digitaloceanspaces.com'));

  // No-inference providers — endpoint requires info beyond region
  // R2: needs account ID. Source: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ (fetched 2026-06-04)
  it('R2 returns null', () => assert.equal(buildEndpoint('r2', 'auto'), null));
  it('MinIO returns null', () => assert.equal(buildEndpoint('minio', 'us-east-1'), null));
  it('Generic returns null', () => assert.equal(buildEndpoint('generic', 'us-east-1'), null));

  // Null/empty guards
  it('null region returns null', () => assert.equal(buildEndpoint('b2', null), null));
  it('empty string region returns null', () => assert.equal(buildEndpoint('b2', ''), null));
  it('unknown provider returns null', () => assert.equal(buildEndpoint('unknown', 'us-east-1'), null));
});
```

Note: `describe` and `it` in the test files are aliases — check the top of `provider.test.js` to confirm the exact wrappers used and match them.

- [ ] **Step 2: Verify tests fail**

```
npm test 2>&1 | grep -A3 "buildEndpoint"
```

Expected: `ReferenceError: buildEndpoint is not defined` or similar import error.

- [ ] **Step 3: Implement `buildEndpoint` in `provider.js`**

Add after the `needsCorsConfig` function (around line 125):

```js
// Build the canonical HTTPS endpoint URL for a known provider + region string.
// Returns null when the endpoint cannot be constructed from region alone:
//   R2 requires an account ID; MinIO/Generic have no standard hostname pattern.
//
// Doc sources (all fetched 2026-06-04, verified against project review docs):
//   B2:        https://www.backblaze.com/docs/cloud-storage-data-regions
//   Wasabi:    https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions
//   AWS:       https://docs.aws.amazon.com/general/latest/gr/s3.html
//   DO Spaces: https://docs.digitalocean.com/products/spaces/details/availability/
export function buildEndpoint(provider, region) {
  if (!region) return null;
  switch (provider) {
    case PROVIDERS.B2:
      return `https://s3.${region}.backblazeb2.com`;
    case PROVIDERS.WASABI:
      // us-east-1 uses the legacy bare endpoint (no region segment in hostname).
      // All other regions follow the standard template.
      return region === 'us-east-1'
        ? 'https://s3.wasabisys.com'
        : `https://s3.${region}.wasabisys.com`;
    case PROVIDERS.AWS:
      return `https://s3.${region}.amazonaws.com`;
    case PROVIDERS.DO_SPACES:
      return `https://${region}.digitaloceanspaces.com`;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests and verify all pass**

```
npm test 2>&1 | tail -8
```

Expected:
```
# tests 509
# pass  509
# fail  0
```

(Count increases by the number of new `buildEndpoint` tests added.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/provider.js test/provider.test.js
git commit -m "$(cat <<'EOF'
Add buildEndpoint to provider.js — inverse of extractRegion

Constructs the canonical endpoint URL for B2, Wasabi, AWS, and DO Spaces
from a provider+region pair. Returns null for R2 (needs account ID),
MinIO, and Generic. Wasabi's us-east-1 exception (bare s3.wasabisys.com
hostname) is handled explicitly.

Sources verified against project review docs in docs/review-v1.14.0/06-providers/
and live Wasabi doc fetch 2026-06-07.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Refactor `CredentialForm` — state, inference, always-visible region field

**Files:**
- Modify: `src/components/CredentialForm.jsx`

This is the main implementation task. Replace the entire file with the version below.
Read the current file first to confirm line numbers haven't drifted, then apply the changes.

- [ ] **Step 1: Update imports — add `buildEndpoint` and `useRef`**

Change the import lines at the top of `CredentialForm.jsx`:

Old:
```js
import { useState } from 'preact/hooks';
import { detectProvider, extractRegion, PROVIDERS, PROVIDER_LABELS } from '../lib/provider.js';
```

New:
```js
import { useState, useRef } from 'preact/hooks';
import { detectProvider, extractRegion, buildEndpoint, PROVIDERS, PROVIDER_LABELS } from '../lib/provider.js';
```

- [ ] **Step 2: Replace the component opening — new state, ref, and `applyChange` helper**

Replace the entire `export function CredentialForm(...)` block up to (but not including)
`const errors = credentialErrors(form);` with the following:

```js
export function CredentialForm({ initial, onSave, onFormChange, loading }) {
  // Only treat stored provider as an explicit override if it differs from what
  // auto-detection returns for the stored endpoint. Auto-detected providers should
  // leave the dropdown at "Auto-detect from endpoint".
  const _autoDetected = initial.provider && initial.endpoint
    ? detectProvider(initial.endpoint)
    : null;
  const _initProviderOverride = (initial.provider && initial.provider !== _autoDetected)
    ? initial.provider
    : '';

  // Compute initial inferred region: if the endpoint is stored but no regionOverride
  // is, extract the region so it's visible in the field on load.
  const _initExtractedRegion = (() => {
    if (initial.regionOverride || !initial.endpoint) return null;
    const prov = _initProviderOverride || detectProvider(initial.endpoint);
    return extractRegion(initial.endpoint, prov);
  })();

  // userEditedRef: which fields the user has directly typed/pasted into.
  // Inference only flows from user-edited fields into non-user-edited fields.
  // This is a ref (not state) because it does not affect rendering.
  const userEditedRef = useRef({
    endpoint: !!initial.endpoint,
    // region is user-edited only when a stored regionOverride exists and differs from
    // what extraction gives — a stored value that matches auto-extraction is treated as
    // inferred so that changing the endpoint can update it.
    region: !!(initial.regionOverride && initial.regionOverride !== _initExtractedRegion),
  });

  const [form, setForm] = useState({
    endpoint:         initial.endpoint || '',
    bucket:           initial.bucket || '',
    keyId:            initial.keyId || '',
    secretKey:        initial.secretKey || '',
    providerOverride: _initProviderOverride,
    regionOverride:   initial.regionOverride || _initExtractedRegion || '',
    _infEndpoint:     false,
    _infRegion:       !!(_initExtractedRegion && !initial.regionOverride),
  });

  // applyChange: compute the next form state for a field change, including all
  // inference side-effects. Called by both `set` (input) and `onPaste`.
  function applyChange(prev, k, value) {
    const ue = userEditedRef.current;
    if (k === 'endpoint')       ue.endpoint = true;
    if (k === 'regionOverride') ue.region   = true;

    const next = { ...prev, [k]: value };

    // Editing a field removes its own inferred marker.
    if (k === 'endpoint')       next._infEndpoint = false;
    if (k === 'regionOverride') next._infRegion   = false;

    // ── Endpoint → region ──────────────────────────────────────────────────────
    if (k === 'endpoint' && !ue.region) {
      const prov = next.providerOverride || detectProvider(next.endpoint);
      const extracted = next.endpoint ? extractRegion(next.endpoint, prov) : null;
      if (extracted) {
        next.regionOverride = extracted;
        next._infRegion = true;
      } else if (prev._infRegion) {
        // Endpoint changed and no longer contains a region — clear the inferred value.
        next.regionOverride = '';
        next._infRegion = false;
      }
    }

    // ── Region → endpoint ──────────────────────────────────────────────────────
    if (k === 'regionOverride' && !ue.endpoint) {
      const prov = next.providerOverride
        || (next.endpoint ? detectProvider(next.endpoint) : null);
      const built = (prov && value) ? buildEndpoint(prov, value) : null;
      if (built) {
        next.endpoint = built;
        next._infEndpoint = true;
      } else if (!value && prev._infEndpoint) {
        // Region cleared — remove the inferred endpoint too.
        next.endpoint = '';
        next._infEndpoint = false;
      }
    }

    // ── Provider override change ───────────────────────────────────────────────
    if (k === 'providerOverride') {
      const newProv = value;

      // R2 auto-fills 'auto' as region; clear it when switching away from R2.
      if (prev._infRegion && prev.regionOverride === 'auto' && newProv !== PROVIDERS.R2) {
        next.regionOverride = '';
        next._infRegion = false;
      }

      // Re-extract region from current endpoint using the new provider.
      if (!ue.region && next.endpoint && !next.regionOverride) {
        const extracted = extractRegion(next.endpoint, newProv || detectProvider(next.endpoint));
        if (extracted) {
          next.regionOverride = extracted;
          next._infRegion = true;
        }
      }

      // R2 always uses 'auto' as the SigV4 region.
      if (!ue.region && newProv === PROVIDERS.R2) {
        next.regionOverride = 'auto';
        next._infRegion = true;
      }

      // Rebuild endpoint from new provider + current region (if endpoint not user-owned).
      if (!ue.endpoint && next.regionOverride && newProv) {
        const built = buildEndpoint(newProv, next.regionOverride);
        if (built) {
          next.endpoint = built;
          next._infEndpoint = true;
        } else if (prev._infEndpoint) {
          // New provider can't build an endpoint (e.g. switching to MinIO) — clear inferred.
          next.endpoint = '';
          next._infEndpoint = false;
        }
      }
    }

    return next;
  }

  const set = (k) => (e) => setForm(prev => {
    const next = applyChange(prev, k, e.target.value);
    onFormChange?.(next);
    return next;
  });

  // onPaste: intercepts only when pasted text has surrounding whitespace (common
  // copy/paste artifact). Uses applyChange so inference fires on trimmed pastes too.
  const onPaste = (k) => (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || text === text.trim()) return;
    e.preventDefault();
    const trimmed = text.trim();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end   = el.selectionEnd   ?? el.value.length;
    setForm(prev => {
      const cur  = prev[k] || '';
      const next = applyChange(prev, k, cur.slice(0, start) + trimmed + cur.slice(end));
      onFormChange?.(next);
      return next;
    });
  };
```

- [ ] **Step 3: Update `handleSubmit` and the detection hints**

The `handleSubmit` function is unchanged but the `detected`/`regionHint`/`needsRegion`
derived values need updating. Replace the block from `const errors = ...` to just before
`return (` with:

```js
  const errors = credentialErrors(form);
  const hasErrors = Object.keys(errors).length > 0;

  const detected = form.endpoint ? detectProvider(form.endpoint) : null;
  const detectedLabel = detected ? PROVIDER_LABELS[detected] : null;
  // regionHint and needsRegion are removed — the region field is always shown,
  // and inference fills it when the endpoint contains a region.

  function handleSubmit(e) {
    e.preventDefault();
    if (hasErrors) return;
    const provider = form.providerOverride || detected || PROVIDERS.GENERIC;
    onSave({
      endpoint: form.endpoint.trim().replace(/\/$/, ''),
      bucket: form.bucket.trim(),
      keyId: form.keyId.trim(),
      secretKey: form.secretKey,
      provider,
      regionOverride: form.regionOverride.trim(),
    });
  }
```

- [ ] **Step 4: Update the JSX — endpoint hint, region field always rendered**

In the return block, make these two changes:

**4a. Endpoint field hint** — remove the `regionHint` from the detected-provider hint:

Old:
```jsx
        {detectedLabel && !form.providerOverride && (
          <span class="hint">Detected: {detectedLabel}{regionHint ? ` · Region: ${regionHint}` : ''}</span>
        )}
```

New:
```jsx
        {form._infEndpoint && (
          <span class="hint">Auto-filled from provider and region</span>
        )}
        {detectedLabel && !form.providerOverride && (
          <span class="hint">Detected: {detectedLabel}</span>
        )}
```

**4b. Replace the conditional region block** — remove the `{needsRegion && ...}` block
and replace with an always-rendered region group:

Old:
```jsx
      {needsRegion && (
        <div class="form-group">
          <label htmlFor="cred-region">Region</label>
          <input
            id="cred-region"
            type="text"
            value={form.regionOverride}
            onInput={set('regionOverride')}
            onPaste={onPaste('regionOverride')}
            placeholder="us-east-1"
            autocomplete="off"
            spellcheck={false}
          />
          <span class="hint">Cannot be auto-detected for this endpoint. For R2, use "auto".</span>
          {errors.regionOverride && <span class="field-error">{errors.regionOverride}</span>}
        </div>
      )}
```

New:
```jsx
      <div class="form-group">
        <label htmlFor="cred-region">Region</label>
        <input
          id="cred-region"
          type="text"
          value={form.regionOverride}
          onInput={set('regionOverride')}
          onPaste={onPaste('regionOverride')}
          placeholder="us-east-1"
          autocomplete="off"
          spellcheck={false}
        />
        {form._infRegion && (
          <span class="hint">Auto-filled from endpoint URL</span>
        )}
        {!form._infRegion && !form.regionOverride && (
          <span class="hint">
            {form.providerOverride === PROVIDERS.R2
              ? 'R2 uses "auto" as the region — enter your endpoint above to auto-fill.'
              : 'Enter the region for this endpoint (e.g. us-east-1).'}
          </span>
        )}
        {errors.regionOverride && <span class="field-error">{errors.regionOverride}</span>}
      </div>
```

- [ ] **Step 5: Build and verify**

```
npm run build 2>&1 | tail -6
npm test 2>&1 | tail -8
```

Both should pass. Fix any JSX syntax errors before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/components/CredentialForm.jsx
git commit -m "$(cat <<'EOF'
CredentialForm: bidirectional endpoint↔region inference

- Provider + region → endpoint: when the region field is edited and a
  provider is known (via override dropdown or auto-detection), buildEndpoint
  constructs and auto-fills the endpoint URL.
- Endpoint → region: when the endpoint changes and a region can be extracted,
  the region field is auto-filled. Previously the extracted region was only
  shown as a hint next to the endpoint; now it is an editable field value.
- Provider override change: re-runs both directions — clears R2-specific
  'auto' region when switching away from R2, re-extracts region from the
  current endpoint with the new provider, auto-fills 'auto' for R2.
- userEditedRef prevents circular updates: inference only flows from
  user-edited fields into non-user-edited fields.
- Region field always rendered (needsRegion conditional removed). Auto-filled
  values show a "Auto-filled from …" hint that disappears on user edit.
- Endpoint hint simplified to "Detected: <provider>" (region no longer
  duplicated there; it appears in the region field itself).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Version bump + full build + push

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version to 1.15.5 and add CHANGELOG entry**

In `package.json`, change `"version": "1.15.4"` to `"version": "1.15.5"`.

At the top of the `CHANGELOG.md` entries (after the header block), insert:

```markdown
## [1.15.5] — 2026-06-07 — Bidirectional endpoint↔region inference in credential form

- **Region auto-filled from endpoint**: the region field is now always visible and is automatically populated when the endpoint URL embeds a region (B2, Wasabi, AWS, DO Spaces). Previously the extracted region was only shown as a sidebar hint; now it appears as an editable value with an "Auto-filled from endpoint URL" indicator.
- **Endpoint auto-filled from provider + region**: selecting a provider from the override dropdown and typing a region constructs and auto-fills the canonical endpoint URL ("Auto-filled from provider and region"). Provider-specific exceptions are handled: Wasabi's `us-east-1` produces `https://s3.wasabisys.com` (bare legacy hostname) rather than the naïve template. R2 auto-fills the region with `'auto'` (endpoint requires account ID and cannot be constructed). MinIO and Generic providers do not infer endpoints.
- **Endpoint patterns verified against official docs** (all fetched 2026-06-04/07): B2 via backblaze.com/docs, Wasabi via docs.wasabi.com, AWS via docs.aws.amazon.com/general, DO Spaces via docs.digitalocean.com, R2 via developers.cloudflare.com.
- **Circular update prevention**: a `userEditedRef` ensures inference only flows from user-typed fields into fields the user has not yet touched. Editing an auto-filled field marks it as user-owned and stops inference from overwriting it.
```

- [ ] **Step 2: Run full build + tests**

```
npm run build 2>&1 | tail -8
npm test 2>&1 | tail -8
```

Expected: build succeeds, all tests pass.

- [ ] **Step 3: Commit and push**

```bash
git add package.json CHANGELOG.md dist/index.html src/lib/changelog.js
git commit -m "$(cat <<'EOF'
v1.15.5 — Bidirectional endpoint↔region inference in credential form

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push origin main
```

The pre-push hook will run `npm run build` and `npm test` and create the `v1.15.5` tag.
