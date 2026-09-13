// Copyright (C) 2026 HidayahTech, LLC
// The zip-assembler worker, inlined by build.mjs as a Blob URL (single-file build).
// The WORKER_SRC placeholder below is replaced at build time with the bundled
// worker IIFE source. Exactly one quoted occurrence of that sentinel text may
// exist in this file (the assignment) — build.mjs's substitution is a
// non-global replace targeting it specifically; a second quoted copy anywhere
// else (even in a comment) would survive substitution and ship in dist.
const WORKER_SRC = '__WORKER_SRC__';
let cachedUrl = null;
export function makeAssemblerWorker() {
  if (!cachedUrl) cachedUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  return new Worker(cachedUrl);
}
