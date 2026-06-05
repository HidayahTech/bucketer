#!/usr/bin/env node
// Bundles src/main.jsx with esbuild and inlines the result into src/index.html.
// Produces a single self-contained HTML file at the mode's destination directory.
//
// Usage: node build.mjs [--mode prod|dev|perf]
//   prod (default) — minified, no source maps, production invariants → dist/
//   dev            — unminified, inline source maps, no invariants   → dist/
//   perf           — unminified, inline source maps, no invariants   → perf/
//
// Legacy: --dev is accepted as an alias for --mode dev.

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';

// ── Build invariant constant (prod only) ─────────────────────────────────────
// UpdateBanner uses Range: bytes=0-(UPDATE_CHECK_RANGE_BYTES-1) to detect a
// newer version without fetching the full page. Both build-id and app-version
// meta tags must end before this boundary.
const UPDATE_CHECK_RANGE_BYTES = 512;

// ── Mode definitions ──────────────────────────────────────────────────────────
const MODES = {
  prod: { dest: 'dist', minify: true,  sourcemap: false,    nodeEnv: 'production',  invariants: true  },
  dev:  { dest: 'dist', minify: false, sourcemap: 'inline', nodeEnv: 'development', invariants: false },
  perf: { dest: 'perf', minify: false, sourcemap: 'inline', nodeEnv: 'development', invariants: false },
};

const modeKey = process.argv.find(a => a.startsWith('--mode='))?.slice(7)
  ?? (process.argv.includes('--dev') ? 'dev' : 'prod');

if (!MODES[modeKey]) {
  console.error(`Unknown build mode: ${modeKey}. Valid modes: ${Object.keys(MODES).join(', ')}`);
  process.exit(1);
}

const mode     = MODES[modeKey];
const appTitle = 'Bucketer — In-Browser S3-Compatible Bucket Manager';

// Read package version up front — needed for changelog generation before esbuild.
const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;

// ── Generate src/lib/changelog.js from CHANGELOG.md ─────────────────────────
// CHANGELOG.md is the single source of truth for version history. This step
// parses it into structured data and writes changelog.js before esbuild runs,
// so the in-app changelog modal always reflects exactly what is in CHANGELOG.md.
//
// Heading format: ## [version] — date — Title
// Bullet lines (- ...) become the changes array; backtick markers are stripped
// for plain-text display in the modal.

function parseChangelog(src) {
  const entries = [];
  const sections = src.split(/^## /m).slice(1); // drop preamble
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0].trim();
    const m = header.match(/^\[([^\]]+)\]\s+—\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+))?$/);
    if (!m) continue;
    const [, version, date, title] = m;
    // Two-level parse: **Bold lines** become group labels; following bullet lines
    // are nested under them. Bullet lines before any group remain plain strings.
    // Older entries with no bold headers produce a flat string array (unchanged).
    const changes = [];
    let currentGroup = null;
    for (const line of lines.slice(1)) {
      const t = line.trim();
      const groupMatch = t.match(/^\*\*(.+)\*\*$/);
      if (groupMatch) {
        currentGroup = { group: groupMatch[1], items: [] };
        changes.push(currentGroup);
      } else if (t.startsWith('- ')) {
        const text = t.slice(2).trim().replace(/`([^`]+)`/g, '$1');
        if (currentGroup) currentGroup.items.push(text);
        else changes.push(text);
      }
    }
    entries.push({ version, date, ...(title ? { title: title.trim() } : {}), changes });
  }
  return entries;
}

const changelog = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));

// Build invariant: top CHANGELOG.md entry must match package.json version (prod only).
if (mode.invariants) {
  if (!changelog.length || changelog[0].version !== appVersion) {
    const found = changelog[0]?.version ?? '(none)';
    console.error(
      `\nBuild invariant FAILED: CHANGELOG.md top entry is v${found} but package.json is v${appVersion}.\n` +
      `Add a ## [${appVersion}] — date — Title entry to the top of CHANGELOG.md before building.`
    );
    process.exit(1);
  }
}

const changelogJs = [
  '// Copyright (C) 2026 HidayahTech, LLC',
  '// @generated — do not edit directly. Source of truth: CHANGELOG.md (parsed by build.mjs).',
  '',
  `export const CURRENT_VERSION = '${appVersion}';`,
  '',
  `export const CHANGELOG = ${JSON.stringify(changelog, null, 2)};`,
  '',
].join('\n');
writeFileSync('src/lib/changelog.js', changelogJs, 'utf8');
console.log(`  ✓ Generated src/lib/changelog.js from CHANGELOG.md (${changelog.length} entries, v${appVersion})`);

// ── Bundle with esbuild (picks up the freshly generated changelog.js) ────────
const result = await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: mode.minify,
  sourcemap: mode.sourcemap,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode.nodeEnv),
  },
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const rawCss = readFileSync('src/styles/main.css', 'utf8');
const cssResult = await esbuild.transform(rawCss, { loader: 'css', minify: mode.minify });
const css = cssResult.code;
const html = readFileSync('src/index.html', 'utf8');
const buildId = appVersion;
const out = html
  .replace('<!-- BUILD_ID -->', buildId)
  .replace('<!-- APP_VERSION -->', appVersion)
  .replace(/<!-- APP_TITLE -->/g, appTitle)
  .replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);

mkdirSync(mode.dest, { recursive: true });
writeFileSync(`${mode.dest}/index.html`, out, 'utf8');
console.log(`Built ${mode.dest}/index.html (${(out.length / 1024).toFixed(1)} KB) [mode: ${modeKey}]`);

// ── Production-only: copy assets and enforce invariants ──────────────────────
if (mode.invariants) {
  copyFileSync('src/assets/og-image.png', `${mode.dest}/og-image.png`);

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
  // Bundle size ceiling: guards against accidental inclusion of large assets.
  const SIZE_LIMIT_BYTES = 600 * 1024;
  const actualBytes = Buffer.byteLength(out, 'utf8');
  if (actualBytes > SIZE_LIMIT_BYTES) {
    console.error(
      `\nBuild invariant FAILED: ${mode.dest}/index.html is ${(actualBytes / 1024).toFixed(1)} KB, ` +
      `which exceeds the ${SIZE_LIMIT_BYTES / 1024} KB ceiling (T5-2).\n` +
      `Investigate what was added; raise the ceiling only after deliberate review.`
    );
    invariantFailed = true;
  }

  if (invariantFailed) process.exit(1);
}
