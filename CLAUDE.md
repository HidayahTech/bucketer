# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bucketer — a browser-based frontend for uploading, downloading, and managing objects in S3-compatible buckets. Hosted on GitLab at `https://gitlab.com/hidayahtech/bucketer`.

Built with Preact + esbuild. The build pipeline produces a single self-contained `dist/index.html` with all JS and CSS inlined. See README.md for full build and deployment docs.

## Workflow

Always ask for confirmation before committing or pushing.

Never include `@anthropic-ai/claude-code` in commits or pushes. It is a local development tool only and must never be deployed. If `package.json` or `package-lock.json` show changes to that package, exclude those files from the commit.

## Setup

```bash
npm install
npm run build   # → dist/index.html
npm run serve   # dev build + localhost:3000
```
