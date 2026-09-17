// Copyright (C) 2026 HidayahTech, LLC
import { useState } from 'preact/hooks';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { COPY_LINK_PRESETS } from '../lib/constants.js';
import { buildShareLink } from '../lib/share-url.js';
import { presignGetParams } from '../lib/presign-params.js';

// Single component for both single-file and multi-file copy-link flows.
// Pass fileKey for one file, fileKeys (array) for batch mode — mutually exclusive.
// onCopied(count) receives the number of links copied; direction controls popover position.
export function CopyLinkPopover({ client, bucket, fileKey, fileKeys, onClose, onCopied, direction = 'down' }) {
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('1');
  const [customUnit, setCustomUnit] = useState('hours');
  const [copying, setCopying] = useState(false);
  const [sharingViaBucketer, setSharingViaBucketer] = useState(false);
  const [error, setError] = useState(null);

  const isBatch = Array.isArray(fileKeys);
  const keys = isBatch ? fileKeys : [fileKey];

  async function copyLinks(expiresIn) {
    setCopying(true);
    setError(null);
    try {
      const urls = await Promise.all(
        keys.map((key) =>
          getSignedUrl(
            client,
            new GetObjectCommand(presignGetParams({ Bucket: bucket, Key: key, ResponseContentDisposition: 'inline' })),
            { expiresIn },
          ),
        ),
      );
      await navigator.clipboard.writeText(urls.join('\n'));
      onCopied(urls.length);
      onClose();
    } catch (err) {
      setError(err.message || String(err));
      setCopying(false);
    }
  }

  async function copyBucketerLink(expiresIn) {
    setSharingViaBucketer(true);
    setError(null);
    try {
      const presignedUrl = await getSignedUrl(
        client,
        new GetObjectCommand(presignGetParams({ Bucket: bucket, Key: keys[0], ResponseContentDisposition: 'inline' })),
        { expiresIn },
      );
      const shareLink = buildShareLink(presignedUrl);
      if (!shareLink) throw new Error('Cannot build a share link from a file:// URL.');
      await navigator.clipboard.writeText(shareLink);
      onCopied(1);
      onClose();
    } catch (err) {
      setError(err.message || String(err));
      setSharingViaBucketer(false);
    }
  }

  function handleCustomCopy() {
    const mult = { minutes: 60, hours: 3600, days: 86400 };
    const n = parseInt(customValue, 10);
    if (!n || n < 1) {
      setError('Enter a positive number.');
      return;
    }
    const seconds = n * mult[customUnit];
    if (seconds > 604800) {
      setError('Maximum is 7 days.');
      return;
    }
    copyLinks(seconds);
  }

  // #69: these links ARE access (presigned), unlike the header's "Open in Bucketer" links,
  // which need the recipient's own key. Say so at the point of choice, in plain words.
  const note = isBatch
    ? `${keys.length} link${keys.length !== 1 ? 's' : ''}, one per line. Expires after the selected duration. No sign-in needed — treat them like passwords.`
    : 'Link expires after the selected duration. No sign-in needed — treat it like a password.';

  return (
    <div class={`copy-link-popover${direction === 'up' ? ' copy-link-popover--up' : ''}`}>
      <div class="copy-link-heading">
        {isBatch
          ? 'Share these files — anyone with a link can open it'
          : 'Share this file — anyone with the link can open it'}
      </div>
      <div class="copy-link-presets">
        {COPY_LINK_PRESETS.map((p) => (
          <button key={p.seconds} class="btn btn-ghost btn-sm" onClick={() => copyLinks(p.seconds)} disabled={copying}>
            {p.label}
          </button>
        ))}
        <button class="btn btn-ghost btn-sm" onClick={() => setShowCustom((v) => !v)} disabled={copying}>
          Custom…
        </button>
      </div>
      {showCustom && (
        <div class="copy-link-custom">
          <input
            type="number"
            min="1"
            class="copy-link-num"
            value={customValue}
            onInput={(e) => {
              setCustomValue(e.target.value);
              setError(null);
            }}
          />
          <select class="copy-link-unit" value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}>
            <option value="minutes">min</option>
            <option value="hours">hrs</option>
            <option value="days">days</option>
          </select>
          <button class="btn btn-ghost btn-sm" onClick={handleCustomCopy} disabled={copying}>
            {copying ? <span class="spinner" /> : 'Copy'}
          </button>
        </div>
      )}
      {error && <div class="copy-link-error">{error}</div>}
      <div class="copy-link-note">{note}</div>

      {!isBatch && (
        <>
          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '.6rem 0' }} />
          <div class="copy-link-presets">
            {COPY_LINK_PRESETS.map((p) => (
              <button
                key={p.seconds}
                class="btn btn-ghost btn-sm"
                onClick={() => copyBucketerLink(p.seconds)}
                disabled={sharingViaBucketer || copying}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div class="copy-link-note">
            Share via Bucketer — same access, opened inside the app so the raw link stays out of server logs.
          </div>
        </>
      )}
    </div>
  );
}
