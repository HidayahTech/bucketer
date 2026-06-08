// Custom Node.js ESM loader that transforms .jsx files using esbuild.
//
// WHY THIS EXISTS: Node.js cannot parse JSX syntax natively. This loader intercepts
// .jsx imports and transforms them to plain ESM JavaScript using the same esbuild
// settings as the production build (automatic JSX, jsxImportSource: 'preact').
// No extra dependencies are needed — esbuild is already a devDependency.
//
// USAGE: node --loader ./test/helpers/jsx-loader.mjs --test test/components/*.test.jsx
//
// NOTE: --loader shows a deprecation warning on Node 20+ but remains functional.
// The alternative (node:module register API) requires Node 20.6+, which exceeds
// the project's >=18.0.0 minimum. Use --loader until the minimum is raised.

import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);

  const filePath = fileURLToPath(url);
  const source   = await readFile(filePath, 'utf8');

  const { code } = await transform(source, {
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: 'jsx',
    format: 'esm',
    sourcefile: filePath,
  });

  return { format: 'module', source: code, shortCircuit: true };
}
