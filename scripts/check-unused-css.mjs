#!/usr/bin/env node
// Report-only unused-CSS check for the single hand-authored src/styles/main.css.
//
// ADVISORY, never blocking (exit 0 always): it surfaces selectors that appear unused so a
// human can decide whether to prune them. It is NOT wired into build.mjs — the byte-for-byte
// build-reproducibility invariant must never depend on a class-usage heuristic that could
// misfire and strip a class the app composes dynamically at runtime.
//
// Dynamic class names are built by template literal across the app (e.g. `toast-${type}`,
// `logo-phase-${phase}`), so the static token never appears literally in source. Those
// prefix families are safelisted below so they are not falsely reported. Extend the list if
// a new dynamic-class prefix is added — a missing prefix only costs a false "unused" line in
// this advisory report, never a runtime break.
import { PurgeCSS } from 'purgecss';

const DYNAMIC_PREFIXES = [
  /^toast-/,
  /^logo-phase-/,
  /^status-badge/,
  /^upload-item-status/,
  /^col-sort/,
  /^allow-storage-/,
  /^discard-/,
  /^keeper-/,
  /^resume-/,
  /^sep-/,
  /^storage-reason-/,
  /^verified-/,
  /^verify-/,
];

const [result] = await new PurgeCSS().purge({
  content: ['src/**/*.{js,jsx}', 'src/index.html'],
  css: ['src/styles/main.css'],
  safelist: { greedy: DYNAMIC_PREFIXES },
  rejected: true,
});

const rejected = result?.rejected ?? [];
if (rejected.length === 0) {
  console.log('check-unused-css: no unused selectors in src/styles/main.css.');
} else {
  console.log(`check-unused-css (advisory): ${rejected.length} selector(s) appear unused in src/styles/main.css:`);
  for (const sel of rejected) console.log('  ' + sel);
  console.log('\nVerify each is not composed dynamically before removing; add a prefix to DYNAMIC_PREFIXES if so.');
}
process.exit(0);
