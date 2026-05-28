#!/usr/bin/env node
// Bundles src/main.jsx with esbuild and inlines the result into src/index.html,
// producing a single self-contained dist/index.html (required for file:// Chrome compat, §4.3).

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

// ── Build invariant: update-check metadata must fit within this byte range ──
// UpdateBanner fetches Range: bytes=0-(UPDATE_CHECK_RANGE_BYTES-1) to detect
// the version of a newer build without downloading the full page. Both
// build-id and app-version meta tags must end before this boundary.
// The assertion below enforces this on every build and will fail loudly if
// a structural change pushes them past it.
const UPDATE_CHECK_RANGE_BYTES = 512;

const dev = process.argv.includes('--dev');

const result = await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  // Use Preact's automatic JSX runtime — no React import needed in each file
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const rawCss = readFileSync('src/styles/main.css', 'utf8');
const cssResult = await esbuild.transform(rawCss, { loader: 'css', minify: !dev });
const css = cssResult.code;
const html = readFileSync('src/index.html', 'utf8');
const buildId = new Date().toISOString();
const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
// Use a function to avoid $ special replacement patterns in the JS/CSS content
const out = html
  .replace('<!-- BUILD_ID -->', buildId)
  .replace('<!-- APP_VERSION -->', appVersion)
  .replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', out, 'utf8');
console.log(`Built dist/index.html (${(out.length / 1024).toFixed(1)} KB)`);

// ── Enforce build invariant: update-check metadata within range boundary ────
const outBytes = Buffer.from(out, 'utf8');
const invariantTags = ['build-id', 'app-version'];
let invariantFailed = false;
for (const tag of invariantTags) {
  const searchStr = `name="${tag}"`;
  const idx = out.indexOf(searchStr);
  if (idx === -1) {
    console.error(`\nBuild invariant FAILED: <meta name="${tag}"> not found in output.`);
    invariantFailed = true;
    continue;
  }
  const closeIdx = out.indexOf('>', idx);
  const endByte = Buffer.byteLength(out.slice(0, closeIdx + 1), 'utf8');
  if (endByte >= UPDATE_CHECK_RANGE_BYTES) {
    console.error(
      `\nBuild invariant FAILED: <meta name="${tag}"> ends at byte ${endByte}, ` +
      `which exceeds the update-check range boundary of ${UPDATE_CHECK_RANGE_BYTES} bytes.\n` +
      `Move the tag earlier in <head> or increase UPDATE_CHECK_RANGE_BYTES in build.mjs ` +
      `and UpdateBanner.jsx (keeping them in sync).`
    );
    invariantFailed = true;
  } else {
    console.log(`  ✓ ${tag} ends at byte ${endByte} (limit: ${UPDATE_CHECK_RANGE_BYTES})`);
  }
}
if (invariantFailed) process.exit(1);

// Generate favicon.ico from logo (requires ImageMagick 7+)
try {
  execFileSync('magick', [
    'src/assets/bucketer-logo.png',
    '-resize', '256x256',
    '-define', 'icon:auto-resize=256,128,64,48,32,16',
    'dist/favicon.ico',
  ]);
  console.log('Generated dist/favicon.ico');
} catch {
  console.warn('favicon.ico generation skipped (ImageMagick not available)');
}
