#!/usr/bin/env node
// Bundles src/main.jsx with esbuild and inlines the result into src/index.html,
// producing a single self-contained dist/index.html (required for file:// Chrome compat, §4.3).

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const dev = process.argv.includes('--dev');

const result = await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
  // Alias preact/compat so any React-expecting code resolves correctly
  alias: {
    'react': 'preact/compat',
    'react-dom': 'preact/compat',
  },
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const css = readFileSync('src/styles/main.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8');
// Use a function to avoid $ special replacement patterns in the JS/CSS content
const out = html
  .replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', out, 'utf8');
console.log(`Built dist/index.html (${(out.length / 1024).toFixed(1)} KB)`);
