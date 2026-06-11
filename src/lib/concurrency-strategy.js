// Copyright (C) 2026 HidayahTech, LLC
// Pure functions for adaptive upload concurrency.
// No side effects, no DOM, no S3 dependencies — safe to unit-test in Node.
import { ADAPTIVE_CONNECTION_BUDGET, PART_CONCURRENCY, MAX_ADAPTIVE_MEMORY_BYTES } from './constants.js';

// Returns the recommended concurrency split for the current number of active uploads.
// fileConcurrency: how many files the queue should allow to run simultaneously.
// partsPerFile: how many parts each active file should upload concurrently.
//
// Design: partsPerFile = budget / activeFiles, floored at PART_CONCURRENCY (4).
// The 16-connection total is hit precisely when activeFiles ≤ 4; above that the
// floor keeps part concurrency from dropping below the useful minimum.
export function calcAdaptiveConcurrency(activeFiles, budget = ADAPTIVE_CONNECTION_BUDGET) {
  const files = Math.max(1, activeFiles);
  const partsPerFile = Math.max(PART_CONCURRENCY, Math.floor(budget / files));
  const fileConcurrency = Math.min(files, budget);
  return { fileConcurrency, partsPerFile };
}

// Creates an empty probe-state object for a large-file one-shot calibration.
// baseline and candidate are part-concurrency values to compare.
export function createProbeState(baseline, candidate) {
  return {
    phase: 'baseline',
    baseline,
    candidate,
    baselineBytes: 0,
    baselineMs: 0,
    candidateBytes: 0,
    candidateMs: 0,
    winner: null,
  };
}

// Clamps concurrency so that (concurrency × partSizeBytes) never exceeds maxBytes.
// Applied in adaptive mode to prevent very large part sizes (auto-raised by
// calcPartSize for huge files) from causing runaway ArrayBuffer memory usage.
export function capConcurrencyByMemory(concurrency, partSizeBytes, maxBytes = MAX_ADAPTIVE_MEMORY_BYTES) {
  return Math.min(concurrency, Math.max(1, Math.floor(maxBytes / partSizeBytes)));
}

// Minimum wall-clock time (ms) for a 3-part probe phase to be considered valid.
// 3 parts × 5 MiB = 15 MiB. 10 ms → ~12 Gbps, which exceeds any real upload link.
// If either phase completes faster than this, the measurement is from a warm cache
// or pre-established connection — not representative of steady-state throughput.
const PROBE_MIN_MS = 10;

// Resolves a completed probe by comparing throughput of the two phases.
// Candidate wins only if it is >10% faster — the threshold filters network jitter.
// Returns the state enriched with winner, baselineMbs, candidateMbs, and inconclusive.
// inconclusive is true when either phase duration was too short to be meaningful.
export function resolveProbe(state) {
  if (state.baselineMs < PROBE_MIN_MS || state.candidateMs < PROBE_MIN_MS) {
    return {
      ...state,
      winner:       state.baseline,
      baselineMbs:  null,
      candidateMbs: null,
      inconclusive: true,
    };
  }
  const baselineMbs  = state.baselineBytes / state.baselineMs;
  const candidateMbs = state.candidateBytes / state.candidateMs;
  const winner = candidateMbs > baselineMbs * 1.1 ? state.candidate : state.baseline;
  return {
    ...state,
    winner,
    baselineMbs:  Math.round(baselineMbs  * 1000) / 1000,
    candidateMbs: Math.round(candidateMbs * 1000) / 1000,
    inconclusive: false,
  };
}
