# Schema validation on save: refinements, blocks, empty optionals

Status: NARROWED and done (2026-10-17). The original ask (the site's own error
for a bad YouTube link) already worked from 1.4.8. This change keeps: content
responses without server paths, the refinement-pinning test, problem badges and
summary links on blocks (with the whole-block fix), the const binding, and two
cleanups. Every block-cleanup change was reverted, so saved output is
byte-identical to 9ef8871 (pinned by tests/blank-optional-round-trip.test.js).
Follow-ups: #68 (git routes' paths), #69 (top-level ""), #70 ("Leave this
out"). Review round 3 was not run. Released in 1.7.0 (2026-10-17, commit
d7b98da); every hosted editor runs it.

## The report

A client site has a `video` block whose `url` is
`z.string().trim().min(1).refine((v) => youtubeVideoId(v) !== null, { message: 'Paste a YouTube link, e.g. …' })`.
The reported symptoms after pasting a Vimeo link: the editor saves it without
complaint, the dev content loader rejects the entry so the preview keeps the
last good version, the message appears only in the dev server log, and on the
hosted editor the commit lands and the host's build fails. The same would
apply to every `.refine()` (safe-link checks on `href` fields, a site-relative
poster path). A Codex probe noted that the JSON Schema we serialise keeps only
`type: string`, `minLength: 1` and the description, so the browser cannot
replicate a refinement.

## What is actually true (established 2026-10-17, against `main` at 9ef8871)

### 1. Where saves go, and what evaluates the real schema

- **Local dev** (`astroadmin dev`) and **hosted** both run the same
  AstroAdmin server process: the hosted box runs the site's own
  `node_modules/astroadmin`, at the version the site's `bun.lock` pins
  (astroadmin-ops `hosts/README.md` §6). A save is
  `PUT /api/content/:collection/:slug`: the file is written, then
  `validateStoredEntry` (`server/utils/content-validation.js`) reads it back
  and runs it through `collectionSchema._zodSchema.safeParseAsync`.
- `_zodSchema` is the site's **real** Zod schema, not the JSON Schema:
  `parseAstroSchemas` bundles `src/content.config.ts` with esbuild, shimming only
  `astro:content` (re-exports the site's zod), `astro/loaders` and `image()` /
  `reference()`. The site's own imports (`./lib/youtube`) are bundled as
  written, so `.refine()`, `.superRefine()`, transforms and cross-field rules
  run exactly as the site wrote them. The JSON Schema is used for rendering
  only. The Codex observation is correct about the JSON Schema and irrelevant to
  validation.
- The response carries `validation: {status, issues: [{path, message}]}`, and
  `ui/content-problems.js` shows it as a summary plus a message under the field.
- **Nothing is committed on save.** A commit happens only on Publish, and
  Publish is gated by the site's own `astro build` of the exact commit
  (`server/utils/astro-check.js`); a refusal keeps the commit local and
  returns a 422 naming the entry and field.
- All of this shipped in **1.4.8** (622d09c). The client site's `bun.lock`
  pins 1.5.0, but its local `node_modules/astroadmin` was a stale **1.4.6**
  (never reinstalled), which has neither the save-time check nor the publish
  gate. That accounts for every local-dev symptom in the report. No editor
  commit touching the video block exists on the site's `main` (the block was
  added on 2026-10-17), so the hosted symptom was predicted rather than seen;
  on 1.5.0 the publish gate refuses it.

**Reproduced on `main`** against a disposable copy of the site (no remote),
`--no-astro`:

- API: adding `{type: 'video', url: 'https://vimeo.com/…', title: …}` as
  block 10 returns `validation.status: 'invalid'` with
  `{path: 'blocks[9].url', message: 'Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…'}`.
- Real Chrome (Playwright): the summary reads "Your changes are saved, but the
  site cannot be published until this is fixed: Blocks › 10 › Url: Paste a
  YouTube link…"; `[name="blocks[9].url"]` is `aria-invalid` with the message
  under it. Typing a YouTube URL autosaves, and the summary, the mark and the
  message clear.

### 2. Path mapping

`formatIssuePath` turns zod's `['blocks', 9, 'url']` into `blocks[9].url`,
which is the control's own `name` (the form uses one naming scheme for the
main form, block bodies and nested items). `findFieldForPath` falls back to the
nearest ancestor with a `name` or `data-field` (a whole block, a list), and the
summary always names the path. Inline arrays inside blocks follow the same
scheme. Items edited in the array item modal live in a hidden JSON input, so
an issue inside one lands on the list (`data-field`), which the summary
qualifies with the full path ("Blocks › 3 › Items › 2 › Title").

**Gap found:** blocks render collapsed. The message is on the right input,
but the input is hidden until the editor opens block 10, and the collapsed
block's header shows nothing (checked: no `has-problem` on or in the header).
The editor sees "Blocks › 10 › Url" in the summary and has to count blocks.

### 3. `""` in an optional field with `.min(1).optional()`

`cleanEmptyValues` (`ui/form-generator.js`) drops a DOM-produced `""` only
when the schema proves the key optional **and the value is not inside a block**
(`!isBlockItem`). Checked directly: for
`{caption: '', blocks: [{type: 'video', url: 'x', caption: ''}]}` it removes
the top-level `caption` and keeps the block's. So blanking an optional field
in a block still saves `""`, which fails `.min(1).optional()`. Since 1.4.8 that
no longer breaks a build (the save warns, the publish is refused), but the
warning reads "Too small: expected string to have >=1 characters" for a field
the editor meant to leave empty, and the only fix open to them is to type
something. The `isBlockItem` exclusion dates from before blocks resolved their
own schema through `blockTypes`; `isRequired` now protects required keys inside
blocks the same way it does at the top level. The site worked round it with
`optionalText = z.string().trim()`.

## Options

**A. Upgrade the site; change nothing in AstroAdmin.** Reinstall
(`bun install`) so local dev runs the locked 1.5.0, or better, take 1.6.x with
the ops#9 rollout. Covers every symptom in the report. Leaves gaps 2 and 3.

**B. A + targeted fixes for the gaps found (recommended).**
1. A pinning test: a refinement's own message reaches the save response at the
   right path, through the real schema parser and real zod 4 and zod 3, in a
   block and a block's nested item; a `.superRefine` cross-field issue lands on
   its path; a transform-only schema stays valid. Positive control: a valid
   save is `valid`. Nothing pins this today (only `stand-in-marks` uses
   `.refine`, incidentally). It cannot be red-first on `main` because main
   already passes. Show it red by mutation (validate against the JSON Schema
   instead of `_zodSchema`, which is exactly the regression it guards against)
   and against 1.4.6.
2. Problems inside collapsed blocks: mark the block header (`has-problem` and a
   short "1 problem" badge), and make each summary line a button that expands
   the block (and its ancestors) and focuses the field. Red-first in happy-dom
   (`content-problems.test.js`): the header carries the mark, and a click on
   the summary expands block 10 and focuses `blocks[9].url`. Then the real
   browser run.
3. Empty optionals inside blocks: drop a DOM-produced `""` inside a block when
   the block's resolved schema proves the key optional, as at the top level.
   Untouched fields are unaffected (bound values are restored and skipped by
   `kept`). Red-first in `extract-fields.test.js`: blank a block's optional
   `.min(1)` caption, and it is absent rather than `""`. Required block fields
   keep their `""` placeholder (control). This changes saved output only for a
   field the editor has blanked, and only by omitting it.
   *(Corrected after review round 1: as first built this was wrong on two
   counts. The rule also cleans a NEW block's empty optional fields, which
   nobody blanked; and optional does not make `""` and absent the same, so
   `.default('x')` cleared became `'x'` and a valid `""` vanished. It was
   narrowed: see "Review round 1".)*

**C. Refuse a save that fails the schema (422).** Rejected. It loses
half-finished autosaved edits (the reason saves only warn), and nothing is
committed on save anyway: the commit happens at Publish, which is already
gated exactly.

**D. Validate in the browser.** Rejected. The real schema is site code, and
the server already runs it per save; a browser copy would be the serialised
approximation the report warns against.

**E. Run the collection through Astro's own tooling (`astro sync`, the content
layer) on save.** Rejected for saves: seconds per save against milliseconds,
and sync passes some things the build refuses (a missing `image()` file). The
publish check already uses Astro itself, where exactness matters.

## Recommendation

B. The report's main ask, that the site schema's own message appears on the
field at save time and a breaking save is held back, is already met from
1.4.8 on, and is now verified in a real browser against a copy of the site.
The work left is the version on that site, a test so the guarantee cannot be
lost silently, and the two gaps above.

## Coverage

- Local dev: covered once the site runs >= 1.4.8.
- Hosted: the same server code, at the version in the site's `bun.lock`
  (1.5.0 today: save warnings and the publish gate both present). The B fixes
  reach hosted editors only with the next release and its rollout (ops#9).

## Acceptance (from the brief, adjusted to the findings)

- The Vimeo case returns the schema's message at `blocks[N].url` (pinning
  test; shown red by mutation, since main is already green).
- A valid save stays `valid`; a refinement-free schema's saves are
  byte-identical (B2 changes rendering only; B3 was reverted after review
  round 2, so blank optionals save exactly as before).
- Real browser against a copy of the site: paste Vimeo, see the error on the
  field (with B2, from a collapsed block via the header or the summary), fix
  it, the save clears it. Screenshots before and after.
- No release without asking.

## Outcome (2026-10-17)

- **B1** `tests/schema-refinements.test.js`: 10 checks per zod version, zod 4
  and zod 3, through the real app. Seen red by mutation: with
  `z.fromJSONSchema(collection.schema)` in place of `_zodSchema`, all four
  refinement checks failed on both versions and the three controls held.
  zod 3 accepts only plain objects as discriminated-union options, so the
  cross-field rule sits on an object inside the block.
- **B2** `ui/content-problems.js`: a block holding a problem gets a red outline
  and an "N problems" badge in its header, counted by issue path (so an issue
  whose field falls back to the whole list still counts for its block).
  Summary lines that find a field are buttons: `goToField` opens the
  collapsed block around it (`revealField`), then scrolls to and focuses it.
  Click-to-edit's `focusEditorField` uses the same helper. Red first in
  happy-dom. (As first built it opened nested blocks too; blocks cannot nest,
  see "Review round 1".)
- **B3** `cleanEmptyValues`, as first built: the block-item exemption was
  removed, so every optional `""` and `{}` in a block was dropped. Review
  round 1 found that wrong; see below for what replaced it.
- **filePath**: GET, POST, PUT and DELETE name the fields they send
  (`entryForEditor`, `locale`) instead of spreading the store's result, which
  carried the absolute path as `filePath` (and `deleted` on a delete). All
  four route checks were red on the old routes. The UI read neither field.
- Real browser (Playwright, headless Chrome) against a copy of the client site
  with its remote removed, running the admin from this checkout: the collapsed
  video block shows "1 problem"; the summary line opens it and focuses the url
  field, which carries the site's message; a YouTube link saves and clears
  every mark; a typed caption saves and a blanked one is saved as absent. The
  same script against unmodified `main`: no badge, no summary button, and the
  save response carried `filePath`.
- Every server-less test file passes (67 files; `api.test.js` still needs a
  running server, issue #2). `focus-editor-field` now runs the real
  `goToField` beside the extracted function.
- Not covered by this work: the hosted editors, until the next release and its
  rollout (ops#9).

## Review round 1 (Codex, 2026-10-17) and what changed

Brief and review: astroadmin-ops `devex-review/2026-10-17-schema-save-review-1*`.

- **P1a, an untouched stored literal lost** (reproduced): a stored `''` in an
  optional `z.literal('')` was dropped when a sibling changed. Constant inputs
  were not bound, so they had no stored value to keep. Already true at the top
  level before this work. Fix: const inputs are tracked (`binding.constants`);
  a value stored at the path is kept, and with nothing stored the schema's value
  is used, so a missing required id is still written. Red first in
  `extract-fields` (top level and in a block).
- **P1b, optional is not "empty means absent"** (reproduced): `.default('x')`
  cleared became `'x'`; a valid `""` became absent. First fix: inside a block,
  drop an optional `""` or `{}` only when it fails the field's own JSON Schema
  (`emptyValueFails`). Round 2 showed that cannot work (below), and it was
  reverted. The top level is
  unchanged (it drops every optional `""`): issue #69.
  `tests/blank-optional-round-trip.test.js` compares, byte for byte through
  the real app, what the previous renderer, this one and an unconditional-drop
  mutant write for a schema matrix and four scenarios. An unedited entry
  cannot tell them apart (every value is restored), so it is the positive
  control; a new empty block and cleared fields tell them apart, and went red
  with the rule made unconditional.
- **P2, the accordion and nested blocks:** blocks cannot nest. The parser finds
  block lists only outside a block, so a union inside a block is not drawn as
  one, and the client site has no nested block lists either. `revealField` was
  simplified to the one collapsed block. `tests/block-reveal.test.js` runs on a
  fixture derived from the client site's real schema and content (scrubbed for
  this public repo).
- **P2, git routes:** paths outside a site in a subdirectory of its repo, in
  status and pull. Not fixed here: issue #68.
- **P3, stale summary buttons:** a line whose block was deleted is disabled.
- Test gaps closed: full validation on GET; POST proved before DELETE; reserved
  response keys checked structurally; temp folders removed on any exit.
- Cleanups: unused imports in `server/api/collections.js`; redundant
  `schema.default ??` in `createEmptyBlock`.

## Review round 2 (Codex, 2026-10-17) and what changed

Brief and review: astroadmin-ops `devex-review/2026-10-17-schema-save-review-2*`.
Codex ran the tests itself (workspace-write, its own TMPDIR) and changed no
file in the repo (checked by checksum).

- **`emptyValueFails` dropped valid values** (reproduced): `z.coerce.number()`
  (`''` is 0), `.min(1).catch('x')`, `z.preprocess` and zod 4's `.base64()`
  serialise as stricter than they are. The serialised schema cannot say which
  `""` the site's zod refuses. Decision: stop inferring. Block cleanup is back
  to exactly what it was before this work (every `""` in a block kept), and
  `tests/blank-optional-round-trip.test.js` requires the previous renderer's
  bytes in every scenario, the coerce and catch cases added. An editor-chosen
  "Leave this out", gated on the real zod verdict, is issue #70; meanwhile
  `docs/content-collections.md` tells site authors to accept `""` in optional
  text fields. The `.min(1).optional()`-in-a-block case is therefore NOT fixed
  by this change: the editor is warned and publishing is refused, as before.
- **A whole-block problem** (`blocks[1]`, a block-level refinement): its
  summary line went to the blocks list. It now goes to the block (opening it),
  and is disabled once the block is deleted. Red first in content-problems.
- The non-reserved email fixture went with the reverted tests; none remain.
- A stale comment on const inputs was corrected.
- Confirmed correct by Codex: the const binding (reorders, type swaps, item
  modal, top-level arrays); blocks cannot nest; the stale-line guard; the
  test-gap fixes and cleanups.
