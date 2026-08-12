# Markdown body toolbar + insert-image

## Goal
Make the Markdown **body** editor usable by non-technical authors (blog posts,
articles). Today it is a bare `<textarea>` — the author must know Markdown syntax
and cannot insert an image into the body at all. Add a formatting toolbar
(bold, italic, headings, quote, lists, link) that inserts Markdown at the cursor,
plus an **Insert image** button wired to the existing image library.

This is a general AstroAdmin capability — it lifts every hosted editor that has a
markdown collection, not one site.

## Motivation / scope boundary
The live iframe preview already renders the body, so the author sees the result
as they type (once the collection's preview route points at the entry, e.g.
`/blog/{slug}`). What's missing is *input assistance*: producing correct Markdown
without knowing the syntax, and getting an image into the body.

A full WYSIWYG (contenteditable, TipTap/Milkdown) is explicitly **out of scope**
for v1 — it adds a heavy dependency and a second source of truth. A toolbar over
the existing textarea keeps Markdown as the one representation, needs **zero new
dependencies**, and delivers ~80% of the value. Revisit WYSIWYG only if authors
ask for it after using this.

## Current state (where things are)
- Body editor is rendered directly in `ui/dashboard.js`, in **two** places:
  - create-new view (~L548): plain `<textarea id="markdown-body" name="body">`,
    no wrapper, no `data-markdown`, no expand button.
  - edit view (~L855): `<div class="textarea-wrapper">` + `data-markdown="true"`
    + the fullscreen "expand" button (`data-expand-textarea`).
  The two are inconsistent — unify on the edit-view shape.
- Shown only when `contentType === 'content' && !schema.properties.blocks`
  (block-based collections like pages don't get a body field). Correct as-is —
  the toolbar inherits this gate for free.
- Save path: `form` fires `input` → debounced autosave (dashboard.js ~L1204);
  body value read via `document.getElementById('markdown-body').value` (~L1234).
  **Any programmatic edit must dispatch a bubbling `input` event** or autosave and
  the changes-panel won't see it.
- Image library is reusable: `openImageLibrary(onSelect, currentValue)` from
  `ui/image-library.js` — `onSelect(url)` receives the picked/uploaded path.
  Already used by `field-widgets.js` and `gallery-editor.js`.
- UI stack: vanilla ES modules, no build step for JS (Alpine only on login).
  CSS is Tailwind → `ui/input.css` compiled to `ui/styles.css` via `build:css`.

## Design

### New module: `ui/markdown-toolbar.js`
Exports `enhanceMarkdownEditor(textarea)`:
1. Inject a `<div class="md-toolbar" role="toolbar">` immediately before the
   textarea (inside `.textarea-wrapper`, above the expand button).
2. Wire each button to a pure transform on the textarea's value + selection.
3. After every action: write back `textarea.value`, restore focus + selection
   (`setSelectionRange`), and `textarea.dispatchEvent(new Event('input', {bubbles:true}))`.

**Buttons (v1):**
| Button | Action | Markdown |
|---|---|---|
| Bold | toggle-wrap selection | `**…**` |
| Italic | toggle-wrap | `*…*` |
| H2 | line-prefix | `## ` |
| H3 | line-prefix | `### ` |
| Quote | line-prefix | `> ` |
| Bulleted list | line-prefix each line | `- ` |
| Numbered list | line-prefix, incrementing | `1. `, `2. `… |
| Link | wrap selection | `[sel](url)` (url from a small inline prompt; sel becomes label) |
| Insert image | `openImageLibrary(url => insert)` | `![alt](url)` at cursor |

**Keyboard shortcuts** (nice-to-have, same handlers): Cmd/Ctrl+B, Cmd/Ctrl+I,
Cmd/Ctrl+K (link).

### Pure, unit-testable transforms (no DOM)
Keep the editing logic as pure functions so they can be tested without a browser
(the codebase already unit-tests `form-generator`):
- `toggleWrap(text, start, end, marker) -> {text, start, end}` — wraps the
  selection, or unwraps if already wrapped (idempotent: bold→bold = no-op pair).
- `prefixLines(text, start, end, prefix, {ordered}) -> {…}` — adds/removes a
  line prefix across every line the selection touches; ordered mode numbers them.
- `insertAt(text, pos, snippet) -> {…}` — inserts, returns caret inside the
  snippet's natural edit point (e.g. between `](` and `)` for a fresh link).
The DOM layer (`enhanceMarkdownEditor`) only reads `selectionStart/End`, calls a
transform, and writes back. This is the part that carries the test coverage.

### Insert-image flow
`openImageLibrary((url) => { apply insertAt(value, caret, '![](' + url + ')');
place caret between the '![' and '](' so the author types alt text })`.
The library already handles upload + drag-drop + browse, so no server work.

### Wiring into dashboard.js
- Unify both body-editor render sites on the edit-view markup (wrapper +
  `data-markdown="true"`), so create-new gets the toolbar too.
- After each `editorForm.innerHTML = …`, call
  `document.querySelectorAll('textarea[data-markdown]').forEach(enhanceMarkdownEditor)`
  (mirror the existing post-render setup for `data-expand-textarea`).
- Import `enhanceMarkdownEditor` at the top of dashboard.js.

### CSS
Add `.md-toolbar` + `.md-toolbar button` styles to `ui/input.css`; rebuild
`styles.css` via `npm run build:css`. Small: a hairline bar of icon buttons,
matching the existing toolbar/expand-button styling.

## Invariants to respect (from CLAUDE.md "admin UI invariants")
- **Dispatch `input`** after every programmatic edit — autosave + changes-panel
  read DOM events, not the value directly.
- The image-library **modal must outrank** whatever opened it — already true
  (it's used from field widgets); reusing it inherits the correct z-index.
- Don't touch `extractFields` / schema-type attributes — the body textarea is
  read directly by id, not via the schema field extractor, so it's unaffected.
- Coexist with the existing `data-expand-textarea` fullscreen expand: the toolbar
  sits inside the same `.textarea-wrapper`; verify the expand still works and the
  toolbar rides along (or is re-injected) in the expanded view.

## Testing
- **Unit** (`tests/markdown-toolbar.test.js`): the pure transforms — toggleWrap
  wraps/unwraps and is idempotent, prefixLines handles multi-line + ordered,
  insertAt caret position. No browser.
- **E2E** (Playwright, existing harness): open a content entry with a body,
  select text → Bold → assert `**x**`; caret in body → Insert image → pick →
  assert `![](…)` inserted at the caret; Cmd+B shortcut; confirm autosave fires
  (changes counter increments).
- **Manual/CDP**: toolbar renders, buttons legible, works in the expanded editor.
- Negative control worth running once: assert a *block-based* collection (pages)
  shows **no** body toolbar (the `!hasBlocks` gate).

## Effort / risk
~1 focused session. Low risk: one new self-contained module + additive edits to
two render sites and CSS. No server changes, no new dependencies, no schema
changes. Nothing else in the editor reads or writes the body differently.

## Rollout
Publish the astroadmin patch to npm, bump the consuming site's `astroadmin` pin +
`bun.lock`, `git pull` + restart the admin/preview units on the box (hosted
editors don't auto-pull). Benefits every hosted markdown collection.

## Built (2026-07-27)
- `ui/markdown-transforms.js` — pure transforms (wrap/heading/prefix/ordered/
  link/image), 13 unit tests in `tests/markdown-transforms.test.js` (registered
  in `test:unit`).
- `ui/markdown-toolbar.js` — `enhanceMarkdownEditor(textarea)`: renders the bar,
  wires buttons + Cmd/Ctrl+B/I/K, reuses `openImageLibrary` for insert-image,
  dispatches `input` after every edit, idempotent.
- Hooked in `field-widgets.js` `setupFieldWidgets` (runs for both editor mount
  points), so any `textarea[data-markdown]` is enhanced. Unified the create-new
  body markup in `dashboard.js` to carry `data-markdown`.
- `.md-toolbar` styles in `input.css`, rebuilt `styles.css`.
- Verified live over CDP against a real project: toolbar renders (9 buttons),
  Bold → `**cat**`, H2 → `## …`, insert-image opens the library; **negative
  control** — a block-based collection (pages) shows no toolbar/body. Unit +
  form-generator tests green.
- Not yet: publish to npm + bump the site pin (do at rollout). E2E test still to
  add (unit coverage carries the logic for now).

## The harder problem: images & layout (raised by James)
A markdown toolbar makes *prose* pleasant, but Markdown genuinely cannot express
the site's richer constructs — a full-bleed banner, an image with a specific
aspect/caption, a **split image + text** row, a gallery — without ugly inline
HTML or directives that authors then have to hand-write. That is the same reason
`pages` use the **block editor**, which already handles images, arrays and
reordering with real layout awareness.

**Direction (for a later decision, not built here):** the strong answer for a
layout-rich blog is to author posts as a **stream of blocks** — a `prose` /
`richText` block for text (edited with *this* toolbar), interleaved with
first-class `image`, `split`, `quote` and `gallery` blocks — exactly how Sanity
portable-text / Gutenberg work. That keeps prose easy AND makes layout blocks
structured and visually editable, instead of asking an author to encode layout
in Markdown.

This toolbar is forward-compatible with that: `enhanceMarkdownEditor` attaches to
*any* `textarea[data-markdown]`, so if a `prose` block exposes a markdown field,
it gets the same toolbar for free. So the sequence is: (1) toolbar now — useful
in every model; (2) decide the blog content model (single markdown body vs
blocks) with the client's real needs in view; (3) if blocks, add `split` /
`image` / `gallery` block types (a `split` block also benefits the marketing
pages). No rework thrown away either way.

## Out of scope (follow-ups)
- **Graceful placeholder in image *fields*.** A schema default of
  `placeholder:banner` renders a broken `<img>` in the image field preview. Fix
  separately: image fields should show an empty "upload" state for a non-path
  value (or the consuming site defaults image fields empty and the component
  renders the outline). Small, independent.
- In-panel Markdown preview (the iframe already covers rendered output).
- Full WYSIWYG / contenteditable.
- Tables, footnotes, embeds.
