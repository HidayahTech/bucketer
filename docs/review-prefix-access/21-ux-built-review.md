# UX review of the BUILT prefix-access surfaces

**Lane:** ux-review (post-build) · **Date:** 2026-09-16 · **Tree:**
`/home/basilgohar/dev/bucketer/.claude-scratch/runs/prefix-access/wt`, branch
`feature/prefix-access` @ `8a82b94`, perf bundle built from that source (the bundle self-labels
v1.62.3 — the version bump has not happened yet).
**Engine:** chromium (the only engine that launches on this host) — so every claim below is
chromium-only; nothing here is a cross-engine claim.
**Predecessor:** my pre-implementation review `docs/review-prefix-access/20-ux-review.md`
(F1–F8). The design built is `docs/superpowers/specs/2026-09-16-prefix-access-design.md`
(D1–D6), including the EM's declared departures from my recommendation (no selection-bar
item; two-line failed-screen title; no inline setup-guide button in the masked block;
key-ID as a session checkbox).

**User assumed** — unchanged from the pre-review, and still an assumption, not a card:
technically literate, not a developer, connects a few times a month (so nothing here is
muscle memory), desktop mostly, phone sometimes.

---

## Flow walked

Instruments (mine, adapted from the run's `e1-shots.mjs` / `l1-shots.mjs`):

- `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux-built/walk.mjs`
- `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux-built/probe.mjs` (tap
  targets, Escape behaviour)
- `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux-built/probe2.mjs`
  (trigger contrast, menu anchoring)

All captures are **viewport**, not `fullPage`, in
`/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux-built/shots/`, desktop
1280×720 and Pixel 5.

1. **Failed connect, no Base folder** (mock `scopePrefix: 'clients/acme/'`), both viewports →
   clicked **Set base folder** → typed the folder → connected.
2. **Quick-switch** to a second saved connection whose key cannot list that bucket
   (the `prefix-scope.test.mjs` two-record setup, driven by hand).
3. **CORS-masked shape** (`corsOnErrors: false` + MinIO provider override) → **Run
   diagnostics**, both viewports.
4. **Bad-credential 403** (`faults: [{ op:'ListObjectsV2', status:403,
   code:'SignatureDoesNotMatch' }]`).
5. **Connected, five levels deep** at `clients/acme/projects/2026/q3-deliverables/final-assets/`:
   breadcrumb 🔗 (size, keyboard focus, activation), header **Copy link** menu (labels,
   truncation, checkbox, toasts, clipboard read), per-file `⎘` popover. Both viewports.
6. **Recipient**: pasted the copied URL's hash into a fresh context, read the banner, entered
   a secret, connected.

Measured facts (console, verbatim, trimmed):

```
[E desktop]  error block {vh 720, scrollY 689, top 225, bottom 496, inView true, focusedSelf true}
[E pixel5]   error block {vh 727, scrollY 732, top 199, bottom 527, inView true, focusedSelf true}
[E both]     after "Set base folder": active INPUT#cred-baseprefix, rect in view
[QS]         title "Couldn't open other-bucket", block in view and focused
[C desktop]  masked block in view+focused; diagnostics verdict = two-cause text, NOT bold
[B]          "Connection failed / x / The key ID or secret key is wrong for this bucket."  (no scope hint)
[L both]     crumb button 32×32, focus ring on Tab, Enter copies
[L both]     toast (folder): "Link copied — opens at clients/acme/projects/2026/q3-deliverables/final-assets/"
[L both]     toast (key-ID on): "…final-assets/ Includes your access key ID. The recipient still needs the secret key."
             computed .toast white-space: normal   ← the \n is collapsed
[L pixel5]   menu items h=25, modifier label h=27 (input 13×13), menu sheet at y=541 while trigger is at y=62
[L both]     clipboard: …&basePrefix=clients%2Facme%2F&keyId=scoped-key&prefix=clients%2Facme%2Fprojects%2F2026%2Fq3-deliverables%2Ffinal-assets%2F
[R both]     banner: "Pre-filled from the link: endpoint, bucket, base folder clients/acme/, key ID, region, provider — enter your Secret Key to connect."
[R both]     after connect, breadcrumb: acme / projects / 2026 / q3-deliverables / final-assets 🔗
[probe]      header menu still open after Escape (count 1)
[probe2]     trigger while open: color rgb(255,255,255) on bg rgb(241,243,245)  → ≈1.1:1
```

**What works, stated plainly, because it is the bulk of the walk:** the failure is now
impossible to miss on both viewports; **Set base folder** lands the caret in the field on
both; recovery is one field and one click; the quick-switch failure names the bucket; the
bad-credential case says the plain thing and no longer offers a folder hypothesis; the
diagnostics verdict no longer asserts a cause it cannot establish and no longer carries the
bold; the deep-folder link round-trips end to end — copied at five levels down, opened in a
fresh context, recipient lands exactly there. The two link families now read differently at
both points of choice ("Open in Bucketer … the recipient needs their own secret key" vs
"Share this file — anyone with the link can open it"). That is the whole of F1, F2, F3, F6
and F7's substance.

---

## Findings — ordered by user cost

### 1 (medium) — The only warning that a link carries your access key ID reads as part of the folder path

**Where:** `shots/L-desktop-6-folder-copied-toast.png`,
`shots/L-pixel5-6-folder-copied-toast.png`; `src/lib/connection-link.js`
(`linkCopiedMessage` joins with `\n`) vs `src/styles/main.css:1174` (`.toast` has no
`white-space` rule → computed `normal`).

**What the user experiences:** with **Include my access key ID** checked, the toast is
designed (D2) as two lines. It renders as one run-on paragraph:
*"Link copied — opens at clients/acme/projects/2026/q3-deliverables/final-assets/ Includes
your access key ID. The recipient still needs the secret key."* At a glance the sentence
looks like it continues the path. This toast is the *only* place the app tells the sender
that the link they just put on the clipboard names their key ID — the breadcrumb button
(finding 3) has no other disclosure at all.

**Why it fails:** *least surprise* + *error/feedback states are interfaces* — a disclosure the
user cannot visually separate from a file path is not a disclosure. The design specified a
second line; the CSS silently discards it.

**Smallest fix:** `.toast { white-space: pre-line; }` (one declaration; the store already
emits `\n`).

---

### 2 (medium) — The masked-shape block still ends by telling the user to go rewrite CORS

**Where:** `shots/C-desktop-1-masked-error.png`, `shots/C-desktop-2-diagnostics.png`,
`shots/C-pixel5-2-diagnostics.png`; `src/components/ErrorBlock.jsx:179` (`{guidance && …}`).

**What the user experiences:** the new two-cause block is correct and cause 2 already says
*"Your bucket's CORS rules don't allow this page. See the setup guide under the form."* Then
the honest verdict says *"both causes above are still open. Try the base folder first; it
costs nothing."* And then, as the last sentence on the screen, the old generic guidance:
*"Check your endpoint URL, bucket name, and credentials. If this looks like a CORS error,
ensure CORS is configured on your bucket."* Recency does the rest: the last instruction the
user reads is the expensive, possibly destructive one that the paragraph above just said is
unproven. This is F7 fixed on the readable-403 shape (verified: the tail is gone there) and
left standing on the masked shape, which is the shape where it does the damage.

**Why it fails:** *least confusion* — the screen ranks its hypotheses and then un-ranks itself
in its own last line.

**Smallest fix:** suppress `guidance` when `scopeHint === 'unset-masked'` (cause 2 already
carries the CORS instruction and the setup-guide pointer). One condition, no new copy.

---

### 3 (medium) — The breadcrumb 🔗 inherits a hidden setting made on a different control

**Where:** `src/components/Browser.jsx:1168-1172` (`copyConnectionLink({ …, includeKeyId:
getIncludeKeyId() })`), `src/lib/connection-link.js` (sessionStorage
`s3b_share_include_keyid`); `shots/L-desktop-1-deep-breadcrumb.png` (the button carries no
state), `shots/L-desktop-5-menu-keyid-checked.png` (where the state was set).

**What the user experiences:** they tick **Include my access key ID** once in the header menu.
Any later one-click 🔗 on the breadcrumb — a different control, possibly minutes later, with
no checkbox, no label change, no tooltip change — also embeds the key ID. The design intends
this ("one choice for the session, shared by both surfaces") and the toast discloses it; but
per finding 1 that disclosure is currently a run-on tail, and it arrives *after* the clipboard
is already written.

**Why it fails:** *least surprise* — a one-click control whose payload is governed by an
invisible switch set on another control.

**Smallest fix:** fix finding 1 first (that restores the intended disclosure), and when the
modifier is on, extend the button's `title`/`aria-label` to *"Copy a link to this folder
(includes your access key ID)"*. No behaviour change.

---

### 4 (low, pre-existing but now load-bearing) — The header "Copy link" trigger is invisible while its menu is open

**Where:** `shots/L-pixel5-4-header-menu.png` (the trigger reads as a blank pill);
`src/components/ShareLinkMenu.jsx:55` inline `style={{ color: '#fff' }}` against
`.btn-ghost`'s active/hover background. Measured: `rgb(255,255,255)` on `rgb(241,243,245)`
≈ **1.1:1**, far under WCAG AA 4.5:1.

**What the user experiences:** on mobile the menu is deliberately a bottom sheet
(`main.css:1231-1236`, with a provenance comment — a real pattern, not happenstance), so it
opens ~480 px away from the control that opened it (trigger at y 62, sheet at y 541). The
only thing tying sheet to control is the trigger's pressed state — and in that state its
label vanishes. On desktop the same thing happens, less consequentially.

**Why it fails:** *accessibility baseline* (1.4.3 Contrast) and *least confusion* (where am I,
what opened this).

**Smallest fix:** drop the hard-coded `color: '#fff'` for a class that keeps dark-header white
only while the background is dark, so the hover/open background gets the normal text colour.

---

### 5 (low) — Escape does not close the header menu, and focus never enters it

**Where:** measured — after opening the menu and pressing Escape, `.share-link-menu` count is
still 1 (`probe.mjs` output); `src/components/ShareLinkMenu.jsx:25-34` listens only for
`mousedown` outside. `shots/L-desktop-4-header-menu.png`.

**What the user experiences:** a keyboard user opens the menu, finds no way to dismiss it
without tabbing through it or clicking elsewhere. Focus stays on the trigger when the menu
opens, so a screen-reader user is given no signal that a checkbox and two actions just
appeared.

**Why it fails:** *accessibility baseline* (2.1.1 Keyboard, and the expected dialog/menu
convention). **Tagged:** this matches the pre-existing `CopyLinkPopover`, which also has no
Escape handler — so it is a consistency-preserving omission, not a regression. I raise it
because the menu now contains a *modifier* the user may want to back out of.

**Smallest fix:** a `keydown` Escape handler alongside the existing `mousedown` one: close and
return focus to the trigger.

---

### 6 (low) — On Pixel 5 the two menu actions are 25 px tall and differ only by their tail

**Where:** measured `probe.mjs`: menu buttons `h=25`, modifier label `h=27` (checkbox itself
13×13, but the whole `<label>` is the target); `shots/L-pixel5-4-header-menu.png`.

**What the user experiences:** two stacked rows — *"Open in Bucketer — this folder
(…/final-assets/)"* and *"Open in Bucketer — top of this connection"* — that share their first
four words, sit 25 px apart, and produce materially different links. The new breadcrumb button
was built to 32 px (D3); these were not.

**Why it fails:** *prevent accidents* — 25 px clears WCAG 2.2 AA 2.5.8 (24×24) and nothing
more; the distinguishing text is at the end of the line where the eye lands last.

**Smallest fix:** `min-height: 32px` on `.share-link-menu button` and `.share-link-modifier`
(the popover already has room).

---

### 7 (nit) — On touch, the truncated folder label's full value is unreachable before the click

**Where:** `shots/L-pixel5-4-header-menu.png` — the label reads `…/final-assets/`; the full
path lives in `title="Opens at clients/acme/projects/2026/q3-deliverables/final-assets/"`,
which a phone cannot hover.

**What the user experiences:** from a deep path the label shows only the leaf, so before
clicking they cannot confirm *which* `final-assets/` travels. The toast names the full path
immediately after, which is why this is a nit and not a finding against D2's "payload visible
before the click".

**Smallest fix:** let the label wrap to two lines under 640 px instead of truncating.

---

### 8 (nit) — The recipient's banner names the base folder but not the folder the link opens at

**Where:** `shots/R-desktop-1-prefill-banner.png`, `shots/R-pixel5-1-prefill-banner.png`.
Banner: *"Pre-filled from the link: endpoint, bucket, base folder clients/acme/, key ID,
region, provider — enter your Secret Key to connect."*

**What the user experiences:** the banner is a clear improvement and does the S2 job. But the
one thing the sender meant by the link — *this folder* — is the one thing it does not
enumerate; the recipient learns where they landed only after connecting (verified: they do
land in `final-assets/`). "base folder" is also app jargon for someone who has never used
Bucketer.

**Smallest fix:** append `, folder projects/2026/q3-deliverables/final-assets/` when `prefix`
is present.

---

### 9 (nit) — The whole hypothesis block is danger-red body text

**Where:** `shots/E-desktop-1-failed.png`, `shots/C-desktop-1-masked-error.png`;
`main.css:516-520` (`.error-block { color: var(--text-danger) }`). Contrast measured as
adequate: `#c92a2a` on `#fff5f5` ≈ 6.4:1, AA pass.

**What the user experiences:** six to ten lines of calm explanatory prose — including the
instructions for fixing the problem — rendered in alarm red on pink. It is legible; it is not
*readable*, and the bolded phrases inside it gain little because everything around them is
already shouting. This is the residue of F7: the ranking is fixed, the typographic emphasis
is not.

**Smallest fix:** give `.scope-hint` the normal body colour (the block's border and title
already carry the alarm).

---

### 10 (nit) — Clicking "Run diagnostics" drops focus to `<body>`

**Where:** measured after the click: `active: "BODY"`, `focusedWithin: false`
(`shots/C-desktop-2-diagnostics.png`). The button is replaced by its results, so the focused
element disappears.

**What the user experiences:** a keyboard user loses their place mid-block and must tab from
the top of the document. The block is `role="alert"`, so the new content is probably
announced — **tagged assumption: I did not test with a screen reader**, only measured focus.

**Smallest fix:** move focus to the results container when diagnostics resolve.

---

## F1–F8 disposition

| # | Original finding | Disposition | Evidence |
|---|---|---|---|
| F1 | Failure invisible: error block below the fold, no focus, no scroll | **Fixed** | `E-desktop-1-failed.png`, `E-pixel5-1-failed.png`; measured `inView true`, `focusedSelf true` on both viewports (was `top 914/931`, `scrollY 0`, `activeEl BODY`). "Set base folder" lands the caret in `#cred-baseprefix` with its rect in view on both. |
| F2 | Diagnostics asserts a cause it cannot establish, in bold, below the cheaper one | **Fixed** | `C-desktop-2-diagnostics.png`: the folder cause is now cause 1 of a first-class block *above* the button; the verdict reads "…can't tell a CORS block apart from a denial your provider sent without CORS headers — so both causes above are still open. Try the base folder first" and is rendered unbolded (`ErrorBlock.jsx:166-168`). |
| F3 | Header "Copy link" silently drops the folder | **Fixed** | Clipboard read from five levels deep contains `&prefix=clients%2Facme%2Fprojects%2F2026%2Fq3-deliverables%2Ffinal-assets%2F`; recipient context opened on that hash lands in `final-assets/` (`R-desktop-2-after-connect.png`). |
| F4 | The two link families are indistinguishable at the point of choice | **Fixed** | `L-desktop-4-header-menu.png` ("Open in Bucketer …", "The recipient needs their own secret key. It is never included.") vs `L-desktop-7-file-popover.png` ("Share this file — anyone with the link can open it", "No sign-in needed — treat it like a password."). Glyphs stay distinct: breadcrumb 🔗 vs row `⎘`. |
| F5 | Folders have no link affordance; the mobile row has no space for one | **Fixed as designed** (breadcrumb, not rows) | `L-desktop-1-deep-breadcrumb.png`, `L-pixel5-1-deep-breadcrumb.png`: 32×32 button beside the crumbs, folder rows untouched (still ⤓ ✎ ↪ ✕). The selection-bar variant is the EM's declared L2 deferral; nothing in the walk made me want it back — navigating into a folder is one click and the breadcrumb is right there. |
| F6 | Quick-switch failure reads as a sign-out | **Partially — as designed** | `QS-desktop-1-switch-failed.png`: title is "Couldn't open other-bucket", so the tab→failure causality is now stated. The larger point (a failed switch still destroys the previous view and drops to the splash) is explicitly out of scope per D4; I still consider it the right later fix. |
| F7 | Three competing red paragraphs; the last repeats CORS | **Partially** | Fixed on the readable-403 shape — the generic CORS tail is gone (`E-desktop-1-failed.png`, error text ends at "…wrong for this bucket"). Still present on the masked shape, as the last line, after the honest verdict → finding 2. Typographic flatness remains → finding 9. |
| F8 | Breadcrumb crumbs not keyboard-operable; the new control must not copy that pattern | **Fixed for the new control; crumbs unchanged (as scoped)** | `L-desktop-2-crumb-focus-ring.png`: reached by Tab, visible 2px focus ring (`main.css:263`), activates on Enter, real `<button type="button">` with `aria-label="Copy a link to this folder"` (`Breadcrumb.jsx:46-57`). The crumb `<span onClick>` themselves are still not keyboard-operable — unchanged, and still worth its own issue. |

---

## Questions for real users

1. **(carried, unanswered) Which wire shape does real B2 produce for a prefix-restricted key
   listing the root?** Still the P1 probe. The built copy is correct under either, so this is
   not a blocker — but the design's harness-fidelity statement must ship with it.
2. **Does a non-developer map B2's "Name Prefix" onto "Base folder"?** The copy now names B2's
   term explicitly, which is the right hedge; one real observation would settle whether the
   sentence is read at all.
3. **Does "Open in Bucketer" read as "they need their own key"?** The pairing is now stated at
   both points of choice. Whether a recipient who receives one understands *why* they are
   looking at a nine-field form is still untested — the banner helps, and finding 8 would help
   more.
4. **Does anyone notice the key-ID modifier is sticky?** Finding 3 is a design property, not a
   defect; whether it surprises people in practice is a question for a human, not for me.
5. **(tagged assumption)** Finding 10's screen-reader behaviour is inferred from `role="alert"`,
   not observed. Someone with NVDA/VoiceOver should confirm the diagnostics results are
   announced.

---

## Verdict

**ready-with-nits.**

Against *"would a first-time user complete this without help?"* — on both flows, **yes**, which
is a change of answer from my pre-implementation review. The prefix-restricted user now sees
the failure, is told the likely cause in their own terms, and has the fix one button away on
both viewports; the sharing user can copy a link to the folder they are standing in and the
recipient lands there.

Nothing here blocks the merge. The one I would fix before shipping is **finding 1** — a
one-declaration CSS change that restores the only disclosure the app makes about a link
carrying an access key ID — and I would take **finding 2** with it, since it is one condition
and it removes the screen's self-contradiction on the exact shape that motivated the work.
Findings 3–10 are genuine but small, and several are pre-existing patterns this change merely
stands next to.
