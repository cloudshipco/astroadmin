# Click-to-edit: preview ↔ editor field linking

Today only BLOCKS link (editor→preview, via `.block-header` clicks + the
`data-block-index`/heuristic `findBlocks`). Scalar fields have no linking in
either direction, and a blog post (no blocks) has none at all. Add a small
`data-aa-field` convention so any annotated element links both ways.

## Convention

A site marks an editable element with `data-aa-field="<name>"`, where `<name>`
matches the editor form field's `name` (top-level fields: the field key, e.g.
`category`, `title`, `body`). Reusable across every astroadmin site; a site
without annotations simply gets no field-level linking (blocks still work).

## astroadmin — reusable plumbing

`integration/index.js` (injected preview script):
- Inject a subtle hover affordance on `[data-aa-field]` (outline + pointer) so
  editable elements read as clickable in the preview.
- Click on `[data-aa-field]` → `postMessage({type:'fieldFocus', field})` to the
  parent. Don't preventDefault (real links keep working; content isn't a link).
- Handle `{type:'highlightField', field}` from the parent → scroll + briefly
  outline `[data-aa-field="<field>"]` (mirrors the existing focusBlock highlight).

`ui/dashboard.js`:
- In the guarded message handler, handle `fieldFocus`: focus + scroll + briefly
  highlight `#contentForm [name="<field>"]` (expanding a collapsed block if the
  field is inside one).
- On `focusin` of a named form field, post `highlightField` to the preview so
  clicking a control highlights its element (fixes the Category-doesn't-highlight
  gap). Post to the preview origin.

## Site annotations (this repo, as the working demo)

- `PageHeader.astro`: kicker→`data-aa-field="kicker"`, h1→`headline`,
  standfirst→`standfirst`.
- `blog/[slug].astro`: eyebrow→`category`, date span→`date`, h1→`title`,
  description→`description`, author→`author`, body wrapper→`body`.
- Drive-by: `blog/[slug].astro` still references the removed `d.updated` field —
  remove it.

## Verify (CDP)

- Editing a blog post, clicking the Category field highlights "Industry view"
  in the preview; clicking the title/standfirst highlight theirs.
- Clicking "Industry View" / the title in the preview focuses the matching
  control in the editor.
- No regression to page-nav, the block focus, echo guard, or forged-message
  rejection.

## Status: DONE (2026-07-31)

All verified over CDP (both directions + no regression). Commits: astroadmin
`b52ae00` (plumbing) + site `7fc041c` (annotations, Prose attr-forwarding,
stale `updated` removed).

**Bug found while testing this (fixed, `572ffe3`): the markdown body leaked into
the frontmatter on every save.** The `#markdown-body` textarea is read by id but
also had `name="body"`, so extractFormData put it into `data`, and
`matter.stringify(body, data)` duplicated it into a frontmatter `body:` key.
Pre-existing (on main) — would have corrupted every client blog-post edit. Fixed
by stripping `body` from the extracted data when a markdown editor is present.

**Delivered in astroadmin 1.4.1 (2026-08-12).** Published to npm; the site's
astroadmin pin bumped to `^1.4.1`, so the click-to-edit plumbing now installs
from the registry and the temporary `integration/index.js` override is
superseded by the published file (verified byte-identical). Note: 1.4.0 was
withdrawn (built from a stale base) and re-cut cleanly as 1.4.1.

## Pre-release review (Codex, 2026-08-12) — fixed in e60667e

Reviewed the new delta (blog-post nav, click-to-edit, body fix). Fixed: P1 body
fix made a root fix (textarea has no form name; found via data-content-field) so
it can't drop a real `body` frontmatter field (+ guard test); P2 injected
selector-escaping was a no-op → compare the attribute value directly; P3
trailing-slash route templates now match; P3 highlight/flash toggle a class /
restore inline styles instead of clobbering consumer styling.

**Deferred (documented limitation):** the collection preview-nav reverse-map
isn't locale-aware — `/fr/blog/x` won't match `/blog/{slug}`. Same class as the
existing i18n-nav limitation in the codex-review-fixes plan; no effect on a
single-locale site. Fix later by parsing the configured locale prefix before
route matching and snapshotting the detected locale before loadEntry().
