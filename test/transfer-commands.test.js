// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/transfer-commands.js — the Stage 1 CLI transfer handoff.
//
// Two properties here are security properties, not conveniences:
//   1. The secret key must be absent from output unless explicitly requested.
//   2. Generated shell commands are pasted into a real shell by the user, and S3 keys
//      are arbitrary byte strings, so prefix/bucket text must never escape its quoting.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rcloneProvider,
  rcloneRemoteName,
  shellQuote,
  buildRcloneConfig,
  buildRcloneCommand,
  buildAwsCliCommand,
  buildTransferRecipe,
  SECRET_PLACEHOLDER,
} from '../src/lib/transfer-commands.js';
import { PROVIDERS } from '../src/lib/provider.js';

describe('rcloneProvider', () => {
  test('AWS', () => assert.equal(rcloneProvider(PROVIDERS.AWS), 'AWS'));
  test('R2 maps to Cloudflare', () => assert.equal(rcloneProvider(PROVIDERS.R2), 'Cloudflare'));
  test('Wasabi', () => assert.equal(rcloneProvider(PROVIDERS.WASABI), 'Wasabi'));
  test('DigitalOcean Spaces', () => assert.equal(rcloneProvider(PROVIDERS.DO_SPACES), 'DigitalOcean'));
  test('MinIO', () => assert.equal(rcloneProvider(PROVIDERS.MINIO), 'Minio'));

  // Verified against https://rclone.org/s3/ on 2026-07-30: the s3 backend's provider
  // list has no "Backblaze" entry. Emitting one would fail `rclone config`.
  test('B2 falls back to Other (rclone has no Backblaze s3 provider)', () =>
    assert.equal(rcloneProvider(PROVIDERS.B2), 'Other'));
  test('generic', () => assert.equal(rcloneProvider(PROVIDERS.GENERIC), 'Other'));
  test('unknown provider', () => assert.equal(rcloneProvider('nonsense'), 'Other'));
});

describe('rcloneRemoteName', () => {
  // Prefixed so the generated command reads as remote:path rather than the confusing
  // "my-bucket:my-bucket" you get when the remote is named after the bucket itself.
  test('prefixes the bucket name', () =>
    assert.equal(rcloneRemoteName('my-bucket'), 'bucketer-my-bucket'));

  test('replaces characters invalid in a remote name', () =>
    assert.equal(rcloneRemoteName('my.bucket.name'), 'bucketer-my-bucket-name'));

  test('falls back when the name reduces to nothing', () =>
    assert.equal(rcloneRemoteName('...'), 'bucketer'));

  test('falls back on empty input', () =>
    assert.equal(rcloneRemoteName(''), 'bucketer'));
});

describe('shellQuote', () => {
  test('wraps a plain value in single quotes', () =>
    assert.equal(shellQuote('plain'), "'plain'"));

  test('neutralises command substitution', () =>
    assert.equal(shellQuote('$(whoami)'), "'$(whoami)'"));

  // The POSIX idiom: close the quote, emit an escaped quote, reopen.
  test('escapes an embedded single quote', () =>
    assert.equal(shellQuote("it's"), "'it'\\''s'"));

  test('a hostile prefix cannot break out of its quoting', () => {
    const hostile = "foo'; rm -rf ~; echo '";
    const quoted = shellQuote(hostile);
    // Every bare single quote in the output is either the outer pair or part of
    // the \'\'' escape sequence — no unescaped quote survives to end the string early.
    assert.equal(quoted.startsWith("'"), true);
    assert.equal(quoted.endsWith("'"), true);
    assert.equal(quoted.includes("'\\''"), true);
    assert.equal(quoted.replaceAll("'\\''", ''), `'foo; rm -rf ~; echo '`);
  });
});

describe('buildRcloneConfig', () => {
  const base = {
    provider: PROVIDERS.B2,
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    keyId: 'KEY123',
    secretKey: 'SUPERSECRET',
    remoteName: 'my-bucket',
  };

  test('emits a valid s3 stanza', () => {
    const out = buildRcloneConfig({ ...base, includeSecret: true });
    assert.match(out, /^\[my-bucket\]$/m);
    assert.match(out, /^type = s3$/m);
    assert.match(out, /^provider = Other$/m);
    assert.match(out, /^access_key_id = KEY123$/m);
    assert.match(out, /^endpoint = https:\/\/s3\.us-west-004\.backblazeb2\.com$/m);
    assert.match(out, /^region = us-west-004$/m);
  });

  test('includes the secret when explicitly requested', () => {
    const out = buildRcloneConfig({ ...base, includeSecret: true });
    assert.match(out, /^secret_access_key = SUPERSECRET$/m);
  });

  test('SECURITY: omits the secret by default', () => {
    const out = buildRcloneConfig(base);
    assert.equal(out.includes('SUPERSECRET'), false);
    assert.match(out, new RegExp(`^secret_access_key = ${SECRET_PLACEHOLDER}$`, 'm'));
  });

  test('omits the region line when no region is known', () => {
    const out = buildRcloneConfig({ ...base, region: null });
    assert.equal(/^region = /m.test(out), false);
  });

  test('SECURITY: a newline in a credential cannot inject a config line', () => {
    const out = buildRcloneConfig({ ...base, keyId: 'KEY\nprovider = AWS', includeSecret: true });
    assert.equal(/^provider = AWS$/m.test(out), false);
  });
});

describe('buildRcloneCommand', () => {
  test('builds a copy command for a prefix', () => {
    const cmd = buildRcloneCommand({ remoteName: 'r', bucket: 'b', prefix: 'videos/2024/', destDir: './out' });
    assert.match(cmd, /^rclone copy /);
    assert.equal(cmd.includes("'r:b/videos/2024'"), true);
    assert.equal(cmd.includes("'./out'"), true);
  });

  test('targets the bucket root when there is no prefix', () => {
    const cmd = buildRcloneCommand({ remoteName: 'r', bucket: 'b', prefix: '', destDir: './out' });
    assert.equal(cmd.includes("'r:b'"), true);
  });

  test('normalises a leading slash in the prefix', () => {
    const cmd = buildRcloneCommand({ remoteName: 'r', bucket: 'b', prefix: '/videos/', destDir: './out' });
    assert.equal(cmd.includes("'r:b/videos'"), true);
  });

  test('carries the resilience flags a slow link needs', () => {
    const cmd = buildRcloneCommand({ remoteName: 'r', bucket: 'b', prefix: '', destDir: './out' });
    assert.equal(cmd.includes('--progress'), true);
    assert.equal(cmd.includes('--retries'), true);
    assert.equal(cmd.includes('--low-level-retries'), true);
  });

  // The dangerous text is still present — that is what quoting is for. What must hold is
  // that it cannot terminate the quoted argument, so we assert the exact escaped form.
  test('SECURITY: a hostile prefix cannot terminate its argument', () => {
    const cmd = buildRcloneCommand({ remoteName: 'r', bucket: 'b', prefix: "a'; rm -rf ~; echo '", destDir: './out' });
    assert.equal(cmd.includes("'r:b/a'\\''; rm -rf ~; echo '\\'''"), true);
  });
});

describe('buildAwsCliCommand', () => {
  test('includes the endpoint and region', () => {
    const cmd = buildAwsCliCommand({
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      bucket: 'b', prefix: 'v/', region: 'us-west-004', destDir: './out',
    });
    assert.match(cmd, /^aws s3 sync /);
    assert.equal(cmd.includes("'s3://b/v'"), true);
    assert.equal(cmd.includes("--endpoint-url 'https://s3.us-west-004.backblazeb2.com'"), true);
    assert.equal(cmd.includes("--region 'us-west-004'"), true);
  });

  test('omits the region flag when no region is known', () => {
    const cmd = buildAwsCliCommand({ endpoint: 'https://e', bucket: 'b', prefix: '', region: null, destDir: './out' });
    assert.equal(cmd.includes('--region'), false);
  });
});

describe('buildTransferRecipe', () => {
  const creds = {
    provider: PROVIDERS.AWS,
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    bucket: 'my-bucket',
    prefix: 'data/',
    keyId: 'AKIA',
    secretKey: 'SUPERSECRET',
  };

  test('returns both recipes', () => {
    const r = buildTransferRecipe(creds);
    assert.equal(typeof r.rcloneConfig, 'string');
    assert.equal(typeof r.rcloneCommand, 'string');
    assert.equal(typeof r.awsCommand, 'string');
  });

  test('defaults the destination to a directory named after the bucket', () => {
    const r = buildTransferRecipe(creds);
    assert.equal(r.destDir, './my-bucket');
    assert.equal(r.rcloneCommand.includes("'./my-bucket'"), true);
  });

  test('reads as remote:path, not bucket:bucket', () => {
    const r = buildTransferRecipe(creds);
    assert.equal(r.rcloneCommand.includes("'bucketer-my-bucket:my-bucket/data'"), true);
  });

  test('SECURITY: the secret is absent from every field by default', () => {
    const r = buildTransferRecipe(creds);
    for (const [field, value] of Object.entries(r)) {
      if (typeof value !== 'string') continue;
      assert.equal(value.includes('SUPERSECRET'), false, `secret leaked into ${field}`);
    }
  });

  test('includes the secret only in the config, and only when asked', () => {
    const r = buildTransferRecipe({ ...creds, includeSecret: true });
    assert.equal(r.rcloneConfig.includes('SUPERSECRET'), true);
    assert.equal(r.rcloneCommand.includes('SUPERSECRET'), false);
    assert.equal(r.awsCommand.includes('SUPERSECRET'), false);
  });
});
