#!/usr/bin/env node
// Dev server: builds in dev mode, then serves dist/ from http://localhost:3000
// Run with: npm run serve

import { execFileSync }                    from 'child_process';
import { readFileSync, existsSync }        from 'fs';
import { createServer }                    from 'http';
import { fileURLToPath }                   from 'url';
import { dirname, join }                   from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

// Delegate the build to build.mjs in dev mode — single source of build config.
execFileSync(process.execPath, [join(__dirname, 'build.mjs'), '--mode=dev'], {
  stdio: 'inherit',
  cwd:   __dirname,
});

const html = readFileSync(join(__dirname, 'dist', 'index.html'), 'utf8');

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico' && existsSync(join(__dirname, 'dist', 'favicon.ico'))) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.end(readFileSync(join(__dirname, 'dist', 'favicon.ico')));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nServing at http://localhost:${PORT}\nPress Ctrl+C to stop.\n`);
});
