// Copyright (C) 2026 HidayahTech, LLC
// Stage 1 of the large-download manager: generate a ready-to-run native transfer job
// (rclone / aws-cli) for the current bucket and prefix.
//
// See docs/superpowers/specs/2026-07-30-large-download-manager-design.md.
//
// Why credentials and never presigned URLs: a bundle of presigned URLs is an
// unrevocable bearer token valid for up to seven days, and this project already declined
// presigned-URL revoke as out of scope. Credentials are no more sensitive than what the
// user already holds, and rotating the key revokes them. This is also why aria2c is not
// offered — it is only useful with a presigned-URL list.

import { PROVIDERS } from './provider.js';

export const SECRET_PLACEHOLDER = '<YOUR_SECRET_KEY>';

// rclone's s3 backend `provider` values, verified against https://rclone.org/s3/ on
// 2026-07-30. There is deliberately no "Backblaze" entry — that list has none, and
// emitting one would make `rclone config` reject the stanza. B2 works as "Other"
// against its S3-compatible endpoint.
const RCLONE_PROVIDERS = {
  [PROVIDERS.AWS]: 'AWS',
  [PROVIDERS.R2]: 'Cloudflare',
  [PROVIDERS.WASABI]: 'Wasabi',
  [PROVIDERS.DO_SPACES]: 'DigitalOcean',
  [PROVIDERS.MINIO]: 'Minio',
  [PROVIDERS.B2]: 'Other',
  [PROVIDERS.GENERIC]: 'Other',
};

export function rcloneProvider(provider) {
  return RCLONE_PROVIDERS[provider] ?? 'Other';
}

// rclone remotes are referenced as `name:path`. Naming the remote after the bucket produces
// "my-bucket:my-bucket", which reads like a mistake, so the remote carries a `bucketer-`
// prefix: the command then reads unambiguously as remote:path. The name is also reduced to a
// conservative alphanumeric/dash/underscore set rather than passing a bucket name through raw.
export function rcloneRemoteName(bucket) {
  const cleaned = String(bucket ?? '').replace(/[^A-Za-z0-9_-]/g, '-');
  return /[A-Za-z0-9]/.test(cleaned) ? `bucketer-${cleaned}` : 'bucketer';
}

// POSIX single-quote escaping. The generated commands are pasted into a real shell, and
// S3 keys are arbitrary byte strings, so a prefix containing a quote must not be able to
// terminate its argument and start a new command.
export function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

// A credential or endpoint carrying a newline would otherwise inject a whole extra
// config line into the ini stanza.
function configValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '');
}

function normalizePrefix(prefix) {
  return String(prefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function buildRcloneConfig({ provider, endpoint, region, keyId, secretKey, remoteName, includeSecret = false }) {
  const lines = [
    `[${configValue(remoteName)}]`,
    'type = s3',
    `provider = ${rcloneProvider(provider)}`,
    `access_key_id = ${configValue(keyId)}`,
    `secret_access_key = ${includeSecret ? configValue(secretKey) : SECRET_PLACEHOLDER}`,
    `endpoint = ${configValue(endpoint)}`,
  ];
  if (region) lines.push(`region = ${configValue(region)}`);
  return lines.join('\n');
}

// --retries 99 / --low-level-retries 20 rather than rclone's defaults: over a multi-day
// transfer on an unreliable link, transient failure is the normal case, not the exception.
export function buildRcloneCommand({ remoteName, bucket, prefix, destDir }) {
  const p = normalizePrefix(prefix);
  const source = `${remoteName}:${bucket}${p ? `/${p}` : ''}`;
  return [
    'rclone copy',
    shellQuote(source),
    shellQuote(destDir),
    '--progress --transfers 4 --checkers 8 --retries 99 --low-level-retries 20',
  ].join(' ');
}

export function buildAwsCliCommand({ endpoint, bucket, prefix, region, destDir }) {
  const p = normalizePrefix(prefix);
  const source = `s3://${bucket}${p ? `/${p}` : ''}`;
  const parts = [
    'aws s3 sync',
    shellQuote(source),
    shellQuote(destDir),
    `--endpoint-url ${shellQuote(endpoint)}`,
  ];
  if (region) parts.push(`--region ${shellQuote(region)}`);
  return parts.join(' ');
}

export function buildTransferRecipe({
  provider, endpoint, region, bucket, prefix, keyId, secretKey, includeSecret = false, destDir,
}) {
  const remoteName = rcloneRemoteName(bucket);
  const dest = destDir || `./${bucket || 'download'}`;
  return {
    remoteName,
    destDir: dest,
    rcloneConfig: buildRcloneConfig({ provider, endpoint, region, keyId, secretKey, remoteName, includeSecret }),
    rcloneCommand: buildRcloneCommand({ remoteName, bucket, prefix, destDir: dest }),
    awsCommand: buildAwsCliCommand({ endpoint, bucket, prefix, region, destDir: dest }),
  };
}
