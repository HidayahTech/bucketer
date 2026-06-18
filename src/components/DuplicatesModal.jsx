// Copyright (C) 2026 HidayahTech, LLC
// Duplicate-detection report (iteration 1: detection + verification + read-only actions).
//
// Iteration 1 exists so the detection/verification workflow can pass human UAT before any
// destructive action is enabled. The scan produces *candidate* groups (cheap signals only);
// a candidate becomes *verified* solely via byte-for-byte comparison, which is the only
// collision-proof test. Delete/Move are present but DISABLED — they are wired in iteration 2,
// and even then only for verified groups.
//
// DuplicatesReport is a pure presentational component (sync-testable). DuplicatesModal is the
// container that runs the read-only scan/verify against S3. The scan/verify functions can be
// injected (for tests); production uses the real S3-backed implementations below.

import { useState, useCallback } from 'preact/hooks';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Modal } from './Modal.jsx';
import { formatBytes, leafName } from '../lib/format.js';
import { PRESIGN_EXPIRES, DEDUP_VERIFY_MAX_BYTES } from '../lib/constants.js';
import { scanForDuplicates } from '../lib/dedup-scan.js';
import { providerChecksumAdapter } from '../lib/provider-checksum.js';
import { verifyAgainstReference } from '../lib/verify-bytes.js';

// ── Pure presentational report ─────────────────────────────────────────────────

function badgeStyle(verified) {
  return {
    display: 'inline-block', padding: '.05rem .45rem', borderRadius: '4px',
    fontSize: '.7rem', fontWeight: 700, marginRight: '.5rem',
    background: verified ? 'var(--accent)' : 'var(--border)',
    color: verified ? '#fff' : 'var(--text-muted)',
  };
}

function DupGroup({ group, canDownload, onSelectKeeper, onVerify, onDownload, onPreview, onCopyLink }) {
  const { verified, verifying, matchedBy } = group;
  return (
    <div class="dup-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '.6rem', marginTop: '.6rem' }}>
      <div class="dup-group-head">
        <span class={verified ? 'dup-badge dup-badge-verified' : 'dup-badge'} style={badgeStyle(verified)}>
          {verified ? 'verified' : 'candidate'}
        </span>
        <span class="hint">
          matched by {matchedBy} · {formatBytes(group.size)} each · {formatBytes(group.reclaimableBytes)} reclaimable
        </span>
      </div>

      <table class="file-table">
        <tbody>
          {group.members.map((m) => {
            const isKeeper = m.Key === group.keeperKey;
            return (
              <tr key={m.Key} class="dup-member">
                <td style={{ width: '1.5rem' }}>
                  <input
                    type="radio"
                    name={`keeper-${group.id}`}
                    checked={isKeeper}
                    onChange={() => onSelectKeeper(group.id, m.Key)}
                    title="Keep this copy"
                  />
                </td>
                <td class="dup-member-key" title={m.Key}>
                  {m.Key}{isKeeper ? <span class="hint"> (keep)</span> : null}
                </td>
                <td class="log-num">{formatBytes(m.Size)}</td>
                <td class="dup-member-actions" style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" class="btn btn-ghost btn-sm dup-download" disabled={!canDownload}
                    title={canDownload ? 'Download' : 'Download not permitted with current credentials'}
                    onClick={() => onDownload(m.Key)}>↓</button>
                  <button type="button" class="btn btn-ghost btn-sm dup-preview" disabled={!canDownload}
                    title="Open a preview in a new tab" onClick={() => onPreview(m.Key)}>⊙</button>
                  <button type="button" class="btn btn-ghost btn-sm dup-link" disabled={!canDownload}
                    title="Copy a shareable link" onClick={() => onCopyLink(m.Key)}>⎘</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div class="dup-group-actions" style={{ display: 'flex', gap: '.5rem', marginTop: '.45rem', alignItems: 'center' }}>
        <button type="button" class="btn btn-sm dup-verify" disabled={verifying} onClick={() => onVerify(group.id)}>
          {verifying ? 'Verifying…' : verified ? 'Re-verify' : 'Verify (byte-for-byte)'}
        </button>
        <button type="button" class="btn btn-sm btn-danger dup-delete" disabled
          title="Deleting duplicates is enabled in a later iteration, after the detection workflow passes review — and then only for verified groups.">
          Delete others
        </button>
        <button type="button" class="btn btn-sm dup-move" disabled
          title="Moving duplicates is enabled in a later iteration, after the detection workflow passes review.">
          Move others
        </button>
        {verifying && <span class="spinner" />}
      </div>
    </div>
  );
}

export function DuplicatesReport({ groups, capabilities, onSelectKeeper, onVerify, onDownload, onPreview, onCopyLink }) {
  if (!groups || groups.length === 0) {
    return <p class="hint">No duplicate candidates found.</p>;
  }
  const totalGroups = groups.length;
  const redundant = groups.reduce((n, g) => n + (g.members.length - 1), 0);
  const reclaimable = groups.reduce((n, g) => n + g.reclaimableBytes, 0);
  const canDownload = capabilities?.download !== 'denied';

  return (
    <div class="dup-report">
      <p class="section-heading" style={{ margin: '.25rem 0 0' }}>
        {totalGroups} group{totalGroups !== 1 ? 's' : ''} · {redundant} redundant cop{redundant !== 1 ? 'ies' : 'y'} · {formatBytes(reclaimable)} reclaimable
      </p>
      {groups.map((g) => (
        <DupGroup key={g.id} group={g} canDownload={canDownload}
          onSelectKeeper={onSelectKeeper} onVerify={onVerify}
          onDownload={onDownload} onPreview={onPreview} onCopyLink={onCopyLink} />
      ))}
    </div>
  );
}

// ── S3-backed read-only implementations (production path; tests inject overrides) ──

async function presign(client, bucket, key, extra) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ...extra }), { expiresIn: PRESIGN_EXPIRES });
}

async function downloadObject(client, bucket, key) {
  try {
    const url = await presign(client, bucket, key, {
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(leafName(key))}"`,
    });
    const a = document.createElement('a');
    a.href = url; a.download = leafName(key);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } catch (err) { console.warn('[bucketer:dedup] download failed', key, err); }
}

async function previewObject(client, bucket, key) {
  try { window.open(await presign(client, bucket, key, { ResponseContentDisposition: 'inline' }), '_blank', 'noopener'); }
  catch (err) { console.warn('[bucketer:dedup] preview failed', key, err); }
}

async function copyLinkObject(client, bucket, key) {
  try { await navigator.clipboard?.writeText(await presign(client, bucket, key)); }
  catch (err) { console.warn('[bucketer:dedup] copy link failed', key, err); }
}

// Read each object's body as an async iterable of chunks (reader-based for browser
// compatibility — ReadableStream is not async-iterable everywhere).
async function* streamChunks(readable) {
  const reader = readable.getReader();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) yield value; }
  } finally { reader.releaseLock(); }
}

async function fetchBody(client, bucket, key) {
  const resp = await fetch(await presign(client, bucket, key));
  if (!resp.ok || !resp.body) throw new Error(`fetch failed for ${key} (HTTP ${resp.status})`);
  return resp.body;
}

// The real verify path: byte-for-byte compare each candidate against the keeper.
async function verifyGroupBytes(client, bucket, keeperKey, candidateKeys) {
  const ref = await fetchBody(client, bucket, keeperKey);
  const cands = [];
  for (const k of candidateKeys) cands.push(await fetchBody(client, bucket, k));
  return verifyAgainstReference(streamChunks(ref), cands.map(streamChunks));
}

// ── Container ──────────────────────────────────────────────────────────────────

function progressLabel(p) {
  if (!p) return 'Starting…';
  if (p.phase === 'listing') return `Listing objects… (${p.count})`;
  if (p.phase === 'grouped') return `Examining ${p.candidates} same-size candidates…`;
  if (p.phase === 'heading') return `Reading metadata… (${p.done}/${p.total})`;
  return 'Scanning…';
}

export function DuplicatesModal({ client, bucket, currentPrefix, provider, capabilities, onDeleteRequest, onClose, scan, verify }) {
  const [scope, setScope] = useState('prefix');
  const [status, setStatus] = useState('idle');
  const [groups, setGroups] = useState([]);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const runScan = useCallback(async () => {
    setStatus('scanning'); setError(null); setGroups([]); setProgress(null);
    const prefix = scope === 'bucket' ? '' : (currentPrefix || '');
    try {
      const found = scan
        ? await scan({ scope, prefix })
        : await scanForDuplicates(client, bucket, prefix, {
            adapter: providerChecksumAdapter(provider),
            onProgress: setProgress,
          });
      setGroups(found.map((g, i) => ({
        ...g,
        id: g.id || `g${i}`,
        keeperKey: g.members[0].Key,
        verifying: false,
      })));
      setStatus('done');
    } catch (err) {
      setError(err?.message || String(err));
      setStatus('error');
    }
  }, [scope, currentPrefix, client, bucket, provider, scan]);

  function selectKeeper(gid, key) {
    // Changing the keeper invalidates a prior verification (it confirmed a different keeper).
    setGroups((prev) => prev.map((g) => g.id === gid ? { ...g, keeperKey: key, verified: false, confidence: 'candidate' } : g));
  }

  async function runVerify(gid) {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    const others = g.members.filter((m) => m.Key !== g.keeperKey).map((m) => m.Key);
    if (others.length === 0) return;

    // Byte-for-byte means downloading content. Above the cap, confirm the egress first.
    const estBytes = g.size * g.members.length;
    if (!verify && estBytes > DEDUP_VERIFY_MAX_BYTES) {
      const ok = window.confirm(
        `Verifying this group downloads about ${formatBytes(estBytes)} to compare the files byte-for-byte. Continue?`,
      );
      if (!ok) return;
    }

    setGroups((prev) => prev.map((x) => x.id === gid ? { ...x, verifying: true } : x));
    try {
      const results = verify
        ? await verify({ group: g, keeperKey: g.keeperKey, candidateKeys: others })
        : await verifyGroupBytes(client, bucket, g.keeperKey, others);
      const allMatch = results.length > 0 && results.every(Boolean);
      setGroups((prev) => prev.map((x) => x.id === gid
        ? { ...x, verifying: false, verified: allMatch, confidence: allMatch ? 'verified' : 'candidate' }
        : x));
    } catch (err) {
      setError(err?.message || String(err));
      setGroups((prev) => prev.map((x) => x.id === gid ? { ...x, verifying: false } : x));
    }
  }

  return (
    <Modal onClose={onClose} class="duplicates-dialog">
      <div class="modal-title">Find duplicates</div>
      <p class="hint" style={{ marginTop: 0 }}>
        Read-only scan. Matches are <strong>candidates</strong> until confirmed byte-for-byte with
        <strong> Verify</strong> — no hash alone is trusted to delete. Deleting and moving duplicates
        arrive in a later iteration, once this detection workflow is reviewed.
      </p>

      <div class="dup-controls" style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label class="hint">
          Scan:{' '}
          <select class="dup-scope" value={scope} disabled={status === 'scanning'}
            onChange={(e) => setScope(e.target.value)}>
            <option value="prefix">Current folder{currentPrefix ? ` (${currentPrefix})` : ' (root)'}</option>
            <option value="bucket">Whole bucket</option>
          </select>
        </label>
        <button type="button" class="btn btn-sm dup-scan" disabled={status === 'scanning'} onClick={runScan}>
          {status === 'scanning' ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {status === 'scanning' && (
        <p class="hint" style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
          <span class="spinner" /> {progressLabel(progress)}
        </p>
      )}
      {status === 'error' && <p class="text-danger">Scan failed: {error}</p>}
      {status === 'done' && (
        <DuplicatesReport
          groups={groups}
          capabilities={capabilities}
          onSelectKeeper={selectKeeper}
          onVerify={runVerify}
          onDownload={(k) => downloadObject(client, bucket, k)}
          onPreview={(k) => previewObject(client, bucket, k)}
          onCopyLink={(k) => copyLinkObject(client, bucket, k)}
        />
      )}

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
