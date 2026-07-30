// Copyright (C) 2026 HidayahTech, LLC
// Stage 1 of the large-download manager: hand a very large transfer off to a native tool.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// A browser tab is a poor host for a transfer measured in days — 1 TB at 5 Mbps is roughly
// 18.5 days — so above a certain size the honest answer is a tool built for it. This modal
// generates that job rather than describing it, the way SetupGuide generates CORS config.
//
// The secret key is withheld by default. Rendering it is a deliberate, per-use choice,
// because the generated config is usually pasted into a file that then sits on disk.
import { useState } from 'preact/hooks';
import { Modal } from './Modal.jsx';
import { extractRegion, PROVIDER_LABELS } from '../lib/provider.js';
import { buildTransferRecipe } from '../lib/transfer-commands.js';

function CodeBlock({ label, value, hint }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(value).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {},
    );
  };

  return (
    <div class="handoff-block">
      <div class="handoff-block-head">
        <span class="handoff-block-label">{label}</span>
        <button type="button" class="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre class="handoff-code">{value}</pre>
      {hint && <p class="handoff-hint">{hint}</p>}
    </div>
  );
}

export function TransferHandoff({ credentials, currentPrefix = '', onClose }) {
  const [includeSecret, setIncludeSecret] = useState(false);

  const region = credentials.regionOverride || extractRegion(credentials.endpoint, credentials.provider);
  const recipe = buildTransferRecipe({
    provider:   credentials.provider,
    endpoint:   credentials.endpoint,
    region,
    bucket:     credentials.bucket,
    prefix:     currentPrefix,
    keyId:      credentials.keyId,
    secretKey:  credentials.secretKey,
    includeSecret,
  });

  const providerLabel = PROVIDER_LABELS[credentials.provider] ?? 'your provider';
  const scope = currentPrefix ? `${credentials.bucket}/${currentPrefix}` : credentials.bucket;

  return (
    <Modal onClose={onClose} class="handoff-dialog">
      <div class="sv-header">
        <div class="modal-title">Download with a transfer tool</div>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="handoff-close" onClick={onClose}>
          Close
        </button>
      </div>

      <div class="handoff-body">
        <p class="handoff-intro">
          For very large downloads, a dedicated transfer tool is more reliable than any browser.
          It survives reboots, retries indefinitely, and can run unattended — none of which a
          browser tab can do. Below is a ready-to-run job for <code>{scope}</code> on {providerLabel}.
        </p>

        <div class="handoff-secret-toggle">
          <button
            type="button"
            class={includeSecret ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
            data-testid="include-secret"
            aria-pressed={includeSecret ? 'true' : 'false'}
            onClick={() => setIncludeSecret(v => !v)}
          >
            {includeSecret ? 'Hide secret key' : 'Include secret key'}
          </button>
          <span class="handoff-hint">
            {includeSecret
              ? 'The secret key is shown below.'
              : 'The config uses a placeholder; paste your own secret key in its place.'}
          </span>
        </div>

        {includeSecret && (
          <p class="handoff-warning" data-testid="secret-warning">
            This config now contains your secret key. Anyone who reads the file it lands in has
            the same access to this bucket that you do. Store it with the permissions you would
            give a password, and rotate the key if it is exposed.
          </p>
        )}

        <CodeBlock
          label="rclone — add to your rclone config"
          value={recipe.rcloneConfig}
          hint={`Run "rclone config file" to find the config path, or paste this into a new file and pass it with --config.`}
        />

        <CodeBlock
          label="rclone — run the transfer"
          value={recipe.rcloneCommand}
          hint="Re-running this command resumes where it left off; already-downloaded files are skipped."
        />

        <CodeBlock
          label="AWS CLI — alternative"
          value={recipe.awsCommand}
          hint="Reads credentials from your AWS CLI profile or the standard environment variables."
        />
      </div>
    </Modal>
  );
}
