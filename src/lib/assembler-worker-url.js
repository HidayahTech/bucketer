// Copyright (C) 2026 HidayahTech, LLC
// The zip-assembler worker, inlined by build.mjs as a Blob URL (single-file build).
// __WORKER_SRC__ is replaced at build time with the bundled worker IIFE source.
const WORKER_SRC = '__WORKER_SRC__';
let cachedUrl = null;
export function makeAssemblerWorker() {
  if (!cachedUrl) cachedUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  return new Worker(cachedUrl);
}
// A length check, not a literal comparison to the placeholder text: build.mjs's
// substitution is a non-global String.replace() that only rewrites the first
// occurrence of '__WORKER_SRC__' (the assignment above); a second literal copy
// here would survive substitution and remain in the built bundle forever,
// defeating the "no unreplaced placeholder in dist" build invariant/test.
export const workerInlined = () => WORKER_SRC.length > 100;
