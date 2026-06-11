// Copyright (C) 2026 HidayahTech, LLC
// Pure functions for adaptive upload concurrency.
// No side effects, no DOM, no S3 dependencies — safe to unit-test in Node.
import { ADAPTIVE_CONNECTION_BUDGET, PART_CONCURRENCY } from './constants.js';

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

// Resolves a completed probe by comparing throughput of the two phases.
// Candidate wins only if it is >10% faster — the threshold filters network jitter.
// Returns the state enriched with winner, baselineMbs, and candidateMbs.
export function resolveProbe(state) {
  const baselineMbs  = state.baselineBytes / state.baselineMs;
  const candidateMbs = state.candidateBytes / state.candidateMs;
  const winner = candidateMbs > baselineMbs * 1.1 ? state.candidate : state.baseline;
  return {
    ...state,
    winner,
    baselineMbs:  Math.round(baselineMbs  * 1000) / 1000,
    candidateMbs: Math.round(candidateMbs * 1000) / 1000,
  };
}
