#!/usr/bin/env node
// Dev server: builds in dev mode, then serves dist/ from http://localhost:3000
// Run with: npm run serve

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createServer } from 'http';
import { extname } from 'path';

const PORT = process.env.PORT || 3000;

// Build first
console.log('Building...');
const result = await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: false,
  sourcemap: 'inline',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info',
});

const js  = result.outputFiles[0].text;
const css = readFileSync('src/styles/main.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8');
const out  = html.replace('<!-- BUNDLE_PLACEHOLDER -->', () => `<style>${css}</style><script>${js}</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', out, 'utf8');
console.log(`Built dist/index.html (${(out.length / 1024).toFixed(1)} KB)`);

// Serve
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico' && existsSync('dist/favicon.ico')) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.end(readFileSync('dist/favicon.ico'));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(out);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nServing at http://localhost:${PORT}\nPress Ctrl+C to stop.\n`);
});
