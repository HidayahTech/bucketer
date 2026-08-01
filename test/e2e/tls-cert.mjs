// Boot-time TLS certificate for the e2e mock's https listener.
//
// Generated, never committed: a private key in the repository trips secret scanners and
// teaches people to trust a checked-in key. openssl is present on the Fedora host and in
// the Playwright noble image (Ubuntu 24.04), so generation is cheap and local.
//
// The SAN covers localhost, *.localhost (virtual-hosted bucket addressing, e.g.
// test-bucket.localhost) and 127.0.0.1. Playwright contexts trust it via
// ignoreHTTPSErrors — nothing here needs to enter a trust store.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'artifacts', 'tls');
const KEY = join(DIR, 'key.pem');
const CERT = join(DIR, 'cert.pem');

// Certificates are minted with 2-day validity and regenerated once older than 1 day, so a
// run can never start inside the validity window and outlive it.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fresh(path) {
  try { return Date.now() - statSync(path).mtimeMs < MAX_AGE_MS; } catch { return false; }
}

export function ensureTlsCert() {
  if (!(existsSync(KEY) && existsSync(CERT) && fresh(CERT))) {
    mkdirSync(DIR, { recursive: true });
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', KEY, '-out', CERT, '-days', '2',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1',
      ], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Cannot generate the e2e TLS certificate (is openssl installed?): ${err.message}`);
    }
    // openssl writes the key with umask-default permissions; a private key — even a
    // throwaway localhost one — should not be group/world-readable.
    chmodSync(KEY, 0o600);
  }
  return { key: readFileSync(KEY), cert: readFileSync(CERT) };
}
