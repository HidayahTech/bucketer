# Bucketer 2.0 Roadmap

This document captures the vision and open questions for the 2.0 release.
It is a living planning document — items here are directional, not final specs.

**Last reconciled against shipped code: 2026-07-27 (v1.39.0).** Sections below
are marked where 1.x has already delivered part of what they describe. When
reading this, check the marks before treating anything as an open question —
several were answered by ordinary 1.x releases rather than by a 2.0 effort.

---

## Theme

1.x has proven the core model: a single self-contained HTML file that connects
directly to any S3-compatible endpoint with no backend. 2.0 builds on that
foundation with features that require deeper structural changes — things that
would be awkward to retrofit into the current architecture without a deliberate
redesign pass.

---

## Feature 1 — Multi-bucket browsing from a single credential

> **Status (2026-07-27): partly delivered.** The storage-layer half of this
> shipped in **v1.39.0** as Phase 1 of the login/vault work — see
> `docs/superpowers/specs/2026-07-26-login-vault-design.md` and
> `docs/superpowers/plans/2026-07-26-connection-model-phase1.md`. Credentials and
> buckets are now separate records, so the duplication described below is gone.
> What remains is the *browsing* half: discovery and the switcher. Several
> questions in this section have been answered and are marked below.

### Problem

Each profile used to be tied to exactly one bucket. A user with access to ten
buckets under one set of credentials had to create ten profiles, and the
credential (endpoint, keyId, region) was duplicated across all ten entries even
though only the bucket name differed.

**Resolved in v1.39.0.** A credential is now its own record (`s3b_credentials`)
and a connection is the named pairing of a credential with a bucket
(`s3b_connections`). Ten buckets on one key means one credential and ten
connections. Existing profiles migrate automatically and duplicated credentials
are merged on upgrade.

This also turned out to express something the original framing missed: the
relationship is many-to-many, not one-to-many. The same bucket can be reached by
two different credentials — a read-only key for browsing and a read-write key for
changes — which a "one credential, many buckets" model alone cannot represent.

### Vision

A single credential should be able to expose all the buckets it has access to.
The user connects once, the app lists available buckets, and they can navigate
into any of them — either by switching or, eventually, by browsing multiple
buckets side-by-side.

### Resolved in v1.39.0

- **Profile model** — the bucket field was neither removed nor made optional.
  The named pairing survives as the thing you click; only the credential was
  extracted so it can be shared. Discovery is not required for the model to work,
  which matters because it often isn't available (see below).
- **Per-bucket capability state** — capabilities (list/download/upload/delete)
  moved off the single global `s3b_capabilities` key onto each connection.
  Previously a denial learned against one bucket was applied to every bucket.
  They are still learned only from operations that actually fail; nothing is
  probed, and they still reset on each connect.
- **Migration path** — runs once on first load, preserves names and selection,
  merges credentials that were identical across profiles, and skips a malformed
  record rather than stranding the ones after it. `s3b_profiles` is retained
  untouched for one release as a rollback path. Logged as `BUG-045` and
  `BUG-046` in `BUG-LOG.md`; the rollback is one-way once migration has run,
  which is documented in the Phase 1 plan.

### Still open

- **Bucket discovery** — `ListBuckets` on connect, degrading gracefully when the
  key lacks `s3:ListAllMyBuckets`. Design decision already taken: discovery is a
  **prefill, never a gate**. The bucket field stays a text input you can always
  type into; a successful call merely adds a dropdown. B2 application keys are
  usually bucket-scoped, so a flow that depended on discovery would exclude a
  large share of users.
- **Bucket selector** — a persistent switcher in the header. Cheap now that the
  vault holds every credential post-unlock: switching needs no reconnect and no
  re-entry, whether or not the target shares a credential with the current
  connection. Two constraints identified and not yet settled: it must be guarded
  against in-flight upload/move/delete queues (blocked with a reason, or the
  queues become connection-scoped), and it must not silently change which
  connection capability writes are attributed to.
- **URL / deep links** — `url-params.js` and `buildShareUrl` still assume a
  single bucket. The connection needs to appear in the fragment before deep links
  survive more than one.
- **Simultaneous browsing** — still out of scope. The goal is easy switching, not
  a split-pane multi-bucket view.
- **Credential lifecycle** — editing a connection onto different credentials
  orphans the old credential record ([#53](https://gitlab.com/hidayahtech/bucketer/-/work_items/53)).
  Worth closing before the vault keys encrypted secrets by credential id.

---

## Feature 2 — UI refresh

### Problem

The current interface is functional and deliberately dense — suited to power
users comfortable with S3 tooling. As the app matures and its audience broadens,
the visual layer deserves a more deliberate design pass: better hierarchy, more
polished component styling, and improved usability for less technical users.

### Vision

A visual and interaction refresh that keeps the existing information density for
users who want it while making the first-run experience more approachable.

### Already delivered in 1.x

- **Theming** — done. `system` / `light` / `dark` all ship, with a persisted
  preference and a system-preference-aware default (`src/lib/theme.js`,
  `ThemeToggle.jsx`). This bullet previously read "the dark theme is the only
  option today," which stopped being true well before 2.0.
- **Error states** — largely done. Connection diagnostics (v1.38.0) replaced the
  generic "may be CORS, or auth, or routing" note with an ordered check list and
  a single derived verdict, so a failed connect now says which layer broke.
  Empty-state copy is still thin.
- **Mobile / narrow viewport** — partly done. Layout and touch-target work
  shipped across v1.37.2–v1.37.3, and the e2e matrix now runs mobile device
  profiles alongside desktop. A deliberate responsive pass over the whole
  surface, including a collapsible sidebar, is still open.

### Still to consider

- **Visual design**: typography scale, spacing system, component polish — buttons,
  inputs, modals, the sidebar credential panel.
- **Empty states**: more descriptive first-run and empty-bucket states that guide
  new users rather than just saying "this prefix is empty."
- **Mobile, remaining**: a full responsive pass and a collapsible sidebar.
- **First-run approachability**: the login/vault work
  (`docs/superpowers/specs/2026-07-26-login-vault-design.md`) covers much of this
  for the connect screen specifically — Phase 4 of that spec replaces the
  six-field form with paste-anything credential detection. The rest of the app's
  first-run experience is not covered by it.
- **Accessibility**: keyboard navigation, ARIA labels, focus management in modals
  — a refresh is the right moment to address these holistically rather than
  piecemeal.

### Constraint

The single-file, no-backend, no-install constraint is non-negotiable. The refresh
must stay within that model — no external font CDN, no asset pipeline that breaks
the self-contained build.

---

## Out of scope for 2.0 (possible later)

- End-to-end encrypted share links (design doc exists: `docs/design-encrypted-share-links.md`)
- Persistent upload queue across sessions (design doc exists: `docs/intent/persistent-queue-design.md`)
- Storage usage viewer (design doc exists: `docs/design-storage-viewer.md`)
- Split-pane multi-bucket browsing
