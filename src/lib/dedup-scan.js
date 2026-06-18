// Copyright (C) 2026 HidayahTech, LLC
// Duplicate-detection engine (read-only). Produces *candidate* groups cheaply; never
// decides a deletion. byte-for-byte verification (verify-bytes.js) is the only thing
// that confirms identity, because no hash — not even SHA-256 — is collision-proof.
//
// Pipeline (cheapest first, each step only narrows candidates):
//   enumerateObjects → groupBySize → headSizeGroups → classifyGroups → [verify]
//
// The engine is read-only: it lists and HEADs objects and never mutates them.

import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CONTENT_HASH_KEY, DEDUP_HEAD_CONCURRENCY } from './constants.js';
import { parseContentHash } from './content-hash.js';

// Fully enumerate every object under a prefix (flat — no delimiter), paginating until
// the listing is exhausted. Captures only the fields the engine needs.
export async function enumerateObjects(client, bucket, prefix, { maxKeys = 1000, onProgress } = {}) {
  const objects = [];
  let token;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: maxKeys,
      ContinuationToken: token,
    }));
    for (const o of resp.Contents || []) {
      objects.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified });
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    onProgress?.({ phase: 'listing', count: objects.length });
  } while (token);
  return objects;
}

// Group objects by exact byte size, keeping only collisions (>=2). Zero-byte objects are
// excluded: they are dominated by folder markers and empty placeholders and grouping them
// is noise, not signal.
export function groupBySize(objects) {
  const bySize = new Map();
  for (const o of objects) {
    if (o.Size <= 0) continue;
    if (!bySize.has(o.Size)) bySize.set(o.Size, []);
    bySize.get(o.Size).push(o);
  }
  const groups = [];
  for (const list of bySize.values()) {
    if (list.length >= 2) groups.push(list);
  }
  return groups;
}

// Derive cheap match signals from a HeadObject response. An ETag is only trusted as an
// MD5 when the object is single-part and not SSE-KMS/SSE-C (those ETags are not MD5).
export function deriveSignals(head) {
  const rawEtag = String(head?.ETag || '').replace(/"/g, '');
  const multipart = /-\d+$/.test(rawEtag);
  const encrypted = head?.ServerSideEncryption === 'aws:kms' || !!head?.SSECustomerAlgorithm;
  const etagMd5 = (!multipart && !encrypted && /^[0-9a-f]{32}$/.test(rawEtag)) ? rawEtag : null;
  const stampHash = parseContentHash(head?.Metadata?.[CONTENT_HASH_KEY]);
  return { etagMd5, multipart, stampHash };
}

// Concurrency-capped HeadObject pool over the members of every size-collision group.
// Enriches each member in place with deriveSignals(), and — when a provider checksum
// adapter is supplied — an opportunistic `providerSig`. A failed HEAD leaves the member
// without signals (it simply won't match cheaply); the error is recorded for diagnostics.
export async function headSizeGroups(client, bucket, groups, opts = {}) {
  const { concurrency = DEDUP_HEAD_CONCURRENCY, adapter, onProgress } = opts;
  const work = [];
  for (const g of groups) for (const m of g) work.push(m);

  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < work.length) {
      const m = work[idx++];
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: m.Key }));
        Object.assign(m, deriveSignals(head));
        if (adapter) {
          const sig = await adapter(client, bucket, m.Key, head);
          if (sig) m.providerSig = sig;
        }
      } catch (err) {
        m._headError = err;
      }
      done++;
      onProgress?.({ phase: 'heading', done, total: work.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) || 0 }, worker));
  return groups;
}

// Concrete, comparable signals for a member. Two members sharing any concrete key are
// candidates for being identical. (No concrete key → "unresolved" by cheap signals.)
function concreteKeys(m) {
  const keys = [];
  if (m.etagMd5) keys.push('md5:' + m.etagMd5);
  if (m.stampHash) keys.push('stamp:' + m.stampHash.scheme + ':' + m.stampHash.hex);
  if (m.providerSig) keys.push('prov:' + m.providerSig);
  return keys;
}

// Connected components of members linked by shared concrete keys (union-find). A member
// carrying two signals bridges clusters that would otherwise be separate.
function clusterByKeys(members) {
  const parent = members.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };

  const keyToIdx = new Map();
  members.forEach((m, i) => {
    for (const k of concreteKeys(m)) {
      if (keyToIdx.has(k)) union(i, keyToIdx.get(k));
      else keyToIdx.set(k, i);
    }
  });

  const comps = new Map();
  members.forEach((m, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(m);
  });
  return [...comps.values()];
}

const MATCH_PRIORITY = ['md5', 'prov', 'stamp'];

function pickMatchedBy(members) {
  const counts = new Map();
  for (const m of members) for (const k of concreteKeys(m)) counts.set(k, (counts.get(k) || 0) + 1);
  const kinds = new Set();
  for (const [k, c] of counts) if (c >= 2) kinds.add(k.split(':')[0]);
  return MATCH_PRIORITY.find((p) => kinds.has(p)) || null;
}

function makeGroup(members, matchedBy) {
  const ordered = members.slice().sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));
  const size = ordered[0].Size;
  return {
    size,
    members: ordered, // oldest first → ordered[0] is the default keeper
    matchedBy,
    confidence: 'candidate', // only byte-for-byte verification promotes a group to 'verified'
    verified: false,
    reclaimableBytes: size * (ordered.length - 1),
  };
}

// Turn headed size-collision groups into duplicate *candidate* groups. Within each size
// group: members sharing a concrete signal cluster together; same-size members with no
// cheap signal at all become a single "size" candidate (to be resolved by verification).
// Lone members (a unique concrete signal, or a single unresolved object) are dropped —
// they have no duplicate among same-size objects by any cheap signal.
export function classifyGroups(sizeGroups) {
  const result = [];
  for (const group of sizeGroups) {
    const withKeys = group.filter((m) => concreteKeys(m).length > 0);
    const noKeys = group.filter((m) => concreteKeys(m).length === 0);

    for (const comp of clusterByKeys(withKeys)) {
      if (comp.length >= 2) result.push(makeGroup(comp, pickMatchedBy(comp)));
    }
    if (noKeys.length >= 2) result.push(makeGroup(noKeys, 'size'));
  }
  return result;
}

// Orchestrator: enumerate → group → head → classify. Returns candidate groups. Read-only.
export async function scanForDuplicates(client, bucket, prefix, opts = {}) {
  const { maxKeys, concurrency, adapter, onProgress } = opts;
  const objects = await enumerateObjects(client, bucket, prefix, { maxKeys, onProgress });
  const sized = groupBySize(objects);
  onProgress?.({ phase: 'grouped', candidates: sized.reduce((n, g) => n + g.length, 0) });
  await headSizeGroups(client, bucket, sized, { concurrency, adapter, onProgress });
  const groups = classifyGroups(sized);
  onProgress?.({ phase: 'done', groups: groups.length });
  return groups;
}
