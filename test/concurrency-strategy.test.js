import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcAdaptiveConcurrency,
  createProbeState,
  resolveProbe,
  capConcurrencyByMemory,
} from '../src/lib/concurrency-strategy.js';

describe('capConcurrencyByMemory', () => {
  const MB = 1024 * 1024;

  test('does not reduce concurrency when parts are small', () => {
    // 16 × 5 MiB = 80 MiB — well under 200 MiB cap
    assert.equal(capConcurrencyByMemory(16, 5 * MB, 200 * MB), 16);
  });

  test('reduces concurrency when part size × concurrency exceeds budget', () => {
    // 50 MiB parts, 200 MiB budget → max 4 concurrent
    assert.equal(capConcurrencyByMemory(16, 50 * MB, 200 * MB), 4);
  });

  test('never returns below 1', () => {
    // Even a 500 MiB part with a 200 MiB budget must allow at least 1 concurrent
    assert.equal(capConcurrencyByMemory(16, 500 * MB, 200 * MB), 1);
  });

  test('passes through concurrency unchanged when already under cap', () => {
    assert.equal(capConcurrencyByMemory(4, 5 * MB, 200 * MB), 4);
  });

  test('3 concurrent files share the budget — total stays within limit', () => {
    // 3 files, 200 MiB total → 66 MiB per file → floor(66/50) = 1 for 50 MiB parts
    const perFile = Math.floor(200 * MB / 3);
    const concPerFile = capConcurrencyByMemory(5, 50 * MB, perFile);
    assert.equal(concPerFile, 1);
    assert.ok(concPerFile * 50 * MB * 3 <= 200 * MB, 'total across 3 files must not exceed 200 MiB');
  });

  test('2 concurrent files share the budget', () => {
    // 2 files, 200 MiB total → 100 MiB per file → floor(100/50) = 2 for 50 MiB parts
    const perFile = Math.floor(200 * MB / 2);
    const concPerFile = capConcurrencyByMemory(5, 50 * MB, perFile);
    assert.equal(concPerFile, 2);
    assert.ok(concPerFile * 50 * MB * 2 <= 200 * MB, 'total across 2 files must not exceed 200 MiB');
  });
});

describe('calcAdaptiveConcurrency', () => {
  test('1 active file gets full budget as parts', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(1, 16);
    assert.equal(fileConcurrency, 1);
    assert.equal(partsPerFile, 16);
  });

  test('2 active files split budget evenly', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(2, 16);
    assert.equal(fileConcurrency, 2);
    assert.equal(partsPerFile, 8);
  });

  test('4 active files hit 16 total connections exactly', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(4, 16);
    assert.equal(fileConcurrency, 4);
    assert.equal(partsPerFile, 4);
  });

  test('8 active files floor partsPerFile at DEFAULT_PART_CONCURRENCY (4)', () => {
    // floor(16/8) = 2, but 4 is the floor
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(8, 16);
    assert.equal(fileConcurrency, 8);
    assert.equal(partsPerFile, 4);
  });

  test('more active files than budget caps fileConcurrency at budget', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(20, 16);
    assert.equal(fileConcurrency, 16);
    assert.equal(partsPerFile, 4);
  });

  test('0 active files treated as 1 (prevents division by zero)', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(0, 16);
    assert.equal(fileConcurrency, 1);
    assert.equal(partsPerFile, 16);
  });

  test('budget=1 always yields fileConcurrency=1, partsPerFile=4', () => {
    const { fileConcurrency, partsPerFile } = calcAdaptiveConcurrency(2, 1);
    assert.equal(fileConcurrency, 1);
    assert.equal(partsPerFile, 4); // floored at PART_CONCURRENCY
  });
});

describe('createProbeState', () => {
  test('initialises with correct baseline and candidate', () => {
    const s = createProbeState(4, 8);
    assert.equal(s.baseline, 4);
    assert.equal(s.candidate, 8);
    assert.equal(s.phase, 'baseline');
    assert.equal(s.winner, null);
    assert.equal(s.baselineBytes, 0);
    assert.equal(s.candidateBytes, 0);
  });
});

describe('resolveProbe', () => {
  test('picks candidate when >10% faster', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 1000; // 15 MB/s
    s.candidateBytes = 15_000_000; s.candidateMs = 833;  // ~18 MB/s (+20%)
    const r = resolveProbe(s);
    assert.equal(r.winner, 8);
  });

  test('picks baseline when candidate is within 10% threshold', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 1000; // 15 MB/s
    s.candidateBytes = 15_000_000; s.candidateMs = 926;  // ~16.2 MB/s (+8%)
    const r = resolveProbe(s);
    assert.equal(r.winner, 4);
  });

  test('picks baseline when candidate is slower', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 1000;
    s.candidateBytes = 15_000_000; s.candidateMs = 1200; // slower
    const r = resolveProbe(s);
    assert.equal(r.winner, 4);
  });

  test('includes baselineMbs and candidateMbs in result', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 10_000_000; s.baselineMs  = 1000;
    s.candidateBytes = 10_000_000; s.candidateMs = 800;
    const r = resolveProbe(s);
    assert.ok(typeof r.baselineMbs === 'number');
    assert.ok(typeof r.candidateMbs === 'number');
    assert.ok(r.candidateMbs > r.baselineMbs);
  });

  test('marks inconclusive and uses baseline when baselineMs is too short', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 2;   // 2ms — impossible speed
    s.candidateBytes = 15_000_000; s.candidateMs = 500;
    const r = resolveProbe(s);
    assert.equal(r.winner, 4, 'must fall back to baseline on inconclusive probe');
    assert.equal(r.inconclusive, true);
    assert.equal(r.baselineMbs, null);
    assert.equal(r.candidateMbs, null);
  });

  test('marks inconclusive when candidateMs is too short', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 500;
    s.candidateBytes = 15_000_000; s.candidateMs = 3;   // 3ms — impossible speed
    const r = resolveProbe(s);
    assert.equal(r.winner, 4, 'must fall back to baseline on inconclusive probe');
    assert.equal(r.inconclusive, true);
  });

  test('sets inconclusive=false on a valid measurement', () => {
    const s = createProbeState(4, 8);
    s.baselineBytes  = 15_000_000; s.baselineMs  = 1000;
    s.candidateBytes = 15_000_000; s.candidateMs = 800;
    const r = resolveProbe(s);
    assert.equal(r.inconclusive, false);
  });
});
