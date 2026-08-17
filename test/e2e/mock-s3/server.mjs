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
import https from 'node:https';
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
  const bootLatencyMs = opts.latencyMs ?? 0;
  let latencyMs   = bootLatencyMs;   // runtime-settable via configure({ latencyMs }) so a
                                     // matched pair (0 ms vs slow) can share one boot
  const buckets   = new Map(); // name -> { versioning, objects: Map<key, Version[]>, uploads: Map<id,…> }
  let cors        = DEFAULT_CORS();
  let faults      = [];        // [{ op?, method?, keyPrefix?, status, code, message, times }]

  // Request log: the presence-assertion side of the harness. An e2e that asserts only an
  // absence ("the page did not navigate") passes just as happily when the feature is
  // inert (BUG-052: the CSP blocked the download frame from loading anything at all), so
  // specs pair absence assertions with "the request actually arrived here". Ring-bounded.
  //
  // isNavGet marks a signed object GET that is not the one-byte pre-flight probe. The
  // probe is the ONLY requester that sends exactly `Range: bytes=0-0`; a download
  // navigation usually sends no Range at all — but when the probe's 206 has primed the
  // browser's partial-content cache for the same URL, the navigation arrives WITH a Range
  // header asking for the remainder (measured on Chromium). Excluding all ranged requests
  // therefore misclassifies real downloads; excluding only bytes=0-0 does not.
  const REQUEST_LOG_CAP = 2000;
  const requestEntries = [];
  function logRequest(req) {
    if (req.url.startsWith('/__admin/')) return;
    const signed = req.url.includes('X-Amz-Signature');
    const range = req.headers.range || null;
    const isNavGet = req.method === 'GET' && signed
      && !req.url.includes('list-type') && range !== 'bytes=0-0';
    // isList/listPrefix (#60): the query string is otherwise stripped from `path`,
    // which would make "no root-level List ever happened" an unwritable assertion.
    const q = new URL(req.url, 'http://mock').searchParams;
    const isList = req.method === 'GET' && q.get('list-type') === '2';
    requestEntries.push({ method: req.method, path: req.url.split('?')[0], signed, range, isNavGet, isList, listPrefix: isList ? (q.get('prefix') || '') : null });
    if (requestEntries.length > REQUEST_LOG_CAP) requestEntries.shift();
  }
  const requestLog = {
    list: () => requestEntries.slice(),
    reset: () => { requestEntries.length = 0; },
  };

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

  function reset()        { buckets.clear(); faults = []; cors = DEFAULT_CORS(); latencyMs = bootLatencyMs; scopePrefix = null; requestLog.reset(); }
  function configure(cfg) {
    if (cfg.cors)   cors = { ...DEFAULT_CORS(), ...cfg.cors };
    if (cfg.faults) faults = cfg.faults;
    if (typeof cfg.latencyMs === 'number') latencyMs = cfg.latencyMs;
    if (cfg.bucket && typeof cfg.versioning === 'boolean') bkt(cfg.bucket).versioning = cfg.versioning;
    if ('scopePrefix' in cfg) scopePrefix = cfg.scopePrefix || null;
  }

  // Prefix-scoped credential simulation (#60): a standing per-instance constraint
  // (the mock ignores signatures, so there is no per-request identity). Models a B2
  // namePrefix / IAM s3:prefix restriction: listings must ask for a prefix at or
  // under the scope; object ops must target keys under it. Checked BEFORE faults —
  // deny takes precedence, mirroring real IAM semantics.
  let scopePrefix = null; // e.g. 'clients/acme/' — null = unscoped (default)
  function inScope(key) { return !scopePrefix || (key || '').startsWith(scopePrefix); }
  function denyScope(req, res) { return sendError(req, res, 403, 'AccessDenied', 'Access Denied'); }
  // `skipRange: true` makes a fault ignore ranged requests. Exists so a spec can fail the
  // download GET while the one-byte pre-flight probe (a Range GET on the same key)
  // succeeds — the "object vanished between probe and issue" scenario, which is the case
  // BUG-050's containment still has to handle now that probed failures never reach a frame.
  function matchFault(op, method, key, { hasRange = false } = {}) {
    const i = faults.findIndex((f) =>
      (f.op ? f.op === op : true) &&
      (f.method ? f.method === method : true) &&
      (f.keyPrefix ? (key || '').startsWith(f.keyPrefix) : true) &&
      (f.skipRange ? !hasRange : true) &&
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
    // Accept-Ranges and Content-Range are always exposed: a ranged reader cannot verify what
    // it received without them, and a browser silently withholds any response header not
    // listed here (BUG-028's failure mode — invisible, not an error).
    const expose = new Set(['ETag', 'Content-Length', 'Content-Type', 'x-amz-request-id',
      'x-amz-version-id', 'Accept-Ranges', 'Content-Range']);
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

  const handler = async (req, res) => {
    try {
      logRequest(req);
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const method = req.method;

      if (method === 'OPTIONS') return preflight(req, res);

      // Admin control plane (tests only).
      if (req.url.startsWith('/__admin/')) {
        const body = await readBody(req);
        if (req.url === '/__admin/reset') { reset(); res.writeHead(200, corsHeaders(req)); return res.end('{"ok":true}'); }
        if (req.url === '/__admin/config') { configure(body.length ? JSON.parse(body) : {}); res.writeHead(200, corsHeaders(req)); return res.end('{"ok":true}'); }
        if (req.url === '/__admin/requests' && method === 'GET') { res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ requests: requestLog.list() })); }
        if (req.url === '/__admin/requests/reset') { requestLog.reset(); res.writeHead(200, corsHeaders(req)); return res.end('{"ok":true}'); }
        res.writeHead(404, corsHeaders(req)); return res.end();
      }

      const { bucket, key, url } = parseTarget(req);
      const b = bkt(bucket);
      const q = url.searchParams;

      // ── Bucket-level GETs ───────────────────────────────────────────────────
      if (method === 'GET' && q.get('list-type') === '2') return listObjectsV2(req, res, b, q);
      if (method === 'GET' && q.has('versions'))          return listVersions(req, res, b, q);
      if (method === 'GET' && q.has('uploads'))           return listMultipartUploads(req, res, b, q);

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
  };

  const server = http.createServer(handler);
  let tlsServer = null;

  // ── Handlers ───────────────────────────────────────────────────────────────
  function listObjectsV2(req, res, b, q) {
    if (scopePrefix && !(q.get('prefix') || '').startsWith(scopePrefix)) return denyScope(req, res);
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
      return `<Contents><Key>${xmlEsc(k)}</Key><LastModified>${o.lastModified}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>${xmlEsc(o.storageClass || 'STANDARD')}</StorageClass></Contents>`;
    }).join('');
    const cpXml = (token ? '' : [...commonPrefixes].sort().map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join(''));
    sendXml(req, res, 200,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><Delimiter>${xmlEsc(delimiter)}</Delimiter><IsTruncated>${truncated}</IsTruncated>${next ? `<NextContinuationToken>${xmlEsc(next)}</NextContinuationToken>` : ''}${objXml}${cpXml}</ListBucketResult>`);
  }

  function listVersions(req, res, b, q) {
    if (scopePrefix && !(q.get('prefix') || '').startsWith(scopePrefix)) return denyScope(req, res);
    const prefix = q.get('prefix') || '';
    const versions = [], markers = [];
    for (const [k, vs] of b.objects) {
      if (!k.startsWith(prefix)) continue;
      vs.forEach((v, i) => {
        const isLatest = i === vs.length - 1;
        const entry = `<Key>${xmlEsc(k)}</Key><VersionId>${v.versionId || 'null'}</VersionId><IsLatest>${isLatest}</IsLatest><LastModified>${v.lastModified}</LastModified>`;
        if (v.deleteMarker) markers.push(`<DeleteMarker>${entry}</DeleteMarker>`);
        else versions.push(`<Version>${entry}<ETag>${xmlEsc(v.etag)}</ETag><Size>${v.body.length}</Size><StorageClass>${xmlEsc(v.storageClass || 'STANDARD')}</StorageClass></Version>`);
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
    if (!inScope(key)) return denyScope(req, res);
    const f = matchFault('PutObject', 'PUT', key); if (f) return sendError(req, res, f.status, f.code, f.message);
    const body = await readBody(req);
    const etag = `"${md5hex(body)}"`;
    // x-amz-storage-class rides along like real S3 (the SDK sends it for
    // PutObjectCommand({ StorageClass })). Listings echo it, and a GET against an
    // archived class fails — which is the whole reason archived-object flagging exists.
    const storageClass = req.headers['x-amz-storage-class'] || 'STANDARD';
    const ver = { versionId: b.versioning ? newId() : null, body, metadata: metaFromHeaders(req), contentType: req.headers['content-type'] || 'application/octet-stream', etag, lastModified: nowISO(), storageClass };
    putVersion(b, key, ver);
    res.writeHead(200, { ...corsHeaders(req), ETag: etag, ...(ver.versionId ? { 'x-amz-version-id': ver.versionId } : {}) });
    res.end();
  }

  function headObject(req, res, b, key) {
    if (!inScope(key)) return denyScope(req, res);
    const o = current(b, key);
    if (!o) { res.writeHead(404, corsHeaders(req)); return res.end(); }
    const metaHeaders = {}; for (const [k, v] of Object.entries(o.metadata)) metaHeaders[`x-amz-meta-${k}`] = v;
    res.writeHead(200, { ...corsHeaders(req, Object.keys(o.metadata)), 'Content-Type': o.contentType, 'Content-Length': String(o.body.length), 'Accept-Ranges': 'bytes', ETag: o.etag, 'Last-Modified': new Date(o.lastModified).toUTCString(), ...metaHeaders });
    res.end();
  }

  // Parse a single byte-range against a known length. Returns null for an unparseable header
  // (which per spec is ignored, not an error) and 'unsatisfiable' for one past the end.
  // Suffix form (bytes=-N) is included because clients do send it, even though it is the one
  // form browsers exclude from the CORS-safelisted Range header.
  function parseRange(header, len) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m) return null;
    const [, rawStart, rawEnd] = m;
    if (rawStart === '' && rawEnd === '') return null;

    let start, end;
    if (rawStart === '') {
      const suffix = parseInt(rawEnd, 10);
      if (suffix === 0) return 'unsatisfiable';
      start = Math.max(0, len - suffix);
      end = len - 1;
    } else {
      start = parseInt(rawStart, 10);
      end = rawEnd === '' ? len - 1 : Math.min(parseInt(rawEnd, 10), len - 1);
    }
    if (start >= len || start > end) return 'unsatisfiable';
    return { start, end };
  }

  function getObject(req, res, b, key, q) {
    if (!inScope(key)) return denyScope(req, res);
    const f = matchFault('GetObject', 'GET', key, { hasRange: !!req.headers.range });
    // killAtByte is not an error response: headers and a prefix of the body are written, then
    // the socket is destroyed, which is what a dropped connection actually looks like to a
    // client. An error status would exercise a completely different code path.
    if (f && f.killAtByte === undefined) return sendError(req, res, f.status, f.code, f.message);

    const o = current(b, key);
    if (!o) return sendError(req, res, 404, 'NoSuchKey', key);

    // Real S3: a GET against GLACIER or DEEP_ARCHIVE fails with 403 InvalidObjectState
    // until a RestoreObject completes. GLACIER_IR serves reads normally.
    if (o.storageClass === 'GLACIER' || o.storageClass === 'DEEP_ARCHIVE') {
      return sendError(req, res, 403, 'InvalidObjectState',
        "The operation is not valid for the object's storage class");
    }

    // A transfer that spans a change to the object must fail rather than silently splice two
    // versions together. If-Match is how a client asks for that guarantee.
    const ifMatch = req.headers['if-match'];
    if (ifMatch && ifMatch !== '*' && ifMatch.replace(/^W\//, '') !== o.etag) {
      return sendError(req, res, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
    }

    const metaHeaders = {}; for (const [k, v] of Object.entries(o.metadata)) metaHeaders[`x-amz-meta-${k}`] = v;
    // Presigned response overrides (the SDK puts these in the query string): let a download set
    // Content-Disposition so the browser treats a cross-origin GET as an attachment, not a navigation.
    const overrides = {};
    if (q.get('response-content-disposition')) overrides['Content-Disposition'] = q.get('response-content-disposition');
    if (q.get('response-content-type')) overrides['Content-Type'] = q.get('response-content-type');
    // response-cache-control matters for fidelity: the app presigns every download with
    // no-store (issue #13). Without honoring it, the one-byte pre-flight probe's 206 gets
    // cached by the browser, and the download navigation is then served or revalidated
    // FROM CACHE — hiding the real request from fault injection and from the request log.
    if (q.get('response-cache-control')) overrides['Cache-Control'] = q.get('response-cache-control');

    const base = {
      ...corsHeaders(req, Object.keys(o.metadata)),
      'Content-Type': o.contentType,
      'Accept-Ranges': 'bytes',
      ETag: o.etag,
      'Last-Modified': new Date(o.lastModified).toUTCString(),
      ...metaHeaders,
      ...overrides,
    };

    // A resume sends If-Range with the validator it started from. If it no longer matches the
    // client's partial file is stale, and the correct answer is the whole object, not a slice.
    const ifRange = req.headers['if-range'];
    const rangeStale = ifRange && ifRange.replace(/^W\//, '') !== o.etag;
    const range = (req.headers.range && !rangeStale) ? parseRange(req.headers.range, o.body.length) : null;

    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${o.body.length}` });
      return res.end();
    }

    const bodyOut = range ? o.body.subarray(range.start, range.end + 1) : o.body;
    const head = range
      ? { ...base, 'Content-Length': String(bodyOut.length), 'Content-Range': `bytes ${range.start}-${range.end}/${o.body.length}` }
      : { ...base, 'Content-Length': String(bodyOut.length) };

    res.writeHead(range ? 206 : 200, head);

    if (f && f.killAtByte !== undefined) {
      res.write(bodyOut.subarray(0, f.killAtByte));
      return res.destroy();
    }
    res.end(bodyOut);
  }

  function deleteObject(req, res, b, key, q) {
    if (!inScope(key)) return denyScope(req, res);
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
      if (!inScope(key)) { errors.push(`<Error><Key>${xmlEsc(key)}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`); continue; }
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
    // Part ops need no separate guard: no uploadId can exist for a key denied here.
    if (!inScope(key)) return denyScope(req, res);
    const id = `mock-${newId()}`;
    b.uploads.set(id, { key, initiated: nowISO(), metadata: metaFromHeaders(req), contentType: req.headers['content-type'] || 'application/octet-stream', parts: new Map() });
    sendXml(req, res, 200, `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bucket</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  // GET /?uploads — list in-progress (incomplete) multipart uploads, optionally under ?prefix=.
  function listMultipartUploads(req, res, b, q) {
    const prefix = q.get('prefix') || '';
    const uploadsXml = [...b.uploads.entries()]
      .filter(([, up]) => up.key.startsWith(prefix))
      .map(([id, up]) => `<Upload><Key>${xmlEsc(up.key)}</Key><UploadId>${xmlEsc(id)}</UploadId><Initiated>${up.initiated || nowISO()}</Initiated></Upload>`)
      .join('');
    sendXml(req, res, 200, `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>bucket</Bucket><IsTruncated>false</IsTruncated>${uploadsXml}</ListMultipartUploadsResult>`);
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
    const header = req.headers['x-amz-copy-source'];
    const srcKey = decodeURIComponent(header.replace(/^\//, '').split('?')[0]).split('/').slice(1).join('/');
    // B2 gates CopyObject under readFiles (source) AND writeFiles (dest) — a scoped
    // key can neither read outside its prefix nor write outside it (#60).
    if (!inScope(destKey) || !inScope(srcKey)) return denyScope(req, res);
    const f = matchFault('CopyObject', 'PUT', destKey); if (f) return sendError(req, res, f.status, f.code, f.message);
    const src = resolveCopySource(b, header);
    if (!src) return sendError(req, res, 404, 'NoSuchKey', header);
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
    requestLog,
    get buckets() { return buckets; },
    listen(port) { return new Promise((resolve) => server.listen(port, baseHost, () => resolve(server.address().port))); },
    // Same handler over TLS. Exists because the app's CSP treats transports differently
    // (frame-src) and production endpoints are https — an http-only harness let BUG-052
    // pass unnoticed. Callers supply { key, cert } (see test/e2e/tls-cert.mjs).
    listenTls(port, tlsOpts) {
      tlsServer = https.createServer(tlsOpts, handler);
      return new Promise((resolve) => tlsServer.listen(port, baseHost, () => resolve(tlsServer.address().port)));
    },
    close() {
      return Promise.all([
        new Promise((resolve) => server.close(resolve)),
        tlsServer ? new Promise((resolve) => tlsServer.close(resolve)) : Promise.resolve(),
      ]);
    },
  };
}

// CLI entry: `node test/e2e/mock-s3/server.mjs` (used by the e2e runner and perf harness).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.MOCK_S3_PORT ?? '9090', 10);
  const mock = createMockS3({ host: process.env.MOCK_S3_HOST ?? '127.0.0.1', latencyMs: parseInt(process.env.MOCK_S3_LATENCY_MS ?? '0', 10) });
  mock.listen(port).then((p) => process.stdout.write(`mock-s3 ready on http://127.0.0.1:${p}\n`));
}
