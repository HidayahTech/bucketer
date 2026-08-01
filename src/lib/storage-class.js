// Copyright (C) 2026 HidayahTech, LLC
// Which objects cannot be downloaded because they are archived.
//
// This costs nothing: ListObjectsV2 already returns StorageClass on every object, so the
// answer is known at enumeration and no extra request is made. Flagged objects are marked
// SKIPPED rather than issued, because a GET against them fails until they are restored —
// issuing them would produce guaranteed failures the browser-managed tier cannot even
// observe (it sees that it handed a URL over, never what came back).
//
// THE LIST IS DELIBERATELY SHORT, and each exclusion cost real reading:
//
//   GLACIER, DEEP_ARCHIVE   A GET fails until a RestoreObject completes. Flag these.
//
//   GLACIER_IR              "Instant Retrieval" serves a GET directly, like any other
//                           class. Flagging it would refuse downloads that work perfectly.
//
//   INTELLIGENT_TIERING     AWS reports this class whatever the internal tier, including
//                           when an object has moved to an archive tier. The listing
//                           therefore cannot distinguish a readable object from an
//                           archived one. Flagging all of them refuses working downloads;
//                           flagging none lets a few fail. We flag none, because a failure
//                           the user can retry beats a refusal they cannot override.
//
// AWS ONLY. No other S3-compatible provider has a storage tier where a plain GET fails,
// and several of them accept or echo AWS class names without the archive semantics — so
// keying on the class name alone would flag files that download fine.

import { PROVIDERS } from './provider.js';

const ARCHIVED = new Set(['GLACIER', 'DEEP_ARCHIVE']);

// An unknown provider flags nothing. Jobs enumerated before the provider was recorded on
// the job have none, and refusing their files would be worse than letting an archived one
// fail — the failure is visible and retryable, the refusal is neither.
export function isArchivedStorageClass(storageClass, provider) {
  if (provider !== PROVIDERS.AWS) return false;
  return ARCHIVED.has(storageClass);
}
