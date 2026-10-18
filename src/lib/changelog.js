// Copyright (C) 2026 HidayahTech, LLC
// @generated — do not edit directly. Source of truth: CHANGELOG.md (parsed by build.mjs).

export const CURRENT_VERSION = '1.69.0';

export const CHANGELOG = [
  {
    "version": "1.69.0",
    "date": "2026-10-17",
    "title": "What's new shows what changed, and the page is lighter",
    "changes": [
      {
        "para": "The \"What's new\" window now shows what each release changed. Since v1.45.0 every release here has been written as a paragraph, and the window only showed bullet lists, so for the last 51 releases it showed a version, a date and a title, with nothing underneath. It now shows the paragraphs too. It also lists only the 10 newest releases, and a \"Full changelog on GitLab\" link at the end opens the complete history. The whole history was about a seventh of the page Bucketer downloads; the page is now about 100 KB smaller (about 36 KB smaller as sent over the network)."
      }
    ]
  },
  {
    "version": "1.68.2",
    "date": "2026-10-17",
    "title": "A test that counted the upload log as files",
    "changes": [
      {
        "para": "No change to the app. The test that checks sorting by Name counted the rows of the file list, and it also picked up the rows of the upload log under Activity, which use the same table layout. On GitLab's phone-sized Safari-engine runs the log had filled in by the time the test looked, so it saw three extra blank rows and failed, although the files were in the right order. It now counts only file-list rows."
      }
    ]
  },
  {
    "version": "1.68.1",
    "date": "2026-10-17",
    "title": "The connect screen has no save step",
    "changes": [
      {
        "para": "The connect screen lost its \"Save current as a bucket…\" button, which read \"Update this bucket…\" once you picked a bucket. Since v1.66.0 every bucket you connect to is remembered on this device without asking, so the button looked like a step you had to take before connecting, and \"Update this bucket…\" did not say what it would update. To give a bucket your own name, open the menu while connected and use the button under \"Accounts & buckets\", as before. Nothing about what is remembered has changed: storage address, bucket, key ID and folder, never the secret. This finishes the layout regroup picked in the 2026-10-16 design review."
      }
    ]
  },
  {
    "version": "1.68.0",
    "date": "2026-10-17",
    "title": "One menu per row, a selection bar that stays, downloads in one click",
    "changes": [
      {
        "para": "The second half of the layout regroup picked in the 2026-10-16 design review (\"layout A\"). One menu per row: each file and folder row carried four to six unlabelled icon buttons, which wrapped onto two or three lines on tablets and phones. A row now has one Download button and a \"⋯\" menu that names every other action in words: Copy share link, Properties, Rename, Move to… and Delete… for a file; Download as ZIP, Rename, Move to… and Delete folder… for a folder. Near the bottom of the screen the menu opens upward, so Delete is never below the fold; on phones it opens as a sheet at the bottom of the screen, with a Cancel button. The selection bar stays in view: on wider screens, after you tick files and scroll down a long folder, Copy, Move and Delete for the selection stay at the top of the screen instead of scrolling away. When a filter hides some of what you ticked, the bar says how many (\"· 2 not shown by the filter\"). Downloads in one click: downloading one ticked file now just downloads it, and two or more ticked files totalling 64 MiB or less download at once as a single ZIP, with progress under Activity. Folders and bigger selections still open the download panel, which counts them first; so does any browser that cannot build a ZIP (Safari). Delete says what it reaches: the confirmation names the bucket, its storage address and the folder it is in, and its button says how many files (\"Delete 3 files\"). The filter says what it searched: it is labelled \"Filter loaded items\", its count reads, say, \"12 of 1000 loaded · more available\" when the folder has more than was loaded, and a filter with no match says it only looked at the loaded items. Your buckets: the sidebar now opens every account when you have eight buckets or fewer (it showed only the active one); a collapsed account says how many buckets it holds; \"+ bucket\" is now \"Add bucket for this key\", with a larger button; account names wrap instead of cutting off the end of the key; and the secret's note reads \"Your secret is kept only until you close this tab. It is never saved.\" Next: the connect screen loses its \"Save current as a bucket…\" button, since every bucket you connect to is remembered (v1.68.1)."
      }
    ]
  },
  {
    "version": "1.67.2",
    "date": "2026-10-17",
    "title": "Release pages carry their release notes again",
    "changes": [
      {
        "para": "No change to the app. Every GitLab Release since v1.45.0 published with an empty description: the release script kept only lines starting with \"- \" from each changelog entry, and the entries had become paragraphs. Each Release now carries its whole changelog entry, as this list does. The v1.63.4 to v1.67.1 Releases were filled in by hand; older empty ones are unchanged (BUG-083)."
      }
    ]
  },
  {
    "version": "1.67.1",
    "date": "2026-10-17",
    "title": "Ticking a file on a phone no longer moves the list",
    "changes": [
      {
        "para": "On a phone, ticking the first file inserted the selection bar above the file list and pushed every row about 122 px down the page, so a quick second tap could tick a different file than the one you aimed at, just before a Delete or Move. On phones the selection bar now sits at the bottom of the screen and nothing moves when it appears. The list leaves room under its last row so nothing hides behind the bar, and a row you tab or scroll to stays above it (that last part needs Firefox 121 or newer; other current browsers have it). On wider screens the bar stays above the list (BUG-082)."
      }
    ]
  },
  {
    "version": "1.67.0",
    "date": "2026-10-17",
    "title": "The bucket is the page: one Upload button, one Activity line",
    "changes": [
      {
        "para": "The first half of the layout regroup picked in the 2026-10-16 design review (\"layout A\"). The bucket is the title: the page now opens with the bucket's name as its heading, followed by the folder you are in (my-bucket / photos), and a line under it names the provider, the end of your key ID, the storage address and the base folder. The bucket chip in the header (new in v1.66.0) is gone, so the name no longer shows twice. Upload ▾: the always-open \"Destination folder\" form and its Choose files / Choose folder buttons pushed the file list a third of the way down the page. One Upload button now leads the file toolbar, with \"Upload files…\" and \"Upload a folder…\", and dragging files anywhere onto the window still works. A single line under the toolbar says where uploads and drops will land, and \"Change folder\" still lets you type any path, including one that doesn't exist yet. Activity: uploads, moves, deletes and ZIP downloads used to stack as cards above the file list, which jumped down the page each time one finished. They now sit behind one Activity line that says what is running (\"Uploading holiday.jpg · 40 %\", \"All done · 3 finished\"), with a badge for work in progress and another for anything that needs attention. It is closed by default, so the list stays put, and it stays open on this device if you leave it open. Everything inside works as before. Bucket tools ▾: Find duplicates, Incomplete uploads and Hidden versions now live in one menu in the header, not as separate buttons. The toolbar reads Upload ▾ · New folder · Download · Refresh, with the filter on the right, or on a row of its own on phones. Next: menus on each row, a selection bar that stays in view, and clearer delete confirmations."
      }
    ]
  },
  {
    "version": "1.66.0",
    "date": "2026-10-16",
    "title": "Bucketer remembers your buckets",
    "changes": [
      {
        "para": "The account redesign picked in the 2026-10-16 design review (\"accounts A\"). Remembered without asking: the first time a bucket answers, Bucketer saves it on this device: storage address, bucket, key ID and folder, never the secret. You no longer need to save a bucket to find it again (saving still lets you name it), and Sign out keeps the list (it still forgets the secret). Your buckets: the connect screen lists every saved bucket, most recently used first, with its storage address and when you last used it. Pick one and only the secret is left to type; the button names the bucket. \"Forget all on this device\" removes the whole list, and each bucket still has its own Forget, which now says that your files are not touched. Each account in the list opens and closes from the keyboard too, and screen readers hear whether it is open. Fewer things to type: the storage address offers the addresses you have used on this device, then every Amazon S3, Wasabi and DigitalOcean Spaces region; the bucket field offers the buckets you have used at that address. Typing (or letting your password manager fill) a key ID you have used before fills its storage address and the bucket you used last, without overwriting anything you typed. Base folder, provider and region now sit under \"More options\", marked ▸ when closed, which opens by itself when one of them is set. Which bucket am I in? The header now shows the bucket name and its storage address (the address hides on phones), and the browser tab is titled with the bucket. Not in this release: secret-free export/import of the list and pasting a bucket URL, per-bucket regions for Amazon S3 and Wasabi, and a check of how each browser's password manager behaves with the form."
      }
    ]
  },
  {
    "version": "1.65.0",
    "date": "2026-10-16",
    "title": "A new look: one typeface, a deeper teal, real icons",
    "changes": [
      {
        "para": "The visual refresh picked in the 2026-10-16 design review (\"look B\"). Typeface: the interface now uses Hanken Grotesk, bundled inside the app (it adds about 46 KB to the download and needs no font server; licensed under the SIL Open Font License, whose notice ships inside the app). A host's Content-Security-Policy must allow font-src data:, as the README examples now show; without it the browser falls back to the system font and nothing else changes. Colour and shape: a deep teal primary for buttons, links and the selected state, with a lighter teal in dark mode; a dark ink-teal header; softer two-layer shadows and rounder corners; every text colour reads at 4.5:1 or better in light and dark, including the header buttons and the size column, now checked by the test suite. Icons: the emoji and Unicode symbols on buttons (📁 📄 ✎ ⎘ ↪ ✕ ☰ ☀ 🌙 and the rest) looked different on every system, and ✕ meant Delete, Cancel and Close in different places. They are now one set of line icons: a bin for Delete, ✕ only for Close and Cancel, and folder, document, image, video and archive tiles for file types. Icon-only buttons gained spoken names (\"Save name\", \"Cancel rename\", \"Remove from list\"). Header: the logo now shows on the dark header, with a \"Bucketer\" wordmark beside it. Nothing about how Bucketer works has changed; the layout regroup comes in a later release."
      }
    ]
  },
  {
    "version": "1.64.1",
    "date": "2026-10-16",
    "title": "Release of the v1.64.0 design floor",
    "changes": [
      {
        "para": "No change to the app beyond v1.64.0, whose GitLab Release never published. One test file in the v1.64.0 commit was not formatted, so CI's format check failed and blocked the release job. The same thing happened to v1.62.2. This release carries the formatting fix, and the pre-push check now refuses to push unformatted code before it tags a version (BUG-080). Everything in v1.64.0 below ships here."
      }
    ]
  }
];
