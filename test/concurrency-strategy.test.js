import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcAdaptiveConcurrency,
  createProbeState,
  resolveProbe,
} from '../src/lib/concurrency-strategy.js';

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
});
