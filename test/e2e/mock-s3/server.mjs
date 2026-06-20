#!/usr/bin/env node
// Stateful in-memory mock S3 server for e2e tests. Dependency-free (node:http + node:crypto).
//
// It implements the exact subset of the S3 REST API that Bucketer uses, with REAL object
// state and REAL MD5 ETags, so tests can assert that an object actually landed / moved /
// was deleted — unlike the unit-test `mockClient` (which only stubs canned responses) and the
// old perf stub (which stored nothing). It is deliberately STRICT where real S3 is strict
// (DeleteObjects 1000 cap, multipart part-size + ETag validation, illegal self-copy) so it
// acts as a contract checker, not a rubber stamp.
//
// Addressing: handles both path-style (/{bucket}/{key}) and virtual-hosted ({bucket}.host/{key}).
// Auth: SigV4 signatures are ignored — the app is under test, not the signer. Presigned GETs
// (query-auth) are served by ignoring the query signature.
import http from 'node:http';
import crypto from 'node:crypto';

const md5hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const md5buf = (buf) => crypto.createHash('md5').update(buf).digest();
const nowISO = () => new Date().toISOString();
const newId  = () => crypto.randomBytes(16).toString('hex');
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Default CORS mirrors src/lib/cors-config.js corsJson(). allowedHeaders may contain wildcard
// entries (e.g. 'x-amz-*'); the preflight matches requested headers against them (like real S3).
const DEFAULT_CORS = () => ({
  allowedMethods: ['GET', 'PUT', 'HEAD', 'POST', 'DELETE'],
  allowedHeaders: ['authorization', 'content-type', 'content-md5', 'x-amz-*', 'amz-sdk-invocation-id', 'amz-sdk-request', 'etag'],
  exposeHeaders:  ['ETag', 'Content-Length', 'Content-Type', 'x-amz-meta-*'],
  maxAge: 3600,
});

function headerAllowed(configured, name) {
  const h = name.toLowerCase();
  return configured.some((entry) => {
    const e = entry.toLowerCase();
    if (e === '*') return true;
    if (e.endsWith('*')) return h.startsWith(e.slice(0, -1));
    return e === h;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export function createMockS3(opts = {}) {
  const baseHost  = opts.host ?? '127.0.0.1';
  const latencyMs = opts.latencyMs ?? 0;
  const buckets   = new Map(); // name -> { versioning, objects: Map<key, Version[]>, uploads: Map<id,…> }
  let cors        = DEFAULT_CORS();
  let faults      = [];        // [{ op?, method?, keyPrefix?, status, code, message, times }]

  function bkt(name) {
    if (!buckets.has(name)) buckets.set(name, { versioning: false, objects: new Map(), uploads: new Map() });
    return buckets.get(name);
  }
  // Current = last version that is not a delete marker (S3 semantics).
  function current(b, key) {
    const vs = b.objects.get(key);
    if (!vs || !vs.length) return null;
    const top = vs[vs.length - 1];
    return top.deleteMarker ? null : top;
  }
  function putVersion(b, key, ver) {
    if (!b.objects.has(key)) b.objects.set(key, []);
    const vs = b.objects.get(key);
    if (b.versioning) { vs.push(ver); } else { b.objects.set(key, [ver]); }
    return ver;
  }

  function reset()        { buckets.clear(); faults = []; cors = DEFAULT_CORS(); }
  function configure(cfg) {
    if (cfg.cors)   cors = { ...DEFAULT_CORS(), ...cfg.cors };
    if (cfg.faults) faults = cfg.faults;
    if (cfg.bucket && typeof cfg.versioning === 'boolean') bkt(cfg.bucket).versioning = cfg.versioning;
  }
  function matchFault(op, method, key) {
    const i = faults.findIndex((f) =>
      (f.op ? f.op === op : true) &&
      (f.method ? f.method === method : true) &&
      (f.keyPrefix ? (key || '').startsWith(f.keyPrefix) : true) &&
      (f.times == null || f.times > 0));
    if (i === -1) return null;
    const f = faults[i];
    if (f.times != null) f.times -= 1;
    return f;
  }

  // bucket/key from path-style or virtual-hosted addressing.
  function parseTarget(req) {
    const hostHdr = (req.headers.host || baseHost).split(':')[0];
    const url = new URL(req.url, `http://${hostHdr}`);
    const virtualHosted = hostHdr !== baseHost && hostHdr !== 'localhost' && !/^127\./.test(hostHdr) && hostHdr.includes('.');
    let bucket, key;
    if (virtualHosted) {
      bucket = hostHdr.split('.')[0];
      key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } else {
      const segs = url.pathname.replace(/^\//, '').split('/');
      bucket = segs.shift();
      key = decodeURIComponent(segs.join('/'));
    }
    return { bucket, key, url };
  }

  function corsHeaders(req, metadataKeys = []) {
    const origin = req.headers.origin;
    const h = {};
    if (origin) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Vary'] = 'Origin';
    } else {
      h['Access-Control-Allow-Origin'] = '*';
    }
    // Expose concrete metadata header names (browsers don't expand x-amz-meta-* wildcards).
    // CRITICAL for the BUG-028 regression: only expand x-amz-meta-* into concrete header names when
    // the *configured* exposeHeaders actually permits it (contains 'x-amz-meta-*' or '*'). A narrowed
    // config must genuinely hide custom metadata from the browser, exactly as real S3 does.
    const expose = new Set(['ETag', 'Content-Length', 'Content-Type', 'x-amz-request-id', 'x-amz-version-id']);
    for (const e of cors.exposeHeaders) if (!e.endsWith('*')) expose.add(e);
    const metaExposed = cors.exposeHeaders.some((e) => e === '*' || e.toLowerCase() === 'x-amz-meta-*');
    if (metaExposed) for (const k of metadataKeys) expose.add(`x-amz-meta-${k}`);
    h['Access-Control-Expose-Headers'] = [...expose].join(', ');
    return h;
  }

  function preflight(req, res) {
    const reqHeaders = (req.headers['access-control-request-headers'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = reqHeaders.filter((name) => headerAllowed(cors.allowedHeaders, name));
    // If the app requested a header the rule doesn't allow, omit it → browser blocks the real request.
    res.writeHead(200, {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': cors.allowedMethods.join(', '),
      'Access-Control-Allow-Headers': allowed.join(', '),
      'Access-Control-Max-Age': String(cors.maxAge),
      'Content-Length': '0',
    });
    res.end();
  }

  function sendXml(req, res, status, body, extra = {}) {
    res.writeHead(status, { ...corsHeaders(req), 'Content-Type': 'application/xml', ...extra });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
  }
  function sendError(req, res, status, code, message = code) {
    sendXml(req, res, status, `<Error><Code>${xmlEsc(code)}</Code><Message>${xmlEsc(message)}</Message></Error>`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const method = req.method;

      if (method === 'OPTIONS') return preflight(req, res);

      // Admin control plane (tests only).
      if (req.url.startsWith('/__admin/')) {
        const body = await readBody(req);
        if (req.url === '/__admin/reset') { reset(); res.writeHead(200, corsHeaders(req)); return res.end('{"ok":true}'); }
        if (req.url === '/__admin/config') { configure(body.length ? JSON.parse(body) : {}); res.writeHead(200, corsHeaders(req)); return res.end('{"ok":true}'); }
        res.writeHead(404, corsHeaders(req)); return res.end();
      }

      const { bucket, key, url } = parseTarget(req);
      const b = bkt(bucket);
      const q = url.searchParams;

      // ── Bucket-level GETs ───────────────────────────────────────────────────
      if (method === 'GET' && q.get('list-type') === '2') return listObjectsV2(req, res, b, q);
      if (method === 'GET' && q.has('versions'))          return listVersions(req, res, b, q);

      // ── Multipart ──────────────────────────────────────────────────────────
      if (method === 'POST' && q.has('uploads'))   return initiateMultipart(req, res, b, key);
      if (method === 'PUT'  && q.has('uploadId') && q.has('partNumber')) return uploadPart(req, res, b, key, q);
      if (method === 'POST' && q.has('uploadId'))  return completeMultipart(req, res, b, key, q);
      if (method === 'DELETE' && q.has('uploadId')) { b.uploads.delete(q.get('uploadId')); res.writeHead(204, corsHeaders(req)); return res.end(); }
      if (method === 'GET' && q.has('uploadId'))   return listParts(req, res, b, key, q);

      // ── Batch delete ─────────────────────────────────────────────────────────
      if (method === 'POST' && q.has('delete')) return deleteObjects(req, res, b);

      // ── Object ops ───────────────────────────────────────────────────────────
      if (method === 'PUT' && req.headers['x-amz-copy-source']) return copyObject(req, res, b, key, q);
      if (method === 'PUT')    return putObject(req, res, b, key);
      if (method === 'HEAD')   return headObject(req, res, b, key);
      if (method === 'GET')    return getObject(req, res, b, key, q);
      if (method === 'DELETE') return deleteObject(req, res, b, key, q);

      sendError(req, res, 400, 'NotImplemented', `${method} ${req.url}`);
    } catch (err) {
      sendError(req, res, 500, 'InternalError', err.message);
    }
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  function listObjectsV2(req, res, b, q) {
    const f = matchFault('ListObjectsV2', 'GET'); if (f) return sendError(req, res, f.status, f.code, f.message);
    const prefix = q.get('prefix') || '';
    const delimiter = q.get('delimiter') || '';
    const maxKeys = parseInt(q.get('max-keys') || '1000', 10);
    const token = q.get('continuation-token');

    const liveKeys = [...b.objects.keys()].filter((k) => current(b, k) && k.startsWith(prefix)).sort();
    const commonPrefixes = new Set();
    const contents = [];
    for (const k of liveKeys) {
      if (delimiter) {
        const rest = k.slice(prefix.length);
        const di = rest.indexOf(delimiter);
        if (di !== -1) { commonPrefixes.add(prefix + rest.slice(0, di + 1)); continue; }
      }
      contents.push(k);
    }
    const merged = [...contents]; // pagination over Contents only (CommonPrefixes returned on first page)
    const start = token ? merged.indexOf(token) : 0;
    const page = merged.slice(start, start + maxKeys);
    const truncated = start + maxKeys < merged.length;
    const next = truncated ? merged[start + maxKeys] : null;

    const objXml = page.map((k) => {
      const o = current(b, k);
      return `<Contents><Key>${xmlEsc(k)}</Key><LastModified>${o.lastModified}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    }).join('');
    const cpXml = (token ? '' : [...commonPrefixes].sort().map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join(''));
    sendXml(req, res, 200,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><Delimiter>${xmlEsc(delimiter)}</Delimiter><IsTruncated>${truncated}</IsTruncated>${next ? `<NextContinuationToken>${xmlEsc(next)}</NextContinuationToken>` : ''}${objXml}${cpXml}</ListBucketResult>`);
  }

  function listVersions(req, res, b, q) {
    const prefix = q.get('prefix') || '';
    const versions = [], markers = [];
    for (const [k, vs] of b.objects) {
      if (!k.startsWith(prefix)) continue;
      vs.forEach((v, i) => {
        const isLatest = i === vs.length - 1;
        const entry = `<Key>${xmlEsc(k)}</Key><VersionId>${v.versionId || 'null'}</VersionId><IsLatest>${isLatest}</IsLatest><LastModified>${v.lastModified}</LastModified>`;
        if (v.deleteMarker) markers.push(`<DeleteMarker>${entry}</DeleteMarker>`);
        else versions.push(`<Version>${entry}<ETag>${xmlEsc(v.etag)}</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Version>`);
      });
    }
    sendXml(req, res, 200, `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>${xmlEsc(prefix)}</Prefix><IsTruncated>false</IsTruncated>${versions.join('')}${markers.join('')}</ListVersionsResult>`);
  }

  function metaFromHeaders(req) {
    const meta = {};
    for (const [h, v] of Object.entries(req.headers)) {
      if (h.toLowerCase().startsWith('x-amz-meta-')) meta[h.slice('x-amz-meta-'.length)] = v;
    }
    return meta;
  }

  async function putObject(req, res, b, key) {
    const f = matchFault('PutObject', 'PUT', key); if (f) return sendError(req, res, f.status, f.code, f.message);
    const body = await readBody(req);
    const etag = `"${md5hex(body)}"`;
    const ver = { versionId: b.versioning ? newId() : null, body, metadata: metaFromHeaders(req), contentType: req.headers['content-type'] || 'application/octet-stream', etag, lastModified: nowISO() };
    putVersion(b, key, ver);
    res.writeHead(200, { ...corsHeaders(req), ETag: etag, ...(ver.versionId ? { 'x-amz-version-id': ver.versionId } : {}) });
    res.end();
  }

  function headObject(req, res, b, key) {
    const o = current(b, key);
    if (!o) { res.writeHead(404, corsHeaders(req)); return res.end(); }
    const metaHeaders = {}; for (const [k, v] of Object.entries(o.metadata)) metaHeaders[`x-amz-meta-${k}`] = v;
    res.writeHead(200, { ...corsHeaders(req, Object.keys(o.metadata)), 'Content-Type': o.contentType, 'Content-Length': String(o.body.length), ETag: o.etag, 'Last-Modified': new Date(o.lastModified).toUTCString(), ...metaHeaders });
    res.end();
  }

  function getObject(req, res, b, key, q) {
    const f = matchFault('GetObject', 'GET', key); if (f) return sendError(req, res, f.status, f.code, f.message);
    const o = current(b, key);
    if (!o) return sendError(req, res, 404, 'NoSuchKey', key);
    const metaHeaders = {}; for (const [k, v] of Object.entries(o.metadata)) metaHeaders[`x-amz-meta-${k}`] = v;
    // Presigned response overrides (the SDK puts these in the query string): let a download set
    // Content-Disposition so the browser treats a cross-origin GET as an attachment, not a navigation.
    const overrides = {};
    if (q.get('response-content-disposition')) overrides['Content-Disposition'] = q.get('response-content-disposition');
    if (q.get('response-content-type')) overrides['Content-Type'] = q.get('response-content-type');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : o.body.length - 1;
      const slice = o.body.subarray(start, end + 1);
      res.writeHead(206, { ...corsHeaders(req, Object.keys(o.metadata)), 'Content-Type': o.contentType, 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${o.body.length}`, ETag: o.etag, ...metaHeaders, ...overrides });
      return res.end(slice);
    }
    res.writeHead(200, { ...corsHeaders(req, Object.keys(o.metadata)), 'Content-Type': o.contentType, 'Content-Length': String(o.body.length), ETag: o.etag, 'Last-Modified': new Date(o.lastModified).toUTCString(), ...metaHeaders, ...overrides });
    res.end(o.body);
  }

  function deleteObject(req, res, b, key, q) {
    const f = matchFault('DeleteObject', 'DELETE', key); if (f) return sendError(req, res, f.status, f.code, f.message);
    const versionId = q.get('versionId');
    const vs = b.objects.get(key);
    if (b.versioning && !versionId) {
      // soft-delete: push a delete marker
      const id = newId();
      putVersion(b, key, { versionId: id, deleteMarker: true, lastModified: nowISO() });
      res.writeHead(204, { ...corsHeaders(req), 'x-amz-delete-marker': 'true', 'x-amz-version-id': id });
      return res.end();
    }
    if (versionId && vs) {
      const left = vs.filter((v) => v.versionId !== versionId);
      if (left.length) b.objects.set(key, left); else b.objects.delete(key);
    } else {
      b.objects.delete(key);
    }
    res.writeHead(204, corsHeaders(req));
    res.end();
  }

  async function deleteObjects(req, res, b) {
    const body = (await readBody(req)).toString('utf8');
    // Request-level fault (op 'DeleteObjects') → an HTTP error for the WHOLE batch, e.g. a 503
    // SlowDown throttle that the client must retry. Distinct from a per-key 'DeleteObject' fault
    // below, which becomes a per-key <Error> entry inside a 200 response (a partial failure).
    const reqFault = matchFault('DeleteObjects', 'POST');
    if (reqFault) return sendError(req, res, reqFault.status, reqFault.code, reqFault.message);
    const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]);
    if (keys.length > 1000) return sendError(req, res, 400, 'MalformedXML', 'The batch delete request contained more than 1000 keys');
    const quiet = /<Quiet>true<\/Quiet>/.test(body);
    const deleted = [], errors = [];
    for (const k of keys) {
      const key = k.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const f = matchFault('DeleteObject', 'POST', key);
      if (f) { errors.push(`<Error><Key>${xmlEsc(key)}</Key><Code>${xmlEsc(f.code)}</Code><Message>${xmlEsc(f.message)}</Message></Error>`); continue; }
      // On a versioned bucket a batch delete (no per-key VersionId) creates a delete marker, same as
      // a single DeleteObject — the current version is hidden but retained (so it can be undeleted).
      if (b.versioning) putVersion(b, key, { versionId: newId(), deleteMarker: true, lastModified: nowISO() });
      else b.objects.delete(key);
      if (!quiet) deleted.push(`<Deleted><Key>${xmlEsc(key)}</Key></Deleted>`);
    }
    sendXml(req, res, 200, `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted.join('')}${errors.join('')}</DeleteResult>`);
  }

  function initiateMultipart(req, res, b, key) {
    const id = `mock-${newId()}`;
    b.uploads.set(id, { key, metadata: metaFromHeaders(req), contentType: req.headers['content-type'] || 'application/octet-stream', parts: new Map() });
    sendXml(req, res, 200, `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bucket</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  async function uploadPart(req, res, b, key, q) {
    const up = b.uploads.get(q.get('uploadId'));
    if (!up) return sendError(req, res, 404, 'NoSuchUpload', 'Unknown uploadId');
    const partNumber = parseInt(q.get('partNumber'), 10);
    const copySource = req.headers['x-amz-copy-source'];
    const f = matchFault(copySource ? 'UploadPartCopy' : 'UploadPart', 'PUT', up.key);
    if (f) return sendError(req, res, f.status, f.code, f.message);
    let body;
    if (copySource) { // UploadPartCopy
      const src = resolveCopySource(b, copySource);
      if (!src) return sendError(req, res, 404, 'NoSuchKey', copySource);
      const rng = req.headers['x-amz-copy-source-range'];
      if (rng) { const m = /bytes=(\d+)-(\d+)/.exec(rng); body = src.body.subarray(parseInt(m[1], 10), parseInt(m[2], 10) + 1); }
      else body = src.body;
    } else {
      body = await readBody(req);
    }
    const etag = `"${md5hex(body)}"`;
    up.parts.set(partNumber, { etag, md5: md5buf(body), body: Buffer.from(body) });
    if (copySource) sendXml(req, res, 200, `<CopyPartResult><ETag>${etag}</ETag><LastModified>${nowISO()}</LastModified></CopyPartResult>`);
    else { res.writeHead(200, { ...corsHeaders(req), ETag: etag }); res.end(); }
  }

  async function completeMultipart(req, res, b, key, q) {
    const up = b.uploads.get(q.get('uploadId'));
    if (!up) return sendError(req, res, 404, 'NoSuchUpload', 'Unknown uploadId');
    const f = matchFault('CompleteMultipartUpload', 'POST', up.key);
    if (f) return sendError(req, res, f.status, f.code, f.message);
    const body = (await readBody(req)).toString('utf8');
    // Parse each <Part> block then pull PartNumber + ETag independently — the SDK emits ETag
    // BEFORE PartNumber, so an order-sensitive regex mis-pairs adjacent parts.
    const requested = [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
      n: parseInt(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1])[1], 10),
      etag: /<ETag>([\s\S]*?)<\/ETag>/.exec(m[1])[1].trim(),
    }));
    // STRICT: parts must be ascending and each must match a stored part's ETag.
    const ns = requested.map((p) => p.n);
    if (ns.some((n, i) => i > 0 && n <= ns[i - 1])) return sendError(req, res, 400, 'InvalidPartOrder', 'Parts must be in ascending order');
    const normEtag = (e) => e.replace(/&quot;/g, '').replace(/&amp;/g, '&').replace(/"/g, '').trim();
    for (const p of requested) {
      const stored = up.parts.get(p.n);
      if (!stored) return sendError(req, res, 400, 'InvalidPart', `Part ${p.n} not found`);
      if (normEtag(stored.etag) !== normEtag(p.etag)) return sendError(req, res, 400, 'InvalidPart', `ETag mismatch for part ${p.n}`);
    }
    // STRICT: every part except the last must be >= 5 MB.
    for (let i = 0; i < requested.length - 1; i++) {
      if (up.parts.get(requested[i].n).body.length < 5 * 1024 * 1024) return sendError(req, res, 400, 'EntityTooSmall', `Part ${requested[i].n} smaller than 5 MB`);
    }
    const full = Buffer.concat(requested.map((p) => up.parts.get(p.n).body));
    const etag = `"${md5hex(Buffer.concat(requested.map((p) => up.parts.get(p.n).md5)))}-${requested.length}"`;
    const ver = { versionId: b.versioning ? newId() : null, body: full, metadata: up.metadata, contentType: up.contentType, etag, lastModified: nowISO() };
    putVersion(b, key, ver);
    b.uploads.delete(q.get('uploadId'));
    sendXml(req, res, 200, `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://${baseHost}/${xmlEsc(key)}</Location><Bucket>bucket</Bucket><Key>${xmlEsc(key)}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`, ver.versionId ? { 'x-amz-version-id': ver.versionId } : {});
  }

  function listParts(req, res, b, key, q) {
    const up = b.uploads.get(q.get('uploadId'));
    if (!up) return sendError(req, res, 404, 'NoSuchUpload', 'Unknown uploadId');
    const marker = parseInt(q.get('part-number-marker') || '0', 10);
    // Real S3 paginates ListParts at 1000 parts/page (the BUG-007 trap). max-parts is the SDK-driven
    // page size; cap it so the resume path must loop until IsTruncated is false.
    const maxParts = Math.min(parseInt(q.get('max-parts') || '1000', 10), 1000);
    const sorted = [...up.parts.entries()].map(([n, p]) => ({ n, etag: p.etag, size: p.body.length })).sort((a, b2) => a.n - b2.n).filter((p) => p.n > marker);
    const page = sorted.slice(0, maxParts);
    const truncated = sorted.length > maxParts;
    const nextMarker = truncated ? page[page.length - 1].n : null;
    const partsXml = page.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEsc(p.etag)}</ETag><Size>${p.size}</Size></Part>`).join('');
    sendXml(req, res, 200, `<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bucket</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${xmlEsc(q.get('uploadId'))}</UploadId><MaxParts>${maxParts}</MaxParts><IsTruncated>${truncated}</IsTruncated>${nextMarker != null ? `<NextPartNumberMarker>${nextMarker}</NextPartNumberMarker>` : ''}${partsXml}</ListPartsResult>`);
  }

  function resolveCopySource(b, header) {
    // x-amz-copy-source = "/{bucket}/{key}" or "{bucket}/{key}", URL-encoded, optional ?versionId=
    let s = decodeURIComponent(header.replace(/^\//, '').split('?')[0]);
    const slash = s.indexOf('/');
    const srcKey = s.slice(slash + 1);
    return current(b, srcKey);
  }

  function copyObject(req, res, b, destKey, q) {
    const f = matchFault('CopyObject', 'PUT', destKey); if (f) return sendError(req, res, f.status, f.code, f.message);
    const header = req.headers['x-amz-copy-source'];
    const src = resolveCopySource(b, header);
    if (!src) return sendError(req, res, 404, 'NoSuchKey', header);
    const srcKey = decodeURIComponent(header.replace(/^\//, '').split('?')[0]).split('/').slice(1).join('/');
    const directive = (req.headers['x-amz-metadata-directive'] || 'COPY').toUpperCase();
    // STRICT: real S3 rejects a same-key copy that doesn't change metadata.
    if (srcKey === destKey && directive === 'COPY') return sendError(req, res, 400, 'InvalidRequest', 'This copy request is illegal because it is trying to copy an object to itself without changing metadata');
    const metadata = directive === 'REPLACE' ? metaFromHeaders(req) : src.metadata;
    const contentType = directive === 'REPLACE' ? (req.headers['content-type'] || src.contentType) : src.contentType;
    const body = Buffer.from(src.body);
    const etag = `"${md5hex(body)}"`;
    putVersion(b, destKey, { versionId: b.versioning ? newId() : null, body, metadata, contentType, etag, lastModified: nowISO() });
    sendXml(req, res, 200, `<CopyObjectResult><ETag>${etag}</ETag><LastModified>${nowISO()}</LastModified></CopyObjectResult>`);
  }

  return {
    server,
    reset,
    configure,
    get buckets() { return buckets; },
    listen(port) { return new Promise((resolve) => server.listen(port, baseHost, () => resolve(server.address().port))); },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

// CLI entry: `node test/e2e/mock-s3/server.mjs` (used by the e2e runner and perf harness).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.MOCK_S3_PORT ?? '9090', 10);
  const mock = createMockS3({ host: process.env.MOCK_S3_HOST ?? '127.0.0.1', latencyMs: parseInt(process.env.MOCK_S3_LATENCY_MS ?? '0', 10) });
  mock.listen(port).then((p) => process.stdout.write(`mock-s3 ready on http://127.0.0.1:${p}\n`));
}
