#!/usr/bin/env node
// Bundles src/main.jsx with esbuild and inlines the result into src/index.html,
// producing a single self-contained dist/index.html (required for file:// Chrome compat, §4.3).

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

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
  loader: { '.png': 'dataurl' },
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const css = readFileSync('src/styles/main.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8');
const buildId = new Date().toISOString(); // embedded for update checks
// Use a function to avoid $ special replacement patterns in the JS/CSS content
const out = html
  .replace('<!-- BUILD_ID -->', buildId)
  .replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', out, 'utf8');
console.log(`Built dist/index.html (${(out.length / 1024).toFixed(1)} KB)`);

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
