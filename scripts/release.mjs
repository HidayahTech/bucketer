// Copyright (C) 2026 HidayahTech, LLC
// CI release script — uploads dist/index.html to the Package Registry and
// creates a GitLab Release with the CHANGELOG description for the tagged version.
// Runs in the CI release job; requires CI_COMMIT_TAG, CI_JOB_TOKEN,
// CI_PROJECT_ID, and CI_API_V4_URL to be set (all predefined in GitLab CI).

import { readFileSync } from 'fs';
import { request } from 'https';
import { URL } from 'url';

const TAG     = process.env.CI_COMMIT_TAG;
const TOKEN   = process.env.CI_JOB_TOKEN;
const PROJECT = process.env.CI_PROJECT_ID;
const API_V4  = process.env.CI_API_V4_URL;

for (const [name, val] of Object.entries({ CI_COMMIT_TAG: TAG, CI_JOB_TOKEN: TOKEN, CI_PROJECT_ID: PROJECT, CI_API_V4_URL: API_V4 })) {
  if (!val) { console.error(`Missing required variable: ${name}`); process.exit(1); }
}

const VERSION  = TAG.replace(/^v/, '');
const FILENAME = `bucketer-${TAG}.html`;
const PKG_URL  = `${API_V4}/projects/${PROJECT}/packages/generic/bucketer/${VERSION}/${FILENAME}`;

function httpRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, 'Content-Length': body.length },
    };
    const req = request(options, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Parse CHANGELOG for this version's title and bullet points
const changelog = readFileSync('CHANGELOG.md', 'utf8');
let releaseName = TAG;
let description = '';
for (const section of changelog.split(/^## /m).slice(1)) {
  const lines = section.split('\n');
  const m = lines[0].trim().match(/^\[([^\]]+)\]\s+—\s+\S+\s+—\s+(.+)$/);
  if (m && m[1] === VERSION) {
    releaseName = `${TAG} — ${m[2].trim()}`;
    description = lines.filter(l => l.trimStart().startsWith('- ')).map(l => l.trim()).join('\n');
    break;
  }
}

// Upload dist/index.html to the Generic Package Registry
console.log(`Uploading ${FILENAME}...`);
const fileBuffer = readFileSync('dist/index.html');
const upload = await httpRequest('PUT', PKG_URL, fileBuffer, {
  'JOB-TOKEN': TOKEN,
  'Content-Type': 'application/octet-stream',
});
if (upload.status !== 200 && upload.status !== 201) {
  console.error(`Upload failed — HTTP ${upload.status}`);
  console.error(upload.body.slice(0, 400));
  process.exit(1);
}
console.log(`Uploaded — HTTP ${upload.status}`);

// Create the GitLab Release
console.log(`Creating release ${releaseName}...`);
const releasePayload = Buffer.from(JSON.stringify({
  name: releaseName,
  tag_name: TAG,
  description,
  assets: {
    links: [{
      name: FILENAME,
      url: PKG_URL,
      link_type: 'package',
    }],
  },
}));
const release = await httpRequest(
  'POST',
  `${API_V4}/projects/${PROJECT}/releases`,
  releasePayload,
  { 'JOB-TOKEN': TOKEN, 'Content-Type': 'application/json' },
);
if (release.status === 201) {
  console.log(`Release ${TAG} created.`);
} else {
  console.error(`Release creation failed — HTTP ${release.status}`);
  console.error(release.body.slice(0, 400));
  process.exit(1);
}
