<!-- Design note: encrypted share links
     Captured 2026-06-02. Not yet scheduled for implementation. -->

## Idea

Instead of naked parameters in the hash fragment (`#endpoint=...&bucket=...`), encode
the share payload as a base64 AES-encrypted blob. The encryption key is derived from
something embedded in the app itself (a build-time constant or version-derived value),
with a per-link salt/IV included in the URL. Decoding requires running the URL through
the app — passive observers (server log scrapers, link preview crawlers, shoulder-surfers,
copy-paste leaks) cannot read the contents.

The decrypted payload is JSON containing prefill metadata only. Secret key is never
included. Key ID could potentially be included under this scheme — the casual exposure
risk that justified excluding it from the current naked-param links would be mitigated.

---

## Proposed URL format

```
#v2:<base64-IV>.<base64-ciphertext>
```

The `v2:` prefix allows the app to distinguish the new format from the current v1
naked-param format and maintain backward compatibility. V1 links continue to work;
v2 links are decrypted before prefilling.

Payload JSON (before encryption):
```json
{
  "endpoint": "https://s3.us-west-004.backblazeb2.com",
  "bucket": "my-bucket",
  "provider": "b2",
  "region": "us-west-004",
  "prefix": "photos/2024/",
  "keyId": "optional — inclusion is the point of this scheme"
}
```

---

## Key derivation

The encryption key is embedded in the app — derived at build time from a fixed
passphrase via PBKDF2 (SubtleCrypto, browser-native, no library needed). The salt
for PBKDF2 can be static (baked into the build) since its purpose is key stretching,
not per-link uniqueness; per-link uniqueness is handled by the AES-GCM IV.

Options for the embedded passphrase:
- A hard-coded build-time string (simplest)
- Derived from the app's own domain/origin at runtime (ties decryption to the deployment)
- Derived from the build-id meta tag (links become version-scoped — probably too aggressive)

Origin-derived is appealing: `window.location.origin` as the passphrase means a link
generated at `bucketer.hidayahtech.net` can only be decrypted by the same app at the
same origin. This is a meaningful property — it prevents a link from being decoded by
a different deployment of the app. Tradeoff: links break if the app moves to a new
domain, which is a usability cost worth documenting.

---

## Security properties (honest assessment)

This is **not** strong encryption in the cryptographic sense. Anyone who has the app
source (it's AGPLv3 — everyone does) can extract the key and decrypt any link.

What it DOES protect against:
- Server access logs
- Link preview services and crawlers
- Copy-paste into chat/email
- Shoulder-surfing of the address bar
- Browser history exposure

What it does NOT protect against:
- Anyone who inspects the app bundle (which is public)
- A recipient of the link who wants to extract the parameters

For the stated goal — reducing casual exposure of Key ID and connection metadata —
this is the right threat model to target. The secret key is still never included.

---

## Implementation notes

- `SubtleCrypto` (Web Crypto API) handles AES-GCM natively — no library needed,
  no bundle size impact beyond the implementation code itself
- IV is 12 bytes (96 bits), standard for AES-GCM — include in URL as base64
- PBKDF2 iterations: 100,000 minimum (NIST recommendation); result is cached in
  memory for the session so it's only computed once
- `buildShareUrl()` in `src/lib/url-params.js` is the right place for the v2 encoder
- `readUrlParams()` is the right place for the v2 decoder
- Backward compat: detect `#v2:` prefix; fall back to current param parsing otherwise
- Key ID inclusion in v2 links is opt-in or always-on — decide at implementation time

---

## Open questions

1. Should Key ID be included in v2 links always, opt-in, or never? The whole point
   of this scheme is to enable including it safely — but "safely" is relative given
   the key is in the app. Lean toward always-including if we do this, since the
   protection is uniform.

2. Origin-derived vs. fixed key: origin-derived is cleaner for the privacy story
   ("only decodeable by this app at this URL") but breaks links across deployments.
   Worth deciding before implementation since it affects the key derivation code.

3. Should we version the payload JSON? A `"v": 1` field would allow future payload
   changes without breaking old links.

4. Link length: AES-GCM ciphertext is input-length + 16 bytes (auth tag). A typical
   payload of ~200 bytes of JSON → ~216 bytes ciphertext → ~288 bytes base64, plus
   ~16 bytes for the IV. Total fragment ~320 bytes. Comfortable for a URL.
