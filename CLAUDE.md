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
  The read-back half (`extractFields`/`extractFormData`) is covered separately, below.
- `bun tests/extract-fields.test.js` — the read-back half, in a happy-dom `<form>` rendered by
  the real `generateForm`. Covers zero-item arrays (blocks, references, inline arrays) saving
  as `[]` rather than vanishing, paths after a block/item is deleted, and a page round trip.
  The rule it pins: an empty array survives `extractFormData` only when its key is REQUIRED;
  an empty array the schema proves optional is dropped (`[]` fails `.optional().min(1)`),
  inside block items too.
- `bun tests/content-validation.test.js` — the editor's schema WARNINGS: what a stored entry
  is judged as (dropped required array, nested block field, quoted vs unquoted YAML date,
  `file()` items), and that a save still writes invalid content and reports why.
- `bun tests/publish-check.test.js` — the publish gate, against this repo's real Astro: a
  throwaway site with a bare remote; invalid content is committed but not pushed, the commit
  (not the working tree) is what is checked, a rebase onto the remote is checked as
  combined, a missing `image()` file is refused, only the checked commit is pushed (not
  other configured refs, even with a same-named tag), a failed push is reported as NOT
  published, a timeout settles even when a descendant daemonises, gitlinks and workspace
  links are refused, a tracked `.env` stays as committed, `build.production` is honoured,
  the admin's secrets are not in the build's environment, server paths are stripped, and
  the site's own `node_modules/.astro` is byte-identical afterwards. Takes ~1-2 min (each
  publish runs a full `astro build`).
- `bun tests/astro-bin.test.js` — the default build commands run the site's OWN installed
  astro (`server/utils/astro-bin.js`), never a package runner: with no astro installed the
  publish check and the production build refuse and a fake `bunx`/`npx` first on PATH is
  never called; with the package but no `node_modules/.bin`, the check still builds. ~5 s.
- `bun tests/live-url.test.js` — page path -> live-site URL (`ui/live-url.js`), shared by the
  header's "View live site" link and the server's live-status check: base paths, query/hash,
  and escape attempts (`//host`, `/\host`, `javascript:`, and paths that only normalise to
  `//host`, such as `/.//host`) falling back to the site root.
- `bun tests/preview-live-link.test.js` — the preview's pageNavigation message -> live link and
  entry, with and without a base path (the iframe reports its pathname WITH the preview base,
  which must be stripped before the live link adds publicUrl's).
- `bun tests/preview-click.test.js` — the script the integration injects into preview pages
  (`adminPreviewScript`, exported for this), run in happy-dom inside a stand-in iframe: which
  clicks post a `fieldFocus` (never one inside an `<a href>`), and which element a
  `highlightField` outlines.
- `bun tests/entry-urls.test.js` — `ui/entry-urls.js` against the real `createServer()` app: a
  nested slug (`2024/first-post`) travels as ONE encoded segment, so reads, saves and dashboard
  links reach `/:collection/:slug`; and dashboard.js builds no such URL by hand, nor a picker
  value (`entryValue`), a collection API URL or a virtual-page URL (whose slug, from a file
  name, must survive a reload's percent-encoded pathname).
- `bun tests/content-traversal.test.js` — path traversal through the real `createServer()` app,
  as a logged-in editor: encoded collections (`%2F..`, double-encoded, backslashes, absolute,
  unicode dots, NUL, `__proto__`), hostile slugs, symlinks out of a collection, image filenames
  and git file paths (including pathspec globs), with sentinels outside the content directory
  checked byte-for-byte. The rule it pins: a collection must be DECLARED in the content config
  (exact own-key match), and every resolved file is checked for containment, through realpath,
  after its final name is built (`server/utils/glob-files.js`: `assertDeclaredCollection`,
  `assertSafeSlug`, `assertContainedPath`). `path.normalize` alone is not a guard: it turns
  `/../../` into `/`. Refusals are 400s that name no server path.
- `bun tests/image-serving.test.js` — site files the admin serves on its own origin (`/images`,
  `/assets`, for editor thumbnails) carry `Content-Security-Policy: ...; sandbox` and `nosniff`,
  so an uploaded SVG opened directly runs no script with the editor's session. A response CSP
  applies only to a document, so `<img>` display is unchanged; checked once in real Chrome
  (2026-10-09: before the fix a navigated SVG read `/api/session` and wrote admin-origin
  localStorage; after it, the origin is opaque, nothing ran, and the `<img>` still drew).
  They also need a session (401 without one, like the API): `src/assets` and
  `src/content/assets` hold unpublished drafts. The editor's `<img>` requests are
  same-origin and carry the session cookie; the preview and the live site serve
  their own copies.
- `bun tests/content-problems.test.js` — the editor side (happy-dom): issue paths finding
  their fields, marks clearing, marks never leaking into `extractFields`, the refusal panel.

`tests/git-api.test.js` used to be a known red; it passes as of 2026-10-08 (checked at
`74609bd` in a clean worktree).

`astroadmin doctor` (`server/doctor/`, docs/doctor.md) has five test files:
`doctor-coverage` (built-HTML checks on a fixture page, each shown red on a mutated copy),
`doctor-static` (config, lockfile, submodule, workspace and sharp checks on throwaway repos),
`doctor-cli` (exit codes, `--json`, `--build`, the site's installed astro and never a fetched
one; ~10 s), `doctor-publish` (the editor scans the publish check's own build in a child
process rooted at the check's worktree, so it reads the commit's entries; a scan stuck in a
synchronous loop is killed at its cap; an error is "unavailable" with a reason naming no
server path, never a failed publish; ~15 s) and
`doctor-notice` (the editor notice, happy-dom). Run each with `bun tests/doctor-<name>.test.js`.

**Storage modes:** the content store is selected by `config.content.store`
(`files` default | `db`), env `ASTROADMIN_CONTENT_STORE`. Tests that exercise the
DB store **must pin db mode** (a `process.env.ASTROADMIN_CONTENT_STORE = 'db'` line
before imports), since `files` is now the default.

**Caveat:** `npm test` / the `test` script only runs `tests/api.test.js`, which
needs a **running server** and is currently red (tracked as issue #2). Don't read
that single red as the suite being broken — run the server-less tests above.

## Schema validation: saves warn, the site's own Astro gates the push

Two layers, deliberately unequal:

1. **Saves always write, and only WARN.** The save/read response carries `validation`
   (`server/utils/content-validation.js`: the stored entry, read back through the store,
   checked against the collection's Zod schema), and `ui/content-problems.js` shows it.
   It approximates Astro's loading and is never used to refuse anything; a 422 on save
   would lose half-finished autosaved edits.
2. **Nothing is pushed until the site's own Astro accepts the exact commit**
   (`server/utils/astro-check.js`): `build.check`, else the site's `build.production`,
   else the site's own installed astro (`server/utils/astro-bin.js`), runs in a throwaway `git worktree` at HEAD, after the commit
   and after `pull --rebase`, under `withGitLock` (which `/api/git/pull` also takes) so
   the commit checked is the commit pushed. The push names that SHA and the branch's
   upstream explicitly (`pushCheckedCommit`), so a configured push refspec or
   `push.default=matching` cannot send unchecked refs. A failure keeps the commit local
   and returns 422 with Astro's output, server paths and stack trace stripped. A push
   that fails (with an upstream configured) returns 502 and the editor is told it is NOT
   live; only `pushed` or a deploy counts as published in the UI.
   It is a full build, not `astro sync`: sync passes a missing `image()` file, and for
   these sites the build costs about the same (~1.5 s).

**Trust boundary:** the site's code (config, integrations, build scripts) is trusted; it
is ours, and editors change content only. One exception to "content only": an `.mdx` body is code
(imports, JSX expressions, `export` statements), and the publish check's build runs it on
the host, so an editor who can save an `.mdx` entry can run code there. Treat MDX editing
as code access when deciding who gets an editor login. The worktree stops an honest build reading the
live checkout's uncommitted state or overwriting its caches, and the admin's own
variables (`ASTROADMIN_*`, `ADMIN_*`, `SESSION_SECRET`) are removed from its environment.
It is NOT a sandbox against hostile site code: that is the hosted platform's isolation
work. Layouts it cannot reproduce faithfully are refused rather than checked
approximately: git submodules (any mode-160000 entry) and workspace packages linked back
into the repo. Three Codex rounds probed it; round 3's remaining findings assumed hostile
site code, which this boundary puts out of scope.

Why not a home-made validator as the gate: the first version re-implemented Astro's
loading, and review found it wrong in both directions (glob discovery, YAML 1.1 vs 1.2
octals, object-shaped `file()` JSON, `reference()`, locale variants). Astro is exact by
construction. Any NEW route that pushes must go through `pushIfAstroAccepts`; there is
deliberately no bare push endpoint.

The worktree gets its own `node_modules` (a symlink per package) WITHOUT dot-directories
other than `.bin`: Astro writes its content data store into `node_modules/.astro`, so
linking the whole directory would let the check overwrite the running preview's store. A
custom `cacheDir` inside `node_modules` that does NOT start with a dot would still be
shared; none of our sites set one. Hoisted `node_modules` above a monorepo site are
mirrored too. A tracked `.env` is the committed one; only gitignored `.env*` files are
copied in from the live checkout.

## Releasing

`npm publish` requires interactive browser auth — ask the user to run
`! npm publish` themselves; then tag `vX.Y.Z` and create the GitHub release.
Version semantics: npm `0.2.0 → 1.1.0` is the files-first line; git tag
`v1.0.0` is the shelved SQLite store and was **never published to npm** — don't
reuse 1.0.0. Pre-publish sanity: `npm pack --dry-run` (the `files` allowlist
must keep plans/, docs/, tests/ out of the tarball).

**Before publishing, verify the release base is not stale.** `git fetch origin`,
then confirm `git log origin/main --not main` is **empty** — i.e. every commit on
`origin/main` is already contained in what you are about to release. A non-empty
result means your local base is behind `origin/main` and a release (especially a
squash-merge onto local `main`) would silently drop those upstream fixes. This is
exactly how 1.4.0 shipped without the 1.3.x apostrophe/array data-loss guard and
renderer unification, and had to be withdrawn and re-cut as 1.4.1. A withdrawn
version number is burned on npm for 24h — bump to the next patch rather than wait.

## Testing the Astro integration / injected preview script

`integration/index.js` (the script injected into preview pages, e.g. block
focus and click-to-edit `data-aa-field` handling) is resolved by a consuming
site from **its own `node_modules/astroadmin`**, NOT from your source checkout —
even when you run the admin from source (`bun bin/cli.js dev --project <site>`,
which starts the *site's* `astro dev`). So edits to `integration/index.js` do
not reach the preview iframe until published. To test end-to-end, temporarily
copy it over the site's `node_modules/astroadmin/integration/index.js` and
restart, then restore (it's gitignored; any reinstall wipes it silently). By
contrast the admin UI (`ui/*.js`) IS served from your source, so dashboard.js /
form-generator.js changes are live on browser reload.

## A real-browser save check (before releasing a UI fix)

happy-dom tests prove the renderer and `extractFields`; only a real dashboard save
proves the wiring around them (autosave, the saver, the API write). Recipe, used
for the empty-array fix in 1.4.7:

1. Copy an affected site (`cp -cR`) and `git remote remove origin` in the copy,
   so no save or Publish can reach the real repo.
2. `ADMIN_PASSWORD=admin PORT=<port> bun <checkout>/bin/cli.js dev --project <copy> --no-astro`
   (dev credentials admin/admin; `--no-astro` skips the preview, which the save path
   does not need).
3. Drive it with Playwright: log in at `/login` (`#username`, `#password`), open
   `/dashboard/<collection>/<slug>`, type into a `[name="<field>"]` input, and wait
   for the file's mtime to change (saves are automatic and debounced; there is no
   Save button). Then read the file and assert.
4. Carry a positive control (the edited field changed on disk), and run the same
   script against the unfixed checkout to watch it go red.

Playwright may want a browser revision that is not downloaded; rather than
installing another, pass `executablePath` pointing at an existing one under
`~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/`.
