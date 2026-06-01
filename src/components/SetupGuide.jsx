// Copyright (C) 2026 HidayahTech, LLC
// Provider-specific CORS setup guide (§4.2, §4.8).
//
// CORS is a blocking prerequisite: without it, browsers reject all S3 API responses.
// This guide generates correct aws s3api put-bucket-cors commands pre-filled with the
// user's endpoint, bucket, and key ID to minimize transcription errors.
//
// Provider differences:
//   B2:     ClearNativeCors step required first (native rules conflict with S3 API rules)
//   R2:     Region 'auto'; warns about 7-day auto-abort of incomplete multipart uploads
//   Wasabi: No CORS setup needed — returns permissive headers automatically
//   AWS:    Standard put-bucket-cors without --endpoint-url
//   MinIO:  Standard put-bucket-cors with custom endpoint
//
// File:// origin: browsers send Origin: null for local files; most providers reject "null".
// When window.location.protocol === 'file:', the guide uses wildcard origin "*" and warns
// that users must re-run CORS setup with a real origin after deploying to a domain.
import { useState } from 'preact/hooks';
import { PROVIDERS, extractRegion, needsCorsConfig } from '../lib/provider.js';
import { corsJson } from '../lib/cors-config.js';

const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';

function currentOrigin() {
  if (typeof window === 'undefined') return 'https://yourdomain.com';
  if (isFileProtocol) return '*';
  return window.location.origin;
}

function Code({ children }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre class="cors-cmd">{children}</pre>
      {navigator.clipboard && (
        <button
          type="button"
          class="btn btn-sm"
          style={{
            position: 'absolute', top: '.35rem', right: '.35rem',
            fontSize: '.7rem', padding: '.2rem .45rem',
            background: 'rgba(255,255,255,.15)', color: '#cdd6f4',
            border: '1px solid rgba(255,255,255,.25)',
          }}
          onClick={copy}
        >{copied ? '✓ Copied' : 'Copy'}</button>
      )}
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: '.75rem', alignItems: 'flex-start' }}>
      <span style={{
        flexShrink: 0, width: '1.5rem', height: '1.5rem', borderRadius: '50%',
        background: 'var(--accent)', color: '#fff', fontSize: '.75rem',
        fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: '.35rem' }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function corsCmd({ endpoint, bucket, origin, profile = 'bucketer' }) {
  return `aws s3api put-bucket-cors \\
  --profile ${profile} \\
  --endpoint-url ${endpoint || 'https://s3.<region>.backblazeb2.com'} \\
  --bucket ${bucket || '<your-bucket>'} \\
  --cors-configuration '${corsJson(origin)}'`;
}

// ── Provider-specific guides ───────────────────────────────────────────────

function GuideB2({ endpoint, bucket, keyId }) {
  const region = endpoint ? extractRegion(endpoint, PROVIDERS.B2) : '<region>';
  const ep = endpoint || `https://s3.${region}.backblazeb2.com`;
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Install the AWS CLI">
        <p class="cors-note">
          Download from <a href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" target="_blank" rel="noopener">aws.amazon.com/cli</a> or via your package manager:
        </p>
        <Code>{`# Debian/Ubuntu
sudo apt install awscli

# macOS
brew install awscli

# Windows (winget)
winget install Amazon.AWSCLI`}</Code>
      </Step>

      <Step n="2" title="Configure a B2 profile">
        <p class="cors-note">
          Use an application key — <strong>not</strong> your master key. Create one in the B2 console
          under <em>App Keys</em> with access to this bucket.
        </p>
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<your-key-id>'}
# AWS Secret Access Key: <your-secret-key>
# Default region name:   ${region || '<region e.g. us-west-004>'}
# Default output format: json`}</Code>
      </Step>

      <Step n="3" title="Remove any existing B2 native CORS rules">
        <p class="cors-note">
          B2 won't apply S3-compatible CORS rules if native rules are already set.
          Check first — if <code>corsRules</code> is non-empty in the output below, clear them:
        </p>
        <Code>{`# Check existing rules
b2 bucket get ${bkt}

# Clear native rules (only needed if corsRules is non-empty)
b2 bucket update ${bkt} --cors-rules '[]'`}</Code>
        <p class="cors-note" style={{ marginTop: '.4rem' }}>
          If <code>b2</code> isn't installed: <code>pip install b2</code>
        </p>
      </Step>

      <Step n="4" title="Apply S3-compatible CORS rules">
        {isFileProtocol && (
          <p class="cors-note cors-note-warn" style={{ marginBottom: '.4rem' }}>
            You're running from <code>file://</code> — using <code>"*"</code> (wildcard) as the allowed origin,
            since browsers send <code>Origin: null</code> for local files and most providers reject <code>"null"</code> as invalid.
            If you later deploy to a domain, re-run this with that specific origin instead.
          </p>
        )}
        <Code>{corsCmd({ endpoint: ep, bucket: bkt, origin, profile: 'bucketer' })}</Code>
      </Step>

      <Step n="5" title="Verify">
        <Code>{`aws s3api get-bucket-cors \\
  --profile bucketer \\
  --endpoint-url ${ep} \\
  --bucket ${bkt}`}</Code>
        <p class="cors-note" style={{ marginTop: '.4rem' }}>
          You should see the rules you just applied. Then refresh this page and connect.
        </p>
      </Step>
    </div>
  );
}

function GuideR2({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://<account-id>.r2.cloudflarestorage.com';
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Install the AWS CLI">
        <Code>{`# Debian/Ubuntu
sudo apt install awscli

# macOS
brew install awscli`}</Code>
      </Step>

      <Step n="2" title="Configure an R2 profile">
        <p class="cors-note">
          Get your R2 API token from the Cloudflare dashboard → R2 → Manage R2 API Tokens.
          Use <code>auto</code> as the region.
        </p>
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<r2-access-key-id>'}
# AWS Secret Access Key: <r2-secret-access-key>
# Default region name:   auto
# Default output format: json`}</Code>
      </Step>

      <Step n="3" title="Apply CORS rules">
        <p class="cors-note">
          R2 has supported <code>put-bucket-cors</code> via the S3 API since September 2022.
        </p>
        <Code>{corsCmd({ endpoint: ep, bucket: bkt, origin, profile: 'bucketer' })}</Code>
        <p class="cors-note" style={{ marginTop: '.4rem' }}>
          <strong>Note:</strong> R2 automatically aborts incomplete multipart uploads after 7 days,
          so orphaned parts won't accumulate.
        </p>
      </Step>

      <Step n="4" title="Verify">
        <Code>{`aws s3api get-bucket-cors \\
  --profile bucketer \\
  --endpoint-url ${ep} \\
  --bucket ${bkt}`}</Code>
      </Step>
    </div>
  );
}

function GuideWasabi({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://s3.<region>.wasabisys.com';

  return (
    <div class="setup-steps">
      <Step n="1" title="No CORS configuration needed">
        <p class="cors-note">
          Wasabi automatically returns permissive CORS headers for any request that includes
          an <code>Origin</code> header. You can skip straight to connecting.
        </p>
      </Step>

      <Step n="2" title="Configure AWS CLI (optional — for other management tasks)">
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<wasabi-access-key>'}
# AWS Secret Access Key: <wasabi-secret-key>
# Default region name:   <region e.g. us-east-1>
# Default output format: json`}</Code>
        <p class="cors-note" style={{ marginTop: '.4rem' }}>
          Wasabi endpoint format: <code>https://s3.{'<region>'}.wasabisys.com</code>
        </p>
      </Step>
    </div>
  );
}

function GuideAWS({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://s3.<region>.amazonaws.com';
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Install and configure the AWS CLI">
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<access-key-id>'}
# AWS Secret Access Key: <secret-access-key>
# Default region name:   <region e.g. us-east-1>
# Default output format: json`}</Code>
      </Step>

      <Step n="2" title="Apply CORS rules">
        <p class="cors-note">
          For AWS S3 you can omit <code>--endpoint-url</code> (it's the default endpoint).
        </p>
        <Code>{`aws s3api put-bucket-cors \\
  --profile bucketer \\
  --bucket ${bkt} \\
  --cors-configuration '${corsJson(origin)}'`}</Code>
      </Step>

      <Step n="3" title="Verify">
        <Code>{`aws s3api get-bucket-cors --profile bucketer --bucket ${bkt}`}</Code>
      </Step>
    </div>
  );
}

function GuideDOSpaces({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://<region>.digitaloceanspaces.com';
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Configure AWS CLI with Spaces credentials">
        <p class="cors-note">
          Generate a Spaces access key in the DigitalOcean dashboard → API → Spaces Keys.
        </p>
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<spaces-key>'}
# AWS Secret Access Key: <spaces-secret>
# Default region name:   <region e.g. nyc3>
# Default output format: json`}</Code>
      </Step>

      <Step n="2" title="Apply CORS rules">
        <Code>{corsCmd({ endpoint: ep, bucket: bkt, origin, profile: 'bucketer' })}</Code>
      </Step>

      <Step n="3" title="Verify">
        <Code>{`aws s3api get-bucket-cors \\
  --profile bucketer \\
  --endpoint-url ${ep} \\
  --bucket ${bkt}`}</Code>
      </Step>
    </div>
  );
}

function GuideMinIO({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://<your-minio-host>';
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Configure AWS CLI for MinIO">
        <p class="cors-note">
          Use your MinIO access key and secret. Set the region to whatever your MinIO
          deployment uses (<code>us-east-1</code> is the common placeholder).
        </p>
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<minio-access-key>'}
# AWS Secret Access Key: <minio-secret-key>
# Default region name:   us-east-1
# Default output format: json`}</Code>
      </Step>

      <Step n="2" title="Apply CORS rules">
        <p class="cors-note">
          MinIO requires <code>forcePathStyle</code> — select <strong>MinIO</strong> in the Provider
          Override dropdown so the app applies it automatically.
        </p>
        <Code>{corsCmd({ endpoint: ep, bucket: bkt, origin, profile: 'bucketer' })}</Code>
      </Step>

      <Step n="3" title="Verify">
        <Code>{`aws s3api get-bucket-cors \\
  --profile bucketer \\
  --endpoint-url ${ep} \\
  --bucket ${bkt}`}</Code>
      </Step>
    </div>
  );
}

function GuideGeneric({ endpoint, bucket, keyId }) {
  const ep = endpoint || 'https://<your-endpoint>';
  const origin = currentOrigin();
  const bkt = bucket || '<your-bucket>';

  return (
    <div class="setup-steps">
      <Step n="1" title="Configure AWS CLI">
        <Code>{`aws configure --profile bucketer
# AWS Access Key ID:     ${keyId || '<access-key-id>'}
# AWS Secret Access Key: <secret-access-key>
# Default region name:   <region>
# Default output format: json`}</Code>
      </Step>

      <Step n="2" title="Apply CORS rules">
        <Code>{corsCmd({ endpoint: ep, bucket: bkt, origin, profile: 'bucketer' })}</Code>
      </Step>

      <Step n="3" title="Verify">
        <Code>{`aws s3api get-bucket-cors \\
  --profile bucketer \\
  --endpoint-url ${ep} \\
  --bucket ${bkt}`}</Code>
      </Step>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

const GUIDE_TITLES = {
  [PROVIDERS.B2]:       'Backblaze B2 setup guide',
  [PROVIDERS.R2]:       'Cloudflare R2 setup guide',
  [PROVIDERS.WASABI]:   'Wasabi setup guide',
  [PROVIDERS.AWS]:      'AWS S3 setup guide',
  [PROVIDERS.DO_SPACES]:'DigitalOcean Spaces setup guide',
  [PROVIDERS.MINIO]:    'MinIO setup guide',
  [PROVIDERS.GENERIC]:  'S3-compatible setup guide',
};

export function SetupGuide({ provider, endpoint, bucket, keyId }) {
  if (!provider) return null;

  const title = GUIDE_TITLES[provider] || 'Setup guide';
  const isWasabi = provider === PROVIDERS.WASABI;

  const GuideComponent = {
    [PROVIDERS.B2]:        GuideB2,
    [PROVIDERS.R2]:        GuideR2,
    [PROVIDERS.WASABI]:    GuideWasabi,
    [PROVIDERS.AWS]:       GuideAWS,
    [PROVIDERS.DO_SPACES]: GuideDOSpaces,
    [PROVIDERS.MINIO]:     GuideMinIO,
    [PROVIDERS.GENERIC]:   GuideGeneric,
  }[provider] || GuideGeneric;

  const needsAttention = !isWasabi && isFileProtocol;

  return (
    <details class="cors-guide">
      <summary style={{ color: needsAttention ? 'var(--text-warn)' : 'var(--accent)' }}>
        {needsAttention ? '⚠ ' : ''}{title}
      </summary>
      <div class="cors-guide-body">
        <GuideComponent endpoint={endpoint} bucket={bucket} keyId={keyId} />
      </div>
    </details>
  );
}
