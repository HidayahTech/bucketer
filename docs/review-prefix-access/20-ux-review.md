# UX review — prefix access (folder links + prefix-restricted key connect failure)

**Lane:** ux-review · **Date:** 2026-09-16 · **Tree:** `main` @ `0b24aea` (v1.62.3; harness
served the committed bundle, which self-labels v1.62.2 — the surfaces reviewed are unchanged
between the two).
**Input contract:** `docs/review-prefix-access/00-facts.md`. I verified every claim I build a
finding on, in a running instance.

**User assumed for this review** (no End-User Proxy card exists for bucketer; per the task
brief): technically literate, not a developer; was handed an S3 key or made a B2 application
key; connects a few times a month, so nothing here is muscle memory; desktop mostly, phone
sometimes. **Grounded:** the operator (an experienced engineer, product owner) hit both
problems on real Backblaze B2 and reported *"login fails without any explanation or reason
why"* and *"no way to share a link to a specific path"*. If the author of the product cannot
recover unaided, the assumed user has no chance — so I treat the operator's experience as the
floor, not the ceiling.

---

## Flow walked

Instrument: `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux/walk.mjs`
(adapted from the panel's capture script; e2e mock S3 with `scopePrefix: 'clients/acme/'`,
committed `dist/index.html`, chromium — the only engine that launches on this host).
Screenshots in `/home/basilgohar/dev/bucketer/.claude-scratch/prefix-access/ux/shots/`.
**These are viewport captures, not `fullPage`** — the existing panel shots in
`…/prefix-access/shots/` are full-page, which is why they make the failure look visible when
it is not.

1. **Goal A — connect with a folder-restricted key, no Base folder.** Fill endpoint, bucket,
   key ID, secret → **Connect**. Desktop 1280×720 and Pixel 5.
   (`A-403-desktop-viewport-after-connect.png`, `A-403-mobileP5-viewport-after-connect.png`)
2. **Goal A, the CORS-masked wire shape.** Same flow with the list request aborted at the
   network layer so the SDK raises `TypeError: Failed to fetch` while every other probe still
   succeeds — the shape B2 produces if its 403 carries no `Access-Control-Allow-Origin`.
   Then I clicked **Run diagnostics** as the user would.
   (`B-corsmasked-desktop-0-error.png`, `B-corsmasked-desktop-1-diagnostics.png`)
3. **Recovery.** Typed `clients/acme/` into Base folder, reconnected → listing appears.
4. **Goal B — share a link to a folder.** Connected with the floor set, navigated into
   `sub/`, opened the header **Copy link** menu, clicked *Connection only*, and read the
   actual clipboard text. (`C-copylink-0-after-copy-toast.png`, console output below.)
5. **The other link model.** Opened a file row's `⎘` popover for contrast.
   (`C-copylink-1-file-copylink-popover.png`)
6. **Mobile folder rows.** Pixel 5 listing of `clients/`, measured every row-action button.
   (`D-mobile-rows-0-viewport.png`, plus the panel's `folder-rows-mobile-0-listing.png`)

Measured facts from the walk (console, verbatim):

```
[A desktop]  vh 720, scrollY 0, error {top 914, bottom 1148, inView false}, activeEl BODY
[A mobileP5] vh 727, scrollY 0, error {top 931, bottom 1260, inView false}, activeEl BODY
[C] address bar in subfolder: …/#prefix=clients%2Facme%2Fsub%2F
[C] clipboard from header Copy link:
    …/#endpoint=…&bucket=test-bucket&provider=generic&region=us-east-1&basePrefix=clients%2Facme%2F
[D] row action button sizes: ⤓ 29×32, ✎ 29×31, ↪ 29×31, ✕ 29×31  (×2 rows)
```

---

## Findings — ordered by user cost

### F1 (critical) — On failure, nothing visible changes. The explanation is below the fold on every viewport.

**Where:** `A-403-desktop-viewport-after-connect.png`, `A-403-mobileP5-viewport-after-connect.png`;
render at `src/components/App.jsx:1627-1636`.

**What the user experiences:** they press **Connect** and the page appears not to react. The
error block is at `top: 914px` in a 720px-tall desktop viewport and `top: 931px` in a 727px
Pixel 5 viewport, with `scrollY: 0` — it is off-screen in *both*, and the page does not
scroll, does not move focus (`document.activeElement` is still `BODY`), and the button does
not change state. The only in-viewport signal is the small **● Failed** pill in the top-right
header — a pill that looked the same colour and size as the **● Connected** pill they have
never yet seen. A three-paragraph explanation exists; the user is never shown it.

**Why it fails:** *least confusion* — the screen does not answer "what just happened".
*Error states are interfaces too* — an error the user cannot see is not an error message. The
panel brief's full-page screenshots hide this; screen-truth requires viewport capture.

**This, not the copy, is almost certainly the operator's "no explanation."** It reproduces on
the readable-403 path, which the mock *does* model — so we do not need the B2 wire shape to
explain his report.

**Smallest fix:** on transition to `session='failed'`, scroll the error block into view and
move focus to it (`tabIndex={-1}` + `.focus()` on the `role="alert"` container). One effect,
no new markup. This is the "focus-jump" the 2026-08-13 design declined with an explicit
reconsider clause (*"the form sits directly above the error … reconsider if users miss it"*,
`docs/superpowers/specs/2026-08-13-prefix-scoped-keys-design.md:126-136`) — the clause has
now fired. Focusing the alert also fixes the screen-reader path, which today announces the
alert but leaves the user's reading cursor nine fields away.

---

### F2 (critical) — On the CORS-masked shape, "Run diagnostics" gives a confident, wrong answer that is louder than the correct one.

**Where:** `B-corsmasked-desktop-1-diagnostics.png`; `src/components/ErrorBlock.jsx:47-56`
(appended sentence) and `:75-90` (verdict), `src/lib/connection-diagnostics.js:26-27`.

**What the user experiences:** the error reads "Failed to fetch". Paragraph two is a hedged
CORS/auth note ending with one un-emphasised trailing sentence: *"A key restricted to a
folder inside the bucket can also present this way — if that matches your key, set Base
folder in the form above."* There is a **Run diagnostics** button, so they press it. It
returns five green ticks and, **in bold**, *"Your storage responded, but the browser blocked
the request. This is almost certainly missing or incorrect CORS configuration on the
bucket…"*. The bold verdict renders *below* and *heavier than* the base-folder sentence. The
user now goes off to rewrite their bucket's CORS rules — work that will not help, may be
destructive to a working config, and ends in "I configured CORS and it still fails."

**Why it fails:** *least surprise* and *error states* — the interface asserts a cause it has
not established. Diagnostics probes reachability; it never distinguishes "CORS missing" from
"CORS fine, request denied by a prefix-restricted key with no CORS headers on the 403". The
strongest visual emphasis is on the least reliable claim, and recency compounds it.

**Smallest fix:** two changes, no new mechanism.
(a) When `basePrefixUnset` is true, the `cors-blocked` verdict must not say *"almost
certainly"*; it becomes a two-candidate verdict with the folder-restricted key named first
(exact copy in *Recommended design* below).
(b) Promote the base-folder sentence out of the CORS paragraph into the same standalone,
actionable block the readable-403 path already uses, above the diagnostics button — so the
user meets the cheap, non-destructive hypothesis before the expensive one. Today
`ErrorBlock.jsx:47-51` appends it to the CORS prose and `:57-66` renders the good block only
when `isDeniedLike`; the two shapes should converge on the same block.

---

### F3 (high) — "Copy link" from inside a folder silently loses the folder.

**Where:** `connected-scoped-1-subfolder-copylink-menu.png` and the clipboard read in the
walk (step 4); `src/lib/url-params.js:60-72`.

**What the user experiences:** standing in `clients/acme/sub/`, with the address bar showing
`#prefix=clients%2Facme%2Fsub%2F`, they open the only thing in the UI called **Copy link**
and choose *Connection only (no credentials)*. The toast says "Share link copied to
clipboard". The link they actually paste to a colleague is
`#endpoint=…&bucket=…&provider=…&region=…&basePrefix=clients%2Facme%2F` — it opens at the
floor, not at `sub/`. Nothing in the menu, the toast, or the two labels mentions folders at
all, so the loss is undetectable without opening the link yourself. The operator did open it,
which is why this is reported as "no way to share a link to a specific path".

**Why it fails:** *least surprise* — a control named after the current page must carry the
current page; a link builder that silently drops navigation state the address bar is already
showing is a trap. *Least confusion* — two menu items, neither of which names what varies.

**Smallest fix:** `buildShareUrl` gains an opt-in `prefix`, the header menu names the folder
in its labels, and the toast confirms which folder was included. Exact copy below (F3 and
Q1/Q2 are answered together in *Recommended design §1*).

---

### F4 (high) — The two link models are indistinguishable at the point of choice.

**Where:** `connected-scoped-1-subfolder-copylink-menu.png` (header menu) vs
`C-copylink-1-file-copylink-popover.png` (file row popover);
`src/components/ShareLinkMenu.jsx:52-67`, `src/components/CopyLinkPopover.jsx:83-137`.

**What the user experiences:** two controls, both effectively labelled "Copy link", that do
categorically different things. The header one produces a link that grants **nothing** (the
recipient must have their own key). The file-row one produces a link that **is** access — a
presigned URL usable by anyone who receives it, for up to 7 days. The only wording separating
them is the header's *"The secret key is never included in either link"* (a fine print note
the user reads once) and the row popover's expiry buttons. A user who reasons "Copy link
worked for the file, so Copy link works for the folder" will send a colleague a link that
opens an empty sign-in form; a user reasoning the other way will forward a presigned URL into
a group chat believing it is inert. The second mistake is the expensive one.

**Why it fails:** *consistency* (same label, different contract) and *least surprise* (the
costly misjudgement is the one the naming invites).

**Smallest fix:** copy only — never the word "link" unqualified. The header family becomes
"**Open in Bucketer**" links ("they'll need their own access key"); the file family stays
"**Share this file**" ("anyone with the link can download it — expires in N"). Exact strings
in *Recommended design §1c*. No behaviour change, no new component.

---

### F5 (medium) — Folders have no link affordance at all, and the mobile row has no room for one.

**Where:** `folder-rows-desktop-0-listing.png`, `folder-rows-mobile-0-listing.png`,
`D-mobile-rows-0-viewport.png`; `src/components/Browser.jsx:1441-1470`.

**What the user experiences:** a folder row offers ⤓ ✎ ↪ ✕ and no way to reference the
folder. On Pixel 5 those four buttons already wrap — the ✕ drops onto a second line
(`folder-rows-mobile-0-listing.png`) — and each measures 29×32 px. A fifth per-row button is
the BUG-042 reflow class, and it would push a *destructive* control (✕, the only red one)
further out of predictable position, which is exactly the misclick that costs the most.

Secondary, measured: 29×32 px clears WCAG 2.2 AA **2.5.8 Target Size (Minimum)** (24×24) but
sits far below the 44 px comfortable target; on a phone the delete ✕ is one thumb-width from
rename ✎. That is pre-existing, not introduced here — I flag it because this review's
proposals would otherwise add to that row.

**Why it fails:** *shortest path* — the user's actual object of interest (a folder they can
see) has no handle. But the naive fix violates *prevent accidents* on mobile.

**Smallest fix:** do not add a fifth always-visible row button. Put the folder link where the
current folder is already named — beside the breadcrumb — and give folder rows the action
only via the existing selection/context path (details in *Recommended design §1b*).

---

### F6 (medium) — Quick-switching buckets can dump the user back to the sign-in splash with no memory of where they were.

**Where:** `src/components/App.jsx:1306-1321` (`switchToConnection`) → `:1810-1813`
(`onInitialListFailed` sets `session='failed'`) → `:1627-1636` (splash re-render).
Code-referenced; not reproduced in the walk (needs two saved connections with cached
secrets — see *Questions*).

**What the user experiences:** they are browsing bucket A, click bucket B's tab, and B's key
is prefix-restricted. The whole browsing surface is replaced by "Connect to a bucket" with a
red block they cannot see (F1 applies here too). Their mental model was "I clicked a tab" —
they did not ask to sign out — so the natural reading is *"it logged me out"*. Combined with
F1 they get a splash, a form, and no visible cause.

**Why it fails:** *least surprise* — a navigation gesture produced a session-level
consequence. The failure of B should not destroy the view of A.

**Smallest fix (scoped to this lane's problem):** at minimum, when the failure arrives via
`switchToConnection`, the error block must name the bucket that failed — "Couldn't open
**bucket-b**" rather than "Connection failed" — so the tab→failure causality is stated. Not
reverting to A is the correct larger fix, but it is an architecture call, not a copy fix; I
flag it for the architect lane rather than prescribing it.

---

### F7 (low) — The failed screen shows three competing red paragraphs, the last of which repeats the first.

**Where:** `fail-no-basefolder-desktop-1-after-connect.png` (all of it is red; "Note: …",
then "Check your endpoint URL, bucket name, and credentials. If this looks like a CORS error,
ensure CORS is configured on your bucket."), `ErrorBlock.jsx` `guidance` prop.

**What the user experiences:** on a readable `AccessDenied` — where CORS is provably *not* the
problem, since we read a real response — the block still ends by telling them to check CORS.
Two hypotheses, three paragraphs, no ranking; the eye has nowhere to land. Everything is
emphasised, so nothing is.

**Why it fails:** *least confusion* — an error screen must rank its hypotheses, cheapest and
most likely first.

**Smallest fix:** suppress the generic CORS sentence of the `guidance` string when the error
carries a readable HTTP status (we *did* get a response; CORS is not the issue), and render
exactly one hypothesis block with one bolded action.

---

### F8 (low) — Breadcrumb crumbs are not keyboard-operable.

**Where:** `src/components/Breadcrumb.jsx:49-70` — crumbs are `<span onClick>`, no
`tabindex`, no `role`, no key handler.

**What the user experiences:** a keyboard or screen-reader user cannot navigate up the
folder tree by the visible path; they must hunt for another route. Pre-existing, not a
regression — I raise it because *Recommended design §1b* puts the new folder-link control
next to the breadcrumb, and that new control must be a real `<button>` with a visible focus
ring rather than copying the crumb pattern.

**Why it fails:** *accessibility baseline* — WCAG 2.1.1 Keyboard.

**Smallest fix (for the new control only):** ship the folder-link affordance as a `<button
type="button">`; do not extend the span pattern. Fixing the crumbs themselves is separate
work, worth an issue.

---

## Questions for real users

1. **Which wire shape does real B2 actually produce for a prefix-restricted key listing the
   root?** No live probe has been run (00-facts.md:121-127). F2's severity depends on it; the
   fix is written to be correct either way, but the design must state which was verified and
   which was assumed. *This is the one item only a live B2 key can settle.*
2. **Does a non-developer recognise their B2 "Name Prefix" as the thing we call "Base
   folder"?** My copy proposals name B2's term explicitly because I assume they do not. Worth
   one real observation.
3. **Faced with an error naming two causes, would a user try the free one (type a folder) or
   the expensive one (rewrite CORS) first?** I have ordered them cheap-first; that ordering is
   a hypothesis about behaviour, not a measurement.
4. **When a colleague receives an "Open in Bucketer" link, do they understand they must
   supply their own key?** The link opens a nine-field form with no explanation of *why* they
   are seeing it. Out of scope for this review, but the folder-link feature makes these links
   far more common, so the landing experience is about to get more traffic. *(Assumption
   tagged: I did not walk the recipient's side.)*
5. **F6 not reproduced:** I did not exercise the quick-switch failure with two saved
   connections. The code path is unambiguous, but someone should confirm the user-visible
   result before the fix is scoped.

---

## Verdict

**needs-changes.**

Against "would a first-time user complete this without help?": **no, on both flows, and the
evidence is that the product's own author did not.** F1 alone means a prefix-restricted user
sees a screen that appears not to have reacted at all; F2 means the user who digs further is
actively sent in the wrong direction by the most emphatic text on the page; F3 means the
folder-link goal cannot be completed at all, and the failure is silent.

F1 and F2 are small, contained changes (one focus/scroll effect, one conditional verdict
string, one block promoted out of a paragraph) with a very high return. F3–F5 are a feature,
but a modest one, and the copy work in F4 is the part that determines whether it helps or
introduces a new way to leak access.

---

# Recommended design

Answering questions 1–3 of `00-facts.md`. Everything below is copy-exact; anything in
**bold** is bold in the UI.

## §1 — Folder links (answers Q1 and Q2)

### 1a. The model: one family, extended — not a new link type

A "link to this folder" is **the existing connection share link plus a `prefix` param**. It
is the same family, the same hash, the same recipient contract (bring your own key). Do not
invent a third link category: F4 shows the product already has one label too many. The
`prefix` param exists and is already read on first mount (`Browser.jsx:67-83`, BUG-058) — the
work is to *build* it, not to interpret it.

Rules:

- `buildShareUrl(credentials, { includeKeyId, prefix })` sets `prefix` only when a non-empty
  prefix is passed. `basePrefix` keeps its current unconditional behaviour: it is a
  credential property, `prefix` is where you are standing. Both may appear.
- The floor still clamps on open, with the existing notice — so a stale link to a folder the
  recipient's key cannot reach degrades to "you landed at your floor", never to a 403.
- Never include the folder in a *presigned* link. The two families stay disjoint.

### 1b. Where the affordances live

| Surface | Control | Rationale |
|---|---|---|
| Header **Copy link** menu (desktop + mobile) | gains a folder-carrying item when `currentPrefix` is not the floor | the current folder is what the user means by "here" |
| Beside the breadcrumb (both widths) | one `🔗` icon `<button type="button">` labelled `aria-label="Copy a link to this folder"` | the breadcrumb is where the current folder is already named; F5 keeps it out of the row |
| Folder rows | **no new always-visible button** | F5: Pixel 5 rows already wrap and the ✕ is already displaced |
| Folder rows, mobile + desktop | reachable via the existing checkbox selection path (select one folder → the existing batch action bar gains "Copy link to folder") | reuses a pattern, costs no row width |

The breadcrumb button is a plain `<button>` with a visible focus ring (F8), min 32×32 px, and
it copies on activation with no menu — one click, the common case, no choice forced (*shortest
path*).

### 1c. Exact copy

**Header menu** (replaces the two items in `ShareLinkMenu.jsx:52-67`; the folder item appears
first, and only when `currentPrefix` is set and differs from the floor):

```
Open in Bucketer — this folder (clients/acme/sub/)
Open in Bucketer — top of this bucket
Include my access key ID
The recipient needs their own secret key. It is never included.
```

- The folder item shows the folder **relative to the floor** and truncated from the left with
  `…` beyond ~28 chars: `…/acme/sub/`. Full value in the `title`.
- When at the floor, the first item is omitted (not disabled) — there is nothing to choose.
- **Automatic vs labelled choice (Q2): labelled choice, defaulted by position.** The folder
  item is listed first and is what a user reading top-down takes. Making it silently
  automatic would fail *least surprise* in the other direction — a user copying a link from
  deep inside a private subfolder would not expect the path to travel. Naming the folder in
  the label makes the payload visible before the click, which is the whole fix for F3.
- `Include my access key ID` becomes a **toggle/checkbox inside the menu**, not a third
  copying item — it is an orthogonal modifier of either link, and today's design forces the
  user to choose between "with folder" and "with key ID" the moment both exist. Checked state
  persists for the session.

**Toasts** (must name what travelled — this is how the user verifies without opening the link):

```
Link copied — opens at clients/acme/sub/
Link copied — opens at the top of test-bucket
```

and when the key-ID toggle is on, append one sentence on a second line:

```
Includes your access key ID. The recipient still needs the secret key.
```

**Breadcrumb button** — same behaviour as the folder menu item; on success show the first
toast above. `title="Copy a link that opens Bucketer in this folder"`.

**Selection bar item** (one folder selected): `Copy link to folder`, toast
`Link copied — opens at clients/acme/sub/`.

**File-row popover** (`CopyLinkPopover.jsx`) — copy only, to separate the families (F4).
Heading above the expiry buttons:

```
Share this file — anyone with the link can open it
```

and the existing note becomes:

```
Link expires after the selected duration. No sign-in needed — treat it like a password.
```

The second block's note becomes:

```
Share via Bucketer — same access, opened inside the app so the raw link stays out of server logs.
```

That single pairing — *"they'll need their own access key"* vs *"anyone with the link"* — is
the whole distinction, stated at both points of choice, in the user's terms, with no jargon
(no "presigned", no "credential-bearing").

## §2 — The failed connect (answers Q3)

### 2a. Make it impossible to miss (fixes F1 — do this first, it is the biggest win)

On the `disconnected|connected → failed` transition:

1. `errorRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })`
2. the `role="alert"` container gets `tabIndex={-1}` and `.focus()`

Both are needed: scroll serves the sighted user, focus serves the screen-reader and keyboard
user and gives a visible focus ring as a landing mark. Together they also make the mobile
case work, where the error is 200 px below the fold. The action inside the block must be
reachable from where the user now is (see 2b).

### 2b. One ranked hypothesis, with the fix in reach — not three red paragraphs (fixes F2, F7)

Render **one** hypothesis block for both wire shapes. Structure: what happened → most likely
cause → the action, inline. The action is an inline **"Set base folder"** button that scrolls
to and focuses `#cred-baseprefix` — because after 2a the user is 500 px below the field that
fixes their problem, and "in the form above" is a *direction*, not a control.

**Shape 1 — readable 403 / AccessDenied, no Base folder set:**

```
Couldn't list this bucket — Access Denied

The most likely reason: your access key is limited to one folder inside the
bucket rather than the whole bucket. Backblaze B2 calls this the key's
"Name Prefix"; AWS calls it a prefix condition.

If that's your key, enter that folder as the Base folder and connect again.
    [ Set base folder ]

If your key isn't limited to a folder, then the key ID or secret key is wrong
for this bucket.
```

Note what is *removed*: the generic "if this looks like a CORS error, ensure CORS is
configured" tail (F7). We received and parsed a real HTTP response — CORS is provably fine,
and saying otherwise sends the user to rewrite a working configuration.

**Shape 2 — CORS-masked `Failed to fetch`, no Base folder set:** same block, two candidates,
folder first because it is free to test and CORS edits are not:

```
Couldn't reach this bucket — the browser blocked the response

The browser won't show us why, so there are two likely causes:

1. Your access key is limited to a folder inside the bucket (Backblaze B2
   calls this the key's "Name Prefix"). Some providers don't attach CORS
   headers to a denial, which hides it exactly like this. This is free to
   test: enter that folder and connect again.
       [ Set base folder ]

2. Your bucket's CORS rules don't allow this page. See the setup guide for
   your provider's exact command.
       [ S3-compatible setup guide ]

To see the real error, run the same request with curl or the AWS CLI —
those aren't subject to CORS.
```

### 2c. Diagnostics must stop asserting a cause it cannot establish (fixes F2)

When `basePrefixUnset` is true and every probe passed, the `cors-blocked` verdict string is
replaced — it must never read "almost certainly" while a cheaper, untested hypothesis is on
the screen:

```
Your storage is reachable and its hostname resolves, so the endpoint and
bucket name look right. These checks can't tell a CORS block apart from a
denial your provider sent without CORS headers — so both causes above are
still open. Try the base folder first; it costs nothing.
```

When a base folder *is* already set, the existing `cors-blocked` text stands unchanged (the
cheap hypothesis has been eliminated). The bold weight moves off the verdict; the two
candidates above own the emphasis.

### 2d. The quick-switch path (fixes F6, minimum viable)

When the failure arrives from `switchToConnection`, the title names the bucket so the
tab→failure causality is stated and the user does not read it as a sign-out:

```
Couldn't open test-bucket-b — Access Denied
```

Everything else (2a–2c) is identical; it is the same block. Whether a failed switch should
*preserve* the previous connection's view instead of dropping to the splash is an
architecture decision — flagged, not prescribed here.

### 2e. What this does not claim

Per the harness-fidelity rule: the mock's `sendError` always attaches CORS headers, so **the
harness cannot represent B2's real denial shape.** Shape 1 is verified in the harness (mock
`scopePrefix` 403). Shape 2 was reproduced only by aborting the list request at the network
layer (walk step 2) — a faithful reproduction of the *browser-side symptom*, not proof that
B2 produces it. The copy above is written to be correct under either, and **which one B2
actually sends can only be settled by a live probe with a real prefix-restricted key**
(Question 1).
