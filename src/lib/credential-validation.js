// Copyright (C) 2026 HidayahTech, LLC
// Field-level validation for S3 credential input (BUG-016).
//
// Machine-generated S3 credentials — key ID, secret key — never contain
// whitespace. A space in any identifier field is unambiguous evidence of a
// paste accident. Bucket names are universally capped at 63 characters across
// all S3-compatible providers; spaces are invalid in every spec.

// Returns true only when the three fields that make a profile useful are
// present and individually valid. Secret key is intentionally excluded —
// it is never persisted in profiles.
export function canSaveProfile(formData) {
  if (!formData) return false;
  const { endpoint, bucket, keyId } = formData;
  const ep = (endpoint || '').trim();
  const bk = (bucket  || '').trim();
  const ki = (keyId   || '').trim();
  if (!ep || !bk || !ki) return false;
  try { new URL(ep); } catch { return false; }
  if (/\s/.test(bk) || bk.length > 63) return false;
  if (/\s/.test(ki)) return false;
  return true;
}

export function credentialErrors(form) {
  const e = {};
  if (form.bucket && /\s/.test(form.bucket))
    e.bucket = 'Bucket names cannot contain spaces.';
  else if (form.bucket && form.bucket.length > 63)
    e.bucket = "Bucket name exceeds 63 characters — verify your provider's naming rules.";
  if (form.keyId && /\s/.test(form.keyId))
    e.keyId = 'Key ID must not contain spaces — check for an accidental paste.';
  if (form.secretKey && /\s/.test(form.secretKey))
    e.secretKey = 'Secret key must not contain spaces — check for an accidental paste.';
  if (form.regionOverride && /\s/.test(form.regionOverride))
    e.regionOverride = 'Region must not contain spaces.';
  return e;
}
