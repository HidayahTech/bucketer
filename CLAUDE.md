# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Setup

```bash
npm install
npm run build   # → dist/index.html
npm run serve   # dev build + localhost:3000
```
