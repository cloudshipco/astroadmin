# Codex review fixes — editor-improvements branch

Codex (gpt-5.6-sol, xhigh) reviewed `feat/markdown-body-toolbar`. No XSS found
(title path uses textContent/escaping throughout). 15 findings; James chose to
fix all, including the two pre-existing P1 races. Grouped by fix commit below.

## 1. Markdown transforms (`ui/markdown-transforms.js`) + tests

Real edge cases, all confirmed by reading the code; all affect the client's blog editing.

- **Endpoint off-by-one** (`lineRange`): a selection ending right after a `\n`
  pulls in the next line. Selecting `one\n` from `one\ntwo\nthree` and clicking
  H2 also formats `two`. Fix: when `end > start` and `value[end-1] === '\n'`,
  compute the line range from `end - 1`.
- **Blank/empty line no-op**: H2/quote/bullet/ordered on an empty body or a sole
  blank line does nothing (blank lines are always skipped). Fix: when the touched
  range is a single blank line, still apply the marker.
- **Prefix duplication in mixed selections**: ordered/bullet/quote on a partly
  formatted selection double-prefixes (`1. one\ntwo` -> `1. 1. one\n2. two`).
  Fix: strip any existing same-family prefix before applying.
- **Bold -> italic downgrade** (`wrapInline`): italicising `cat` inside `**cat**`
  sees the `*` of `**` as an italic delimiter and yields `*cat*`. Fix: when the
  marker is a single `*`, don't treat a `*` that is part of a `**` run as the
  wrapper (check the chars just outside).
- **Code block mid-line** (`codeBlock`): fencing a mid-line selection emits fences
  mid-line (renders as literal backticks). Fix: operate on whole-line boundaries,
  inserting surrounding newlines; toggle off if already fenced.

Add regression tests for every case above (watch them go red first).

## 2. Image field regression (`ui/form-generator.js`, `ui/field-widgets.js`)

`isRealImage` requires a leading slash/scheme, but `resolveImageUrl` deliberately
supports a bare filename (`hero.jpg` -> `/images/hero.jpg`), so a stored library
image with no leading slash shows "No image selected". Fix: gate previewability on
`value !== '' && !value.startsWith('placeholder:')` (reject the marker scheme,
not by allowlisting path shapes) and share one predicate between first render and
`updateImagePicker`.

## 3. Collections title perf (`server/utils/collections.js`)

`getAllCollections` lists slugs, then `getCollectionEntryTitles` lists them again
and reads every entry's full body on dashboard startup. Fix: pass the already
fetched slug list into title loading; keep it a single read pass. (Concurrency is
already `Promise.all` over a small set; leave bounded-concurrency for later.)

## 4. Dashboard state machine (`ui/dashboard.js`) — the two P1 races + related

- **P1 out-of-order loads**: add a module `loadToken`; capture it at the top of
  `loadEntry`, and after every `await` (locale fetch, content fetch,
  createTranslation) bail if a newer load superseded it, before mutating
  `currentData`/rendering/preview.
- **P1 save onto the wrong entry**: `saveContent` reads `currentCollection`/
  `currentSlug`/`currentData.type` *after* an `await`, so navigation mid-save
  POSTs the old form to the new entry. Fix: snapshot the target
  `{collection, slug, locale, type}` + formData + body synchronously at entry;
  build the URL/body from the snapshot; guard all post-save UI work behind a
  "still current" check. And **flush the pending debounced save before
  navigating** (loadEntry/createNewEntry) so a queued edit lands on its own entry
  rather than firing against the next one — needs a `debounce` with
  `flush()`/`cancel()`/`pending`, tracked in a module `activeDebouncedSave`.
- **Echo guard null-path** (P2-3): `getCurrentPagePath()` returns null for
  component-only collections; the guard normalises null to `/` and then swallows a
  genuine Home navigation. Only compare when the path is non-null.
- **message handler hardening** (P2-13): ignore messages whose `source` isn't the
  preview iframe / whose `origin` isn't the preview origin, and type-check
  `pathname` before string ops (a non-string currently throws).
- **Stale title after save** (P2-6): after a successful save, update the local
  `entryTitles`, the option text, the picker button and the header from the saved
  title. For a new entry, set the header after `loadPages()` refreshes.

## 5. Entry picker (`ui/entry-picker.js`)

- **Duplicate titles** (P2-12): render a muted slug beside a title when two rows
  would otherwise be identical, so the client can't edit the wrong one.
- **Keyboard/focus** (P3-15): handle keys at the overlay level (Escape closes from
  anywhere), trap focus while open.

## Out of scope for the client's site but noted (product gaps, deferred)

- i18n-suffixed title loading (P2-4) — site isn't i18n.
- Nested Astro slugs in the picker/content API (P2-5) — site is flat.
- Empty-site virtual-page init still opens a read-only page (P2-11).

## Follow-up review (round 2) — architectural rework

A second Codex xhigh review over the fix commits found the P1 race fixes were
incomplete (the "fix the class, not the instance" trap). Reworked, all fixed:

- **Bind each autosave to its own form + immutable target** (`makeSaver`/
  `installSaver`), reading its own form and POSTing its own entry — never
  globals. Fixes save-to-wrong-entry AND the i18n save-to-wrong-locale.
- **Serialize + coalesce saves per target** so overlapping POSTs can't let an
  older snapshot win; reorder runs one coalesced save, not two.
- **Thread the load token through renderEditor/createTranslation**, rechecked
  after their schema awaits; `loadEntryLocales` returns for a guarded assign;
  error/not-found paths bail if superseded.
- **Delete** cancels + awaits in-flight saves before DELETE and invalidates
  loads; **virtual-page** navigation flushes + invalidates.
- **Stale save UI** gated on the target still being on screen.
- **Message origin check** against the preview origin (iframe-navigated-away
  forgery). Transform round 2: code-block toggle-off + no stray blank line,
  italic idempotent over bold (`***`), CRLF/whitespace blank lines. Minor:
  clear-title cache fallback, case-insensitive placeholder, combobox aria.

## Follow-up review (round 3) — narrowing edges

A third review over the rework confirmed the core is clean and found narrower
edges. Fixed the realistic/contained set:

- **Delete target snapshot** — the DELETE URL + editor-clearing now use a
  target captured before any await, guarded by a generation token, so
  navigating mid-delete can't delete or clear the wrong entry.
- **Saver `disable()`** — a saver is made inert when its form is left/deleted,
  so the old form's own input/reorder listeners (which still reference it)
  can't queue a POST that lands after navigation or a DELETE.
- **Delete failure recovery** — a failed DELETE reloads the entry (fresh saver)
  instead of leaving the form stranded with a disabled saver.
- **Reorder double-save** — the drop handler no longer also calls `onChange()`
  after dispatching `cards-reordered` (which already persists), so a reorder is
  one save, not two.
- **Italic over a whole `**bold**` selection** now adds italic (parity applied
  to markers inside the selection too), and **code-block toggle-off** handles a
  whole-block selection and CRLF fences.

### Known limitation (documented, not fixed) — P1-3

Two saver INSTANCES for the same entry (an old detached form and a freshly
loaded one after navigating A→B→A) have independent in-flight queues. If the old
save is still mid-flight through its ~2s preview-settle delay when the user
returns to A and saves again, the old (stale) POST can land last. Closing this
fully needs a global per-RESOURCE save coordinator (a lock keyed by
collection/slug/locale shared across form instances) and generation-gated UI
effects. Deliberately deferred: it requires navigating away and back and editing
all within a single ~2s save window, and this deployment (the client's site) is
single-editor and non-i18n, so it cannot realistically occur. The `disable()`
fix already closes the common part (the old saver being re-triggered); only the
already-in-flight-at-navigation timing remains.

## Follow-up reviews (rounds 4 & 5) — converged

Round 4 caught two regressions from the round-3 fixes (a disabled saver dropped
its flushed final edit; delete captured its generation after the await) plus
transform edges — all fixed. Round 5 found NO P1s (the delete ordering, saver
loop, and normal code-block paths confirmed clean) and a handful of P2/P3 edges;
fixed the real ones:

- Delete can no longer wedge on a rejecting pending save (whole body in the
  try/finally; the pending save is awaited with `.catch()` since a failed save
  must not stop the delete).
- codeBlock CRLF cleanup only strips the orphan `\r` when the closing fence was
  at EOF (no longer corrupts an unrelated trailing line), and the restored
  selection excludes the trailing CRLF separator.

### Known minor codeBlock limitations (documented in code, not fixed)

Uncommon and non-corrupting: an UNCLOSED opening fence isn't paired (a caret
below it wraps rather than toggling); a selection spanning TWO separate fenced
blocks wraps both; a rare double-backtick inline span toggles off over two
clicks. All produce awkward-but-recoverable markup in a feature (code blocks in
blog prose) the client rarely uses.

## Verification

- `npm run test:unit` (transforms + others) — new transform tests red first.
- CDP harness: image preview for a bare filename; save-then-navigate keeps each
  entry's data; out-of-order load doesn't cross entries; echo/home nav; picker
  keyboard; title updates live after editing.

## Pre-release review rounds (2026-08) — required-field / click-to-edit hardening

Reviewing the release delta surfaced a data-loss bug and a set of over-retention
edges. Fixed:
- `cleanEmptyValues` is now recursive + schema-aware: it deletes a `""` only when
  the schema PROVES the field optional, at any depth (nested objects, object
  arrays, TOP-LEVEL arrays), and fails SAFE (keeps everything) with no schema.
  Block-ness is derived from the schema's `blockTypes` (not a `'type' in item`
  heuristic that misread ordinary typed records). Required fields are never
  dropped — an empty required field is kept as "" so validation surfaces it.
- Click-to-edit: body editor→preview highlight restored (outbound handler matches
  `[data-content-field]` too); field + block highlight share one class-based
  cleanup and one timer; the editor flash is re-click-safe.

### Documented minor limitations (uncommon; fail SAFE — no data loss)
- Tuple / `prefixItems` array schemas and `additionalProperties`-only object
  schemas aren't walked for child schemas, so an empty OPTIONAL inside those may
  be retained (surfaces as a normal validation error, never dropped).
- The preview highlight uses a global `aa-highlight` class; a consumer element
  that already owns that exact class name could have it removed on cleanup.
