# Mobile file-table actions reflow (#49) — design

Date: 2026-07-11 · Slice 2 of the mobile-responsive work (slice 1 = v1.37.2 responsive shell, BUG-039).

## Problem

On a phone viewport (≤640px) the file-table actions column (6 buttons per file
row: ℹ ✎ ↓ ⎘ ↪ ✕; 3 per folder row) runs past the right edge, so per-row
actions are unreachable. Batch actions work (slice 1); per-row do not.

## Approach (chosen: CSS-only reflow)

Options considered: (a) CSS-only reflow, (b) per-row `⋯` overflow menu,
(c) stacked card layout. Chosen: **(a)** — no new components or state, e2e
selectors unchanged, desktop untouched; (b) deferred as possible v2.0 polish,
(c) is the v2.0 full mobile refresh.

All rules live in the existing `@media (max-width: 640px)` block in
`src/styles/main.css`:

1. **Hide date columns**: `display: none` on `.col-modified` and
   `.col-file-modified` (both `th` and `td`). Name and Size remain.
2. **Actions wrap**: the buttons sit in a new `<span class="row-actions">`
   wrapper inside the cell (inline on desktop — layout unchanged). On mobile
   the wrapper becomes `display: flex; flex-wrap: wrap` and the cell gets
   `min-width: 9.5rem`, so buttons wrap ~3–4 per line. The wrapper is
   required: JSX emits the buttons with no whitespace between them, so
   `white-space: normal` alone provides no soft-wrap points, and
   `display: flex` on the `td` itself drops it out of table-cell layout
   (the anonymous cell collapses to one button wide and the actions stack
   vertically — tried and rejected).
3. **Tap targets**: `.file-table .btn-sm { padding: .5rem .55rem; }`
   (~38px targets, mobile only).
4. **Copy-link/share popover**: anchored (`right: 0`, 230px+ min-width,
   content-driven up to ~445px) it overflows both edges of a 393px phone.
   On mobile it is re-positioned `fixed` as a lower-viewport sheet
   (`left/right: 3vw; bottom: 8vh`); click-outside close is unaffected.

One further JSX touch: `SortTh` gains an optional `colClass` prop appended to
its class list; the `Modified` call site passes `colClass="col-modified"` so
the header cell is hideable by class (the `File Modified` th already carries
its class). Desktop rendering otherwise unchanged.

## Acceptance / tests

- New e2e `test/e2e/browser/issue-49-mobile-actions.test.mjs` (Pixel 5
  context, `issue-3-mobile` pattern): no horizontal page overflow with rows
  present; every file-row and folder-row action button has a bounding box
  inside the viewport; per-row delete works end-to-end (verified against
  mock S3) **without `{ force: true }`** — force-clicks bypass Playwright's
  actionability checks, which is how the pre-fix matrix stayed green while
  the buttons were off-screen; copy-link popover opens within viewport
  bounds.
- Component test: `SortTh` `colClass` passthrough (browser-internals).
- Existing 35-spec e2e matrix stays green on all profiles; desktop unchanged.

## Release

Version bump level confirmed with the operator at release time
(1.38.0 minor vs 1.37.3 patch). CHANGELOG entry; commit `Addresses #49`.
