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

**Untouched fields keep their stored values.** Every save rebuilds the entry from the form, and
a control cannot always reproduce what it shows: a null is an empty box, a `{collection, id}`
reference is its id, a datetime with an offset is UTC to the millisecond. So a form rendered
from stored data is bound to it (`bindOriginalValues(container, original)`, straight after
render and widget setup, before any edit): every named control's path and LIVE value (its
baseline, so browser normalisation is absorbed) and every container's path and controls
(`[data-object-field]` objects, `[data-array-items]` lists, block and inline-array items). At
extraction an unchanged container yields its stored value whole, an unchanged control yields
the stored value at the path it was rendered from, and only changed ones are read from the
DOM. Elements are tracked by identity, so a reordered item keeps its values; an element added
after binding (a new block, card or reference) is read from the DOM. The dashboard binds a
loaded entry (never a new one); the item modal binds the item it was opened with. A new
surface that renders stored data must bind it, or every lossy value is rewritten on the next
save. Edited controls still need their own rules: a cleared nullable saves null, a chosen
reference saves its id, a real `z.date()` with a date-only value is a date input.
Three corollaries. (1) **Cleanup (`cleanEmptyValues`) touches only what the DOM produced**:
`applyOriginalValues` returns the paths it restored and cleanup skips them, and the items of
a JSON-backed card list are final (the item modal saves through `extractItem`, the same
read-restore-clean rule, so it is not cleaned again; a NEW item is opened unbound, so its
placeholders are cleaned). (2) **Rows are tracked, not just controls**: a MutationObserver
from `bindOriginalValues` marks a list whose rows were added, removed or moved, so a row
with no bound control (only a `z.literal`) counts, and a list emptied by the editor saves
its DOM value even when it matches the stored one (an optional emptied list is then
dropped, which is how a stored invalid `[]` gets unset). (3) **A widget's clear button
records intent** (`setWidgetValue`, `data-cleared`): a hidden input's `defaultValue`
follows its value, so in an unbound (new) form nothing else tells "cleared" from "never set".
Verify a change here in a real browser too (recipe below): Chrome normalises values that
happy-dom does not (`datetime-local` `.100` reads back as `.1`).

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
   It also means registering it with `ui/modal-stack.js` (`pushModal` on open, `removeModal`
   on every close): ONE document listener sends Escape to the topmost open modal only. A
   modal with its own document Escape listener closes along with whatever sits above it,
   and a closed gallery or item editor discards its unsaved edits (#35).

When changing overlay/stacking behaviour, verify with `document.elementFromPoint()` — asserting
the element exists proves nothing, since the bug is precisely that a present element is covered.

### Error text an editor sees: an allowlist, not a scrubber

An API error response NEVER carries `error.message` (or stderr, or a command line): each route
sends a fixed, route-specific message ("This entry could not be saved; see the server log.")
and logs the error with `console.error`. The exceptions are refusals that are the editor's to
fix and whose text we wrote without server data (`ContentPathError`, `GitRequestError`, an
image `status = 400` refusal, multer's own messages, the missing-git-identity advice).

BUILD output is no exception: no text of it reaches a response either
(`server/utils/build-failure.js`). The publish check's 422 is built from structured parts:
the error CODES in the output (`[ImageNotFound]`, `InvalidContentEntryDataError`, a bare
identifier) mapped to sentences we wrote (`describeCode`; an unknown code reads "Astro refused
the build (<code>); see the server log"; none, a fixed sentence); the refused ENTRIES; and for
each entry, AstroAdmin's own validation of its text AT THE CHECKED COMMIT (`git cat-file`,
then `validateCommittedText` against the commit's OWN schemas, parsed from the check's
worktree and never through the live schema cache: field paths, messages, `accepted` values).
An entry is named only when it is CONFIRMED in the checked commit, else the editor gets the
code's sentence and no entry: a `Location:` under the check's site directory that is a
committed regular file of a collection (and, inside an id error, of THAT collection; it wins
over the id); an Astro id (whole, up to "data does not match", so `Jane Doe` keeps its space)
that exactly one committed entry has, with a frontmatter `slug` overriding the file name as
in Astro's glob loader, and a `file()` item by `(id ?? slug)`; or, for `[ImageNotFound]`, an
entry whose OWN image reference (an `image()` field, or a markdown body image as the site's
own markdown processor collects it) is that path and resolves `./`/`../` from the entry to a
path absent from the commit. When the commit's schemas cannot be loaded (20 s cap), entries
are listed with `validation: 'unchecked'` and no schema issues, never the live schema's. A production build and
the build routes return status plus the same code sentences; build responses describe the
command ("the site's production build"), never the configured command line; a deploy
response carries chosen status fields (`deployResultForEditor`), never adapter output. The
raw output goes to the server log; `checkHeadWithAstro`'s `rawOutput` is for the server and
tests only. The doctor CLI prints a failed build's raw output to its own stderr (the site
owner's terminal); its report carries the sentences. Six review rounds found a new leak or
over-redaction in every version of "show the output with server paths removed or hidden"
(a sibling `/srv/site,backup`, Windows paths, mount points absent locally, a zod enum of
`'/home/about'`): do not reintroduce any free text from a build or git.

## Testing

Tests are standalone scripts under `tests/`, run individually (there is no test
runner aggregating them). Most run server-less and need env vars:

- **Run them as `bun tests/<file>.js`, never `bun test <file>`.** `bun test`
  sets `NODE_ENV=test`, which every spawned `astro build` inherits, so
  `import.meta.env.DEV` turns true in a build. The 1.8.3 release run failed
  this way.
- **Dev-only component behaviour gates on `import.meta.env.MODE ===
  'development'`, never `DEV`.** `MODE` follows the command (`dev` or
  `build`); `DEV` follows `NODE_ENV`. Measured on Astro 7.3.8: a build with
  `NODE_ENV=test` has `DEV=true`, and `astro dev` under `NODE_ENV=production`
  has `DEV=false`, which broke the hosted preview's image endpoint until the
  module set `NODE_ENV=development`.
- **In a fresh checkout or worktree, install with `npm ci`, not `bun install`.**
  The repo's lockfile is `package-lock.json`. bun resolves a different tree
  (e.g. a top-level `cookie@0.7.1`) and the site-building tests fail with
  `Export named 'stringifySetCookie' not found`.

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
  quotes, markup), the input-type-carries-schema-type rule (including `integer`, nullable
  `anyOf` members, and integers in arrays, objects, blocks and the item modal), that a value
  of an unexpected type renders as text rather than crashing the entry, which string names
  are one-line inputs, and the alt-collision rules.
  The read-back half (`extractFields`/`extractFormData`) is covered separately, below.
- `bun tests/extract-fields.test.js` — the read-back half, in a happy-dom `<form>` rendered by
  the real `generateForm`. Covers zero-item arrays (blocks, references, inline arrays) saving
  as `[]` rather than vanishing, paths after a block/item is deleted, and a page round trip.
  The rule it pins: an empty array survives `extractFormData` only when its key is REQUIRED;
  an empty array the schema proves optional is dropped (`[]` fails `.optional().min(1)`),
  inside block items too. A `""` the DOM produced in a key the schema proves optional is
  dropped at the top level (every optional `""`; whether that is right is #69) and KEPT
  inside a block. Do not narrow or widen that by reading the JSON Schema: it cannot say
  which `""` the site's zod refuses (z.coerce, .catch(), z.preprocess and zod 4's
  .base64() serialise as stricter than they are), and optional does not make `""` and
  absent the same (`.default('x')` fills absent in). An editor-chosen "leave this out",
  gated on the real validation, is #70. A const (`z.literal`) input is not the editor's,
  but a value STORED at its path is kept when a sibling changes (`binding.constants`);
  with nothing stored, the schema's value is used.
- `bun tests/blank-optional-round-trip.test.js` — that block rule, through the real app,
  zod 4 and zod 3: a block holding `.min(1).optional()`, `.optional()`, `.default('x')`,
  `z.literal('').optional()`, an enum with `''`, `z.coerce.number().optional()`,
  `.min(1).catch('c').optional()` and an optional object is saved with nothing edited, a
  sibling edited, a new block left empty and every field cleared, by `ui/` at
  `BLANK_OPTIONAL_BASE` (default 9ef8871, `git archive`), by this checkout and by a mutant
  (the block exemption removed). This checkout must write the base's bytes in every
  scenario; the mutant must differ somewhere (else the comparison is blind). Seen red
  with the exemption removed from the real file. ~3 s.
- `bun tests/date-marker.test.js` — the schema parser's `x-astroadmin-date` marker for zod 3
  (`zod/v3`) and zod 4: a real date is marked through optional/nullable/default/catch, union
  and discriminated-union branches, intersections, objects and arrays; date-format strings
  are not. zod 4 marks through its serializer override; zod 3 through `markZod3StandIns`, which
  must walk every wrapper beside its JSON Schema (it once skipped unions, so a new date in a
  `z.union([z.date(), z.null()])` field was written quoted and failed the schema).
- `bun tests/stand-in-marks.test.js` — the image() and reference() stand-ins keep their marks
  (`x-astroadmin-image`, `referenceCollection`) through describe/nullable/optional/default/
  nullish/one-option unions, in arrays, objects and block options, for zod 3 (a site whose
  `zod` is zod 3) and zod 4. zod-to-json-schema's postProcess skipped the inner node of a
  nullable primitive, so zod 3's `image().nullable()` lost its mark; `markZod3StandIns` walks
  the zod schema beside its JSON Schema instead. The image() helper is built with the zod the
  config resolves (the project's), not astroadmin's own.
- `bun tests/content-validation.test.js` — the editor's schema WARNINGS: what a stored entry
  is judged as (dropped required array, nested block field, quoted vs unquoted YAML date,
  `file()` items, an EMPTY required `image()` — the bundled stand-in is `z.string()`, so ''
  passes it while the build refuses it; an empty optional image is not reported), that
  `z.coerce.date()` is `format: 'date'` in a `glob()` and a `file()` collection, and that a
  save still writes invalid content and reports why. Also: a bigint literal's accepted value
  (`1n`) formats without throwing, a YAML error's line is the FILE's line, and with no
  schemas at the commit nothing is checked against a schema.
- `bun tests/save-body.test.js` — a markdown entry's body survives a save: the editor shows
  the body whatever the schema (it used to hide it when the schema had `blocks`, and the save
  then wrote `body: ''`), the save payload carries `body` only when the form shows one
  (`ui/save-payload.js`), and the API keeps the stored body when a save has no `body` key
  (an explicit `''` still clears it). Real `createServer()` app, plus happy-dom.
- `bun tests/publish-check.test.js` — the publish gate, against this repo's real Astro: a
  throwaway site with a bare remote; invalid content is committed but not pushed, the commit
  (not the working tree) is what is checked, a rebase onto the remote is checked as
  combined, unstaged saves (edits of tracked files) are committed BEFORE the pull so they
  land on a remote that moved on (#57), a conflicting rebase is aborted and refused with a
  409 (the checkout back on its branch), a missing `image()` file is refused, only the checked commit is pushed (not
  other configured refs, even with a same-named tag), a failed push is reported as NOT
  published, a timeout settles even when a descendant daemonises, gitlinks and workspace
  links are refused, a tracked `.env` stays as committed, `build.production` is honoured,
  the admin's secrets are not in the build's environment, the 422 carries a code sentence and
  our validation of the refused entry (an Astro id such as `bad-page` resolved to the editor's
  `Bad Page`), and the site's own `node_modules/.astro` is byte-identical afterwards. Takes
  ~1-2 min (each publish runs a full `astro build`).
- `bun tests/publish-sync.test.js` — publishing onto a site repo someone else also pushes to
  (#57), over HTTP through the real app with a trivial check (~5 s): the commit route
  (autoPush) rebases unstaged saves onto a moved remote and reports the rebased hash; a
  conflicting rebase is aborted and refused (409) on both routes, with no path or git text
  anywhere in the body; a rebase (stopped, or its state left on an attached branch), merge or
  unmerged files left by someone else are refused (409, `committed: false`) before anything
  is staged and left as they were (aborting an earlier rebase reset the branch to ITS start
  and dropped the new commit); an inherited `rebase.autoStash` leaves no markers; and a save
  arriving mid-rebase waits, so the abort's hard reset cannot discard an acknowledged save;
  likewise a save during `/api/git/pull` and an image-details update during publish's commit
  (the details the rebase brings in survive). Timed by barrier hooks the test releases, never
  by sleeps, and each asserts the waiting request is still pending. An upload in progress is
  never in the site (publish commits none of it; the finished image is installed whole; its
  staging folder is removed), and an abandoned upload leaves nothing and holds up nothing. Each check was seen red on the unfixed code.
- `bun tests/checkout-lock.test.js` — `server/utils/checkout-lock.js`: writes share the
  checkout, the exclusive hold waits for running writes and later writes wait for it, a
  failure releases either, nested writes run (reentrant), the exclusive hold from inside a
  write is refused, and a continuation outliving its write takes its own hold. Each check
  has a 3 s deadline, since a lock bug shows as a deadlock.
- `bun tests/publish-refusal-reasons.test.js` — what the 422 says, from REAL failing builds:
  (i) a zod enum of `'/home/about'`-style values (entry, field, `accepted` values from our
  validator), (ii) a missing `image()` file (entry and field, found by the committed text),
  (iii) an MDX syntax error (SKIPPED, and says so, unless `@astrojs/mdx` is installed here;
  it passed against Astro 7.0.5 + @astrojs/mdx 7.0.1 on 2026-10-11), (iv) invalid frontmatter
  YAML (our parser's line), plus a locale file (`homefr` -> `home (fr)`), a nested id, a data
  entry's invalid JSON, and an entry fixed on disk but not in the commit (the commit is what
  is reported). Each: no server path or Astro text in the body, and the raw output in the
  server log. Then WHICH entries are blamed, each with a negative control (the healthy entry
  is not listed): a missing image only on the entry whose own folder lacks it (not a sibling
  folder's entry that has it, not prose or code naming it), a `slug:` that is another file's
  name, the same with no `Location:` line, a shared id (glob and `file()`) naming nobody, a
  `file()` id with a space, a loader's own `generateId` (the Location wins), the commit's
  schema rather than a relaxed uncommitted live one (and the live cache left untouched), and
  a file the build generated (not committed) listing nothing. ~50 s.
- `bun tests/build-failure.test.js` — `server/utils/build-failure.js` on captured Astro 7 output
  (colour codes kept, paths swapped for `/srv`): codes, sentences, unknown and absent codes,
  bracketed paths that are not codes, entry keys (a `Location:` in a sibling such as
  `<site>,backup` or a `../` climb is not the site; an id keeps its own error's Location and
  no later error's), Astro's glob id for a file (a data `slug` wins), and every
  review-round leak shape producing no path. <1 s.
- `bun tests/build-deploy-responses.test.js` — over HTTP: `/api/build/status` and
  `/api/build/production` describe the build instead of the configured command (a script with
  a server path), carry no output, and a failure carries the code sentences; `/api/publish`
  with a real local rsync deploy returns `{success, adapter, dryRun}` while rsync's
  "created directory <destination>" goes to the log. ~2 s.
- `bun tests/astro-bin.test.js` — the default build commands run the site's OWN installed
  astro (`server/utils/astro-bin.js`), never a package runner: with no astro installed the
  publish check and the production build refuse and a fake `bunx`/`npx` first on PATH is
  never called; with the package but no `node_modules/.bin`, the check still builds. ~5 s.
- `bun tests/live-url.test.js` — page path -> live-site URL (`ui/live-url.js`), shared by the
  header's "View live site" link and the server's live-status check: base paths, query/hash,
  and escape attempts (`//host`, `/\host`, `javascript:`, and paths that only normalise to
  `//host`, such as `/.//host`) falling back to the site root.
- `bun tests/clean-nullable.test.js` — `cleanEmptyValues` reads through a nullable wrapper
  (both converters' shapes), so an emptied optional array inside a nullable object is dropped.
- `bun tests/modal-escape.test.js` — Escape closes only the topmost modal (happy-dom, the real
  buttons): the image library over the gallery (the gallery keeps its edit and Save writes
  it), over an item editor with focus still on Browse, nested item editors, the expanded
  textarea over an item editor; and Escape with one modal open still closes it. Seen red
  (5 of 8) on the per-modal listeners.
- `bun tests/gallery-structural.test.js` — a gallery add/remove/reorder made in its modal marks
  the field (`data-structural-edit`), so adding an image and removing it leaves an optional
  `.min(1)` gallery unset instead of restoring a stored `[]`; an unchanged save keeps it. Real
  buttons in happy-dom, fetch stubbed.
- `bun tests/preview-cache-bust.test.js` — preview reloads and polls add `t=<timestamp>` through
  `withCacheBuster` (`ui/cache-bust.js`), never `'?t='` by hand: a URL that already has a query
  (the component preview's `?field=`) must keep it, or the block renders empty.
- `bun tests/publish-failure.test.js` — a publish that fails outright (500) tells the editor why:
  a real "Author identity unknown" from git becomes the fix (set user.name/user.email), any
  other error is the fixed "Publishing failed; see the server log.", and the toast shows that
  message. A real failing `build.production` comes back as `buildResultForEditor`: success,
  duration, a fixed `error` (never `Command failed: <command line>`) and the code sentences;
  its output only in the log.
- `bun tests/publish-refusal-paths.test.js` — the 422 refusal names no server path, through the
  real publish handler: a real `git worktree add` failure in a site whose git directory lives
  elsewhere (`--separate-git-dir`) gets a fixed sentence; a "build" printing every leak shape
  from review rounds 2-6 (spaces, quotes, backticks, `file://` `%20`, `../` climbs, symlinked
  roots, query strings, `<root>,backup`, `C:\`, `D:/`, `/app`, `/data`, an rsync destination,
  a command line) beside Astro lines whose id, `Location:` and image path are server paths
  gets codes and our sentences only, together and one leak at a time; the text is in the
  server log. On the pre-change code 8 of the single leaks reached the body.
- `bun tests/error-paths.test.js` — API errors send a fixed, route-specific message, over
  HTTP: an image() preview whose file vanishes after its stat() (sendFile's callback, not the
  error middleware), an unreadable `/images` file (the app error middleware), upload, delete,
  metadata and content writes on a read-only folder, and a content config that does not
  bundle (reload-schemas, content GET/PUT). Each check asserts the exact body, that no server
  directory name is in it, and (positive control) that the server log has the original error,
  path and all. The admin runs BESIDE the site (cwd `admin-cwd/`, site `site-a/`), so esbuild
  names `../site-a/src/content.config.ts`, which only the log may carry. Refusals that are the
  editor's to fix (a file type, an undeclared collection, a missing entry) keep their own
  path-free text.
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
  name, must survive a reload's percent-encoded pathname). No `ui/*.js` file hand-builds a content,
  dashboard, collection API or virtual-page URL; a "New..." choice keeps a collection name
  with a colon whole.
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
- `bun tests/ui-escaping.test.js` — server data rendered as markup stays data (happy-dom): a
  file name, slug, image name, commit message or stored value such as
  `a"><img src=x onerror=alert(1)>.md` renders as that literal text or attribute value and
  injects no element, in the changes panel, diff modal, image library, reference picker,
  number field and the dashboard's virtual-page panel. Every interpolation of such data goes
  through `escapeHtml` (`ui/escape-html.js`); the markdown body textarea too, or `&lt;`
  in a body is decoded to `<` and `</textarea>` truncates it on the next save. Pinned by behaviour: the real
  `renderEditor` (extracted, loaders stubbed) must leave `textarea.value` byte-identical to a body
  holding `&lt;b&gt;`, `&amp;`, `</textarea>` and `<script>`.
- `bun tests/image-symlink.test.js` — the image() picker never reads or writes through a
  symlink out of the project: a public or src/assets image that links outside, a public
  image folder that is a link out, and a src/content/assets destination that is a link out
  (entry-value copy and `?for=image-field` upload) are 400s that name no server path, and
  the sentinel outside is never copied in or written to. `assertImageInside` in
  `server/api/images.js` (assertContainedPath against the folder AND the project root).
- `bun tests/image-astro-fields.test.js` — image() beyond the plain case, with a real
  `astro build` (~10 s): the stand-in is marked `x-astroadmin-image` (IMAGE_MARKER), which
  survives `.describe()`, `.optional()`, `.nullable()`; an array of `{src: image(), alt}`
  is edited as array cards (item modal, entry-relative picker), not the gallery editor,
  and the value builds; a relative value previews through `GET /api/images/entry-file`,
  resolved against the entry's own directory (src/assets vs src/content/assets files
  with one name), contained in `src/`, refusing escapes, non-images and no session.
- `bun tests/git-paths-scope.test.js` — `git.paths` entries that mean the project root (`''`,
  `./`, `.`, `src/..`) are dropped by `getAllowedGitPaths`, so they scope nothing, like `[]`:
  empty changes diff, package.json refused for diff and revert, absent from status; a real
  entry beside them still works.
- `bun tests/cross-origin.test.js` — every state-changing `/api` request (save, delete, upload,
  revert, commit, publish, login, logout) from another origin is a 403 that changes nothing on
  disk (`Sec-Fetch-Site: same-site`/`cross-site`, a foreign or `null` Origin, another port),
  with a same-origin positive control per route, GETs unaffected, form bodies no longer parsed,
  and the origin rule behind a proxy (Host + X-Forwarded-Proto, or ALLOWED_ORIGINS).
  `server/utils/same-origin.js`. SameSite=Strict is per SITE: the hosted preview subdomain
  receives the session cookie.
- `bun tests/content-round-trip.test.js` — a save changes only what the editor changed
  (`server/utils/content-format.js`): existing keys keep their place (a file() entry's `id`
  too), untouched file() entries and frontmatter keys stay byte-identical, inline JSON
  arrays stay inline, an unquoted YAML date stays an unquoted Date (a quoted one stays a
  string), a NEW value in a schema date field is written as an unquoted date, and a new
  entry in a JSON-only glob() collection is a `.json` file. Every preserved rendering is
  parsed back and compared; on any mismatch the plain serialisation is written.
- `bun tests/cli-dev.test.js` — `astroadmin dev` starts Astro on the port in
  `preview.url` (warning when it cannot), and stopping it frees that port even when
  Astro 7 detects an agent and would daemonise (`--ignore-lock`). ~15 s; ports 3727,
  3728, 4727, 4729.
- `bun tests/rate-limit.test.js` — production-mode /api limits (server/utils/rate-limit.js):
  a signed-in session's burst of 150 passes (own budget, `sessionMax`, keyed by a session
  digest); not signed in and every login attempt keep 100 per address; a 429 is JSON with
  Retry-After. `bun tests/api-response.test.js` — the dashboard's `readJson`
  (ui/api-response.js) turns any 429 or non-JSON body into a readable error, and no ui/
  file calls `.json()` itself. `bun tests/login-log.test.js` — a login logs a session
  fingerprint, never the session ID.
- `bun tests/dev-toolbar.test.js` — the integration hides Astro's dev toolbar in the
  preview AstroAdmin runs (ASTROADMIN_PROJECT_ROOT naming the site: `astroadmin dev`, the
  hosted preview unit) and nowhere else (plain `astro dev` is the positive control). Real
  Astro 7.3.8 from the packed tarball; ~25 s; ports 3741, 4741-4745.
- `bun tests/doctor-cross-device.test.js` — the doctor's build with TMPDIR on another
  filesystem (an hdiutil disk image; macOS only, says NOT RUN elsewhere): no EXDEV. ~15 s.
- `bun tests/route-detection.test.js` — auto-detected preview routes are only declared
  collections (no `slugs -> /{slug}` guesses), and `teamIds` finds a collection named `team`.
  A schema load started before a `clearSchemaCache` never caches its (old) result, and its
  failure never clears the newer load's promise (controlled promises through
  `setSchemaParserForTests`, then the real route cache).
- `bun tests/component-preview.test.js` — the integration's `/component-preview/` route in
  a real `astro dev` (Astro's dev() API, port 4728): no `src/styles/global.css` needed,
  props spread and as `block`, `?field=`; a nested entry id (`regional/ada`) reaches the
  component whole, and an id's `?`/`#` survive (the route decodes the raw path, since Astro's
  param is only decodeURI'd). An id holding the route's own name
  (`regional/component-preview/ada`) is that id: the prefix is the site's `BASE_URL` plus
  `component-preview/` at the START of the path, checked with and without a `base` (a
  second dev() on the next port). ~15 s; `COMPONENT_PREVIEW_PORT` overrides the port.
- `bun tests/content-problems.test.js` — the editor side (happy-dom): issue paths finding
  their fields, marks clearing, marks never leaking into `extractFields`, the refusal panel
  (a link opens the translation it names: `pages/home (fr)` selects French first). Blocks
  render collapsed, so a block holding a problem (counted by issue PATH under the block's
  own) shows "N problems" in its header, and each summary line that finds a field is a
  button that opens the collapsed block around it (`revealField`) and focuses it
  (`goToField`, which click-to-edit uses too); a problem on a whole block
  (`blocks[1]`, a block-level refinement) goes to that block, not the list; a line whose
  block was deleted since is disabled. Blocks do not nest: `findDiscriminatedUnions` does not descend into a union's
  options, so a union inside a block is not a block list.
- `bun tests/block-reveal.test.js` — the same on a real site's schema and content
  (`tests/fixtures/derived-blocks-site`, derived from a client site: its blocks and pages
  collection with comments removed and example strings made generic, a page with its text
  replaced, plus a Vimeo video block), through the real parser, enrichment, validation,
  renderer and handlers: the badge, the accordion closing the open block, focus, an item
  problem inside a block, and a deleted block's line. Seen red with HEAD's
  content-problems.js (4 of 5) and without the deleted-block guard.
- `bun tests/schema-refinements.test.js` — a save is judged by the site's REAL zod schema,
  not the JSON Schema the form is drawn from (which drops `.refine()`): through the real
  `createServer()` app, for a site on zod 4 and one on zod 3 (a child process each), a
  refinement whose rule lives in a module of the site's own gives its own message at
  `blocks[1].url`, on an item in a block, a cross-field `superRefine` at the path it names,
  the same on GET; a valid save is valid and a refinement-free collection saves as before.
  Seen red by validating with `z.fromJSONSchema(collection.schema)` instead (the refinement
  checks failed, the controls held). Also: no content response (GET, POST, PUT, DELETE)
  carries a server path; routes name the fields they send (`entryForEditor`), never spread
  the store's result, which holds `filePath` (and `deleted`). ~3 s.
- `bun tests/date-round-trip.test.js` — a date-time through render -> `extractFormData` ->
  serialiser, three saves in a row, for a JSON `file()` entry and a markdown entry, in
  Europe/London, America/New_York and UTC (one child process per zone, each proving its
  zone took effect). The rules it pins: a `datetime-local` input shows UTC and an edited
  value is saved as a UTC ISO string (zoneless, a JSON entry was read back as local time
  and moved an hour per save in London's summer); an unedited date control saves its
  stored text byte for byte (the form is bound, as the dashboard binds it), milliseconds
  and zone included.
- `bun tests/untouched-fields.test.js` — the untouched-fields rule (see the renderer
  section), through the real `createServer()` app and real zod 4 (markdown and `file()`
  JSON) and zod 3 (`zod/v3`) converters: a title-only edit saves a file byte-identical to
  a direct save of the loaded data, for every control kind (null strings, textareas,
  numbers as `type: [x, 'null']` and `anyOf`, booleans, enums, an absent checkbox, a
  datetime string with microseconds and an offset, image, image(), colour, single and
  list references holding `{collection, id}`, `<x>Ids`, a null gallery, a null object,
  a null array of objects, primitive arrays with null, blocks), and each value is lost
  with the form unbound. Also: blocks and cards reordered by the real drag handlers, the
  item modal and nested item modals, cleared nullables saving null, an edited reference
  saving its id, a list item with no id before others, an unknown block type kept, and a
  zod 3 `z.date()` holding a date-only value rendered as a date input and saved date-only
  after changing the day. ~2 s.
- `bun tests/untouched-structure.test.js` — the same rule for lists, cleanup and clearing,
  through the same real app and converters: editing one card in the item modal leaves
  every other card (and the edited card's untouched `''` and `[]`) as stored, in a field
  and in a top-level-array JSON entry, while an emptied optional and a new card's
  placeholders are still cleaned; rows holding only a `z.literal` are saved when added or
  deleted (also inside an untouched object); a cleared nullable list item saves null
  (zod 4 and zod 3; a nullable boolean item is three-state); a new entry's image or
  reference chosen then cleared saves null; a stored invalid `[]` on an optional key is
  left unset by adding an item and deleting it (inline list and cards), and the warning
  says so only when the key is optional. Each check was seen red by mutating its fix. ~2 s.
- `bun tests/primitive-top-level-array.test.js` — an entry that is one list of primitives
  (`z.array(z.string())`, `z.array(z.number())`, zod 3 `.int()`) is drawn as the inline
  primitive list a field is (`generateField` under `TOP_LEVEL_LIST_KEY`), not object cards,
  whose modal showed nothing and saved `"foo"` as `{0:'f',...}` (#34). Through the real app:
  each item a control of its type, untouched list byte-identical, one edit changes one line,
  add, delete, delete all. ~1 s.
- `bun tests/serializer-fidelity.test.js` — every serialiser output, preserving candidate
  and every fallback, parses back to the data and body it was given: a body that starts
  with a `---` block stays body (`matter.stringify` reparsed it, so a CRLF file moved its
  keys into the frontmatter, and invalid YAML there threw), a final keep-chomp (`|+`)
  scalar keeps its trailing newlines, and an own `__proto__` key survives `orderLike`,
  `restoreDates` and both serialisers. A markdown entry no rendering can hold is refused.

`extract-fields` also pins nullable fields: a null stays null until edited, clearing a
nullable control saves null (a nullable boolean is a Not set / Yes / No select), and an
absent optional nullable key stays absent. Its forms are bound like the dashboard's, so a
stored `[]` the editor leaves alone stays `[]` even where the schema says optional; only
an array the DOM produced (never stored, or emptied by the editor) is dropped. `save-body` also races a no-body save against a
body save through the HTTP app: the store resolves `keepStoredBody` inside the file's write
queue, so the old body is never written back.
- `bun tests/schema-references.test.js` — Astro's `reference()` parses (a string id;
  `z.array(reference(c))` a list) carrying `referenceCollection`, and `<base>Ids` resolves
  against the DECLARED collections (`<base>s`, `<base>`, `<base>es`, y->ies; nothing declared
  means a plain list). Throwaway project through the real parser, rendered and read back in
  happy-dom: the picker per reference, a single reference saving as a string, and an
  untouched `{collection, id}` or number keeping its shape.
- `bun tests/image-field-astro.test.js` — Astro `image()` fields against the real app and a
  real `astro build` (~10 s): a public `/images/...` value fails the build (control); an
  upload `?for=image-field` lands in `src/content/assets/images`; `POST
  /api/images/:filename/entry-value` returns the path relative to the entry's file (flat,
  nested slug, `file()`), copying a public upload in; the saved entries build.
- `bun tests/image-picker-astro.test.js` — the editor half (happy-dom): only an image()
  picker (`data-astro-image`) asks the server for its value, a refusal keeps the old value,
  and entry-relative paths preview from `/assets`.
- `bun tests/cms-image-packed.test.js` — `components/CmsImage.astro` from the `npm pack`
  tarball, installed (bun, real copy) into a throwaway Astro 7.3.8 site with its own `sharp`
  ^0.35.5, then `astro build` (~10 s warm; the first install needs the network): AVIF and
  WebP sources of several widths capped at the original, a JPEG fallback smaller than the
  original, `class`/`data-aa-field` on the `<img>`, a `.JPG` in a subfolder optimised,
  SVG/external URLs plain, a missing or mis-cased path failing the build by name, and an
  original wider than 2560 stopping at 2560w. Quality: each emitted AVIF/WebP/JPEG is
  byte-compared with the site's sharp re-running Astro's pipeline (rotate, resize, encode)
  at q50 and q80 (deterministic per sharp build): default 80 everywhere, `quality={50}`
  overrides, a PNG fallback gets none, and a site's `image.service.config.avif.quality`
  wins (a second build). Then `astro dev --ignore-lock` (without the
  flag Astro 7 detaches and outlives the test): a file added after start renders as the
  plain original (`data-cms-image="dev-original"`), and a malformed `%`-escape gives the
  strict error, not a URIError (~15 s).

- `bun tests/video-upload.test.js` — videos through the real upload route: MP4 and WebM
  (real ffmpeg fixtures in `tests/fixtures/video`, commands in the test header) install
  into `public/images` with `kind: 'video'` and are served with Range support; a `.mov`,
  a QuickTime file renamed `.mp4` (`ftyp` brand `qt  `), an AVIF still and an M4A renamed
  `.mp4` (ISO base media too: a compatible brand must be an MP4 one and the MAJOR brand
  must not be a still, audio or QuickTime one; an Apple M4V lists `M4A ` and is accepted), a
  Matroska `.mkv` renamed `.webm` (EBML DocType), a text file, and a video over 20MB are
  refused with our message and leave nothing; a picker's `?kind=` takes only its kind;
  an image keeps its 10MB cap (multer's limit is the video cap, so images are checked
  after); `?for=image-field`, `entry-value` and `entry-file` refuse videos. Caps and
  messages live in `ui/media-kinds.js`, shared with the editor. ~1 s.
- `bun tests/video-picker-browser.test.js` — the video picker in the real dashboard
  (Playwright, an existing headless shell; `CHROMIUM_PATH` overrides): a `heroVideo` field's
  library lists only videos and an image field's only images (the modal is SHARED, so a
  reopening must not show the last kind's items, even before its list arrives), picking
  and uploading autosave `/images/<file>`, reopening selects the field's current file, an
  oversized or wrong-kind file is refused before any request (`accept` is only a hint), an
  untouched entry is never rewritten, a wrong-kind file DROPPED on the library says why,
  and video thumbnails load only once in view (`preload="none"` until then). The video
  picker's value box is a visible text input, so the widget never depends on the stored
  value (a `youtubeVideo` holding an id is still typeable); `.url()` and `image()`
  fields ending in `video` are not video pickers, nor is anything but a string by name
  (a union holding an object crashed the entry; form-generator.test.js). A typed clear
  in a new entry saves null (untouched-structure). ~10 s.
- `bun tests/cms-video-packed.test.js` — `components/CmsVideo.astro` from the packed
  tarball in a throwaway Astro 7.3.8 site. Its browser script must be a same-origin FILE
  (`components/cms-video-client.js`, `?url&no-inline`, `<script is:inline src>`): Astro
  inlines a small component `<script>` (`shouldInlineScriptChunk`, under
  assetsInlineLimit, and a site's `vite.build.assetsInlineLimit: 0` did not stop it), which a
  site's `script-src 'self'` blocks silently in production. The built page is served under
  such a CSP and must play; seen red with the inline version. Its CSS is in `@layer
  components` (unlayered CSS beats every layer, so it overrode Tailwind v4 utilities on
  `wrapperClass`), and the button's look is on its inner face (a `button` reset in `base`
  wins when CmsVideo's CSS is met first); a layered page checks both CSS orders in the
  browser. Also: markup (muted/loop/playsinline, no `autoplay`
  attribute, the button), the poster optimised to WebP at `posterWidth`, missing video or
  poster failing the build; then in Chromium: it plays by itself, the button pauses and
  resumes it, and under reduced motion it never starts until Play, and it plays under
  `astro dev` (the preview); with `base: '/blog'`
  local paths are served under it; a value that is not an .mp4/.webm path or URL (a typed
  bare name, a YouTube page) fails the build by name. ~20 s.

`tests/git-api.test.js` used to be a known red; it passes as of 2026-10-08 (checked at
`74609bd` in a clean worktree).

`astroadmin doctor` (`server/doctor/`, docs/doctor.md) has six test files:
`doctor-coverage` (built-HTML checks on a fixture page, each shown red on a mutated copy),
`doctor-static` (config, lockfile, submodule, workspace and sharp checks on throwaway repos),
`doctor-cli` (exit codes, `--json`, `--build`, the site's installed astro and never a fetched
one; ~10 s), `doctor-publish` (the editor scans the publish check's own build in a child
process rooted at the check's worktree, so it reads the commit's entries; a scan stuck in a
synchronous loop is killed at its cap; an error is "unavailable" with a fixed reason and the
error in the server log, never a failed publish; `unoptimised-images` is command-line
only, absent from the editor scan but reported by `runDoctor`; ~15 s),
`doctor-notice` (the editor notice, happy-dom) and `doctor-images` (unoptimised `/images/`
originals in built HTML; CmsImage's prerequisites: the SITE's sharp, found by walking up
`node_modules` from the site root, never Astro's nested copy, Astro >= 7, `cssTarget`). Run each with `bun tests/doctor-<name>.test.js`.

**The doctor and the publish check use synchronous fs, never `fs/promises`.** Under Bun 1.3.4
on macOS an `fs/promises` call made while child processes start and exit can lose its completion
and never settle: the process sits at 0% CPU with no children until killed (seen as
`doctor-static` hanging about once in 60 runs, inside a `readFile` or `realpath`; reproduced
outside astroadmin with a loop of `fs.promises.readFile` plus `execFile('git')`). Both paths
run git and builds, so they read with the `*Sync` calls; `doctor-static` fails if any
`server/doctor/*.js`, `astro-check.js` or `astro-bin.js` imports `fs/promises` again.

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
   and after `pull --rebase --no-autostash` (in that order: before the commit the saves are
   unstaged and git refuses the pull, #57). The commit and the pull run in ONE exclusive
   checkout hold (`server/utils/checkout-lock.js`, `commitInCheckout`): every write to the
   checkout (content store writes, revert/restore, image writes) takes a shared hold, so a
   save waits rather than landing between the commit and the pull or mid-rebase, where
   `rebase --abort`'s hard reset would discard it. Inside the hold, an unfinished rebase,
   merge or unmerged files refuse the publish (409) before anything is staged: they are
   someone else's, and aborting an earlier rebase resets to ITS starting point. Only our own
   conflicting rebase is aborted (409). `/api/git/pull` takes the exclusive hold too. Multer
   streams an upload into its own temporary folder OUTSIDE the site, and only the complete
   file is installed under a hold (`installUpload`: copy to a hidden name, rename). Writing
   into the site as the body arrived let a publish commit 64 KB of a 256 KB image; holding
   the lock for the whole request instead stranded the hold when a client disconnected while
   waiting, and released it before multer's cleanup. Never tie a hold to a request's
   lifetime. The image metadata is changed by ONE read-modify-write under a hold
   (`updateMetadata`), never a read outside it. Shared holds are reentrant (AsyncLocalStorage), and asking for the exclusive hold from
   inside one throws: both would otherwise deadlock. A new route that writes the checkout
   must take `withCheckoutWrite` around its whole read-modify-write. Not covered:
   `git.includeDb` (a SQLite write after the commit dirties the tracked DB; #66), and build
   or deploy commands, which must write only ignored output (`dist/`) and deploy outside the
   checkout (holding the lock across a build would stall every save behind a queued publish). The whole
   thing runs under `withGitLock` (which `/api/git/pull` also takes) so
   the commit checked is the commit pushed. The push names that SHA and the branch's
   upstream explicitly (`pushCheckedCommit`), so a configured push refspec or
   `push.default=matching` cannot send unchecked refs. A failure keeps the commit local
   and returns 422 built from structured parts (the error codes as our sentences, the
   refused entries, our validation of each at the checked commit: `build-failure.js`), with
   Astro's output in the server log only. A push
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
The package's only npm owner is `cloudshipco`: logged in as another account
the publish fails with a 403 ("You do not have permission to publish"), so
check `npm whoami` against `npm owner ls astroadmin` first (`npm login
--auth-type=web` to switch). Right after a publish, `npm pack`/`install` of
the new version can say "No match found" from a stale metadata cache: use
`--prefer-online`, or fetch `npm view astroadmin@X.Y.Z dist.tarball` directly.
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
