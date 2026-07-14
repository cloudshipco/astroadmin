# AstroAdmin Development Guidelines

## This is a PUBLIC repository

Never commit real client / customer / business names anywhere in this repo —
**including as example or placeholder values** in code, comments, docs, plan
files, commit messages, and issues. Use generic examples only: `site-a`,
`site-b`, `example.com`, `admin.example.com`. Real deployment bindings live in
the separate private ops repo, not here.

## Architecture Principles

### Site Agnosticism

**AstroAdmin must be completely site-agnostic.** This means:

1. **Never add site-specific styles to AstroAdmin** - The admin UI has its own styles (in `ui/input.css`), but when rendering site content (like component previews), we must use the site's own styles, not bundle our own.

2. **Component preview uses site styles** - The `integration/preview-route.astro` imports styles from the site (e.g., `/src/styles/global.css`) so that previewed components look exactly as they will on the live site.

3. **No assumptions about site structure** - Use conventions and auto-discovery (like `import.meta.glob`) rather than hardcoding paths or component names.

4. **Configuration over convention where needed** - Allow sites to override auto-detected behavior via `astroadmin.config.js`.

### Two Distinct Style Domains

- **AstroAdmin UI** (`ui/*.css`) - Styles for the admin dashboard, modals, forms, etc.
- **Site Content Preview** - Must use the site's own CSS, loaded dynamically via the Astro integration

### The admin UI: one renderer, three surfaces

`ui/form-generator.js` is the **single** renderer, event-wirer and value-extractor for every
field. Three surfaces consume it: the main editor form, block bodies, and the array item
modal (`ui/array-editor.js`). `ui/field-widgets.js` holds the widget behaviour they share
(image picker, gallery, colour picker, textareas, plus a registration hook for reference
fields, whose wiring lives in `dashboard.js` because it navigates the dashboard).

**Never grow a second renderer.** The array item modal used to have its own cut-down copy
that handled checkbox/select/textarea and dumped everything else into a text input — which
is why an image field inside an array item showed as a raw `/images/x.jpg` text box for
months. If a field kind needs to work in the modal, fix `generateField`, don't special-case
the modal.

Three invariants that are easy to break and fail silently:

1. **The input element must carry the schema type.** `extractFields` reads the *DOM*, not the
   schema, to decide what a value parses back as (it coerces only when `input.type === 'number'`,
   and reads checkboxes as booleans). A number or boolean rendered into a text box saves as the
   string `"4"` / `"true"` and fails validation. String-sniffing instead is worse: it turned a
   title of `"2024"` into the integer `2024`.
2. **JSON in an attribute must go through `jsonAttr()`.** Object arrays ride in a hidden input's
   `value`. Interpolating raw `JSON.stringify` output was a *data-loss* bug, not a style one: an
   apostrophe ("we'll", "O'Brien") ended the attribute early, `JSON.parse` threw, `extractFields`
   fell back to `[]`, and the entire array was silently wiped on save.
3. **A modal must outrank whatever can open it**, or it renders behind its own opener and is
   visible but unclickable. The scale lives in `ui/input.css`: 50 primary modals, 60-69 stacked
   item editors (bounded by `MAX_STACK_DEPTH`), 70 leaf pickers opened *from a field* (gallery,
   expanded textarea, reference picker), 80 image library (it can be opened from a field *or*
   from the gallery editor). Adding a modal means placing it on this scale.

When changing overlay/stacking behaviour, verify with `document.elementFromPoint()` — asserting
the element exists proves nothing, since the bug is precisely that a present element is covered.

## Testing

Tests are standalone scripts under `tests/`, run individually (there is no test
runner aggregating them). Most run server-less and need env vars:

- `bun tests/content-files.test.js` — files store. Self-contained (builds its own
  temp root; deliberately overrides any `ASTROADMIN_PROJECT_ROOT` in the env).
- `bun tests/content-store.test.js` — SQLite store. Self-pins `ASTROADMIN_CONTENT_STORE=db`;
  pass `ASTROADMIN_DB=<tmp.db> ASTROADMIN_PROJECT_ROOT=<tmp>`.
- `bun tests/export-files.test.js`, `tests/import-files.test.js`, `tests/schema-parser-db.test.js` —
  build their own throwaway project (symlink `node_modules` for zod); just `bun tests/<x>.test.js`.
- `bun tests/loader.test.js` — DB loader; self-pins db mode; pass `ASTROADMIN_DB` + `ASTROADMIN_PROJECT_ROOT`.
- `bun tests/auth.test.js` — auth helpers (needs Bun for `Bun.password`).
- `bun tests/form-generator.test.js` — the field renderer. No DOM needed: it asserts on the
  HTML string `generateForm`/`generateFields` return. Covers hostile content (apostrophes,
  quotes, markup), the input-type-carries-schema-type rule, and the alt-collision rules.
  `extractFields` (the read-back half) has **no** coverage yet — it needs a DOM.

**Known red:** `tests/git-api.test.js` fails on a clean tree ("only configured git path
was committed"). Pre-existing and unrelated to the UI; don't read it as your breakage.

**Storage modes:** the content store is selected by `config.content.store`
(`files` default | `db`), env `ASTROADMIN_CONTENT_STORE`. Tests that exercise the
DB store **must pin db mode** (a `process.env.ASTROADMIN_CONTENT_STORE = 'db'` line
before imports), since `files` is now the default.

**Caveat:** `npm test` / the `test` script only runs `tests/api.test.js`, which
needs a **running server** and is currently red (tracked as issue #2). Don't read
that single red as the suite being broken — run the server-less tests above.

## Releasing

`npm publish` requires interactive browser auth — ask the user to run
`! npm publish` themselves; then tag `vX.Y.Z` and create the GitHub release.
Version semantics: npm `0.2.0 → 1.1.0` is the files-first line; git tag
`v1.0.0` is the shelved SQLite store and was **never published to npm** — don't
reuse 1.0.0. Pre-publish sanity: `npm pack --dry-run` (the `files` allowlist
must keep plans/, docs/, tests/ out of the tarball).
