# Untouched fields keep their stored values

## Problem

Every save rebuilds the whole entry from the form's DOM. Each control therefore
has to reproduce its stored value exactly, and two review rounds kept finding
ones that do not: nulls saved as `""`, `[]` or `{}`; reference objects and
numbers saved as strings; date text rewritten; milliseconds and offsets lost;
a date-only value turned into a timestamp. Each fix covered some control
types and missed others (nullable `type: [x, "null"]` arrays, images,
references, containers, the item modal). The count was falling, but every
round found the same class.

## Decision

A control the editor has not changed contributes the value the entry had when
it was loaded, not a value read back from the DOM. Only changed controls are
read from the DOM.

- The editor keeps the loaded entry (`data`, as returned by the API) for the
  open form, and each item editor keeps the item it was opened with.
- Every rendered control (and every container: object, array, block list)
  records the path it was rendered from (`data-original-path`), which does not
  change when items are reordered or renumbered.
- Straight after rendering, each control's current DOM value is recorded as its
  baseline (read from the live element, so browser normalisation such as
  `datetime-local` milliseconds is already applied).
- At extraction, a control whose current value equals its baseline yields the
  loaded value at its original path. A changed control, or one with no original
  path (a new item), is read from the DOM as today.
- A container is unchanged when nothing inside it changed and its items were
  not added, removed or reordered; it yields its loaded value whole. A reordered
  list yields its items in the new order, each item built by the same rule.

Rejected: the editor sending only changed fields and the server merging them.
It needs path correspondence across reorders on the server and changes the
save API; the client-side rule gives the same guarantee for untouched values
with no API change.

## What this replaces

Code that exists only to make an untouched control reproduce its value can go
once the rule covers it: the date `data-original-value` round trip, the
`data-null` state for untouched nullable controls, and the JSON hidden-input
transport that keeps an untouched reference object's shape. Keep what an
EDITED control needs: a cleared nullable control saves `null`; an edited
reference saves an id; an edited date saves a value the schema accepts (a real
`z.date()` holding a date-only value stays date-only, so its control must not be
forced to `datetime-local`).

## Must keep

- CLAUDE.md renderer invariants (one renderer for all three surfaces; the input
  carries the schema type; `jsonAttr()`; the empty-array rule in
  `extractFormData`).
- Server behaviour and the save API unchanged; `ui/save-payload.js` body rule
  unchanged.

## Tests

- Fixtures derived from the REAL converters (zod 4 `toJSONSchema` override and
  zod 3) via the schema parser, not hand-written JSON Schema: nullable as
  `type: [x, "null"]` and as `anyOf`.
- For each control kind (string, textarea, number, integer, boolean, enum,
  date, datetime, image, image(), colour, single reference, reference list,
  `<x>Ids` list, gallery, object, array of objects, block list, item modal),
  with stored values that a DOM round trip would change (null, numbers as
  references, `{collection, id}`, offsets, microseconds, date-only Dates):
  an unrelated edit leaves the value byte-identical in the saved file.
- Reorder a block list and an array: values move with their items unchanged.
- Each test is seen red with the rule disabled.

## Review round 3: lists, cleanup, clearing (done)

- Cleanup ran on the DOM's data before stored values were put back, so it
  stripped `''` and `[]` from every card of a JSON-backed list once any card
  changed. Now restore runs first and returns its paths, cleanup skips them,
  and card items are final: the item modal saves through `extractItem` (read,
  restore, clean), a new item is opened unbound. The top-level-array entry
  returns the stored list when untouched and does not re-clean items.
- A row with no bound control (a `z.literal`-only object) was invisible to
  the membership check. A MutationObserver started by `bindOriginalValues`
  marks lists whose rows were added, removed or moved.
- Primitive list items carry `data-nullable` (a nullable boolean item is the
  same three-state select as a field). A widget's clear marks the control
  (`setWidgetValue`), so an unbound (new) entry's cleared image or reference
  saves null. Binding new entries to their defaults was considered and not
  done: a value chosen then cleared is back at its baseline, so it would not
  tell a clear from never set, and bound defaults would escape cleanup.
- A stored invalid `[]` on an optional key: a list the editor structurally
  changed saves its DOM value, so adding an item and deleting it leaves the
  key unset (the optional-`[]` cleanup). The warning for a too-short list says
  how many items it needs and, only when the schema proves the key optional,
  how to leave it out. No new control.
- Tests: `tests/untouched-structure.test.js`.

## Later rounds and status (done, shipped in 1.6.0 on 2026-10-11)

- Round 4: cleanup reads through a nullable wrapper (an emptied optional
  array inside a nullable object is dropped); a gallery's add/remove/reorder
  in its modal marks the field `data-structural-edit`, so add-then-remove
  leaves an optional `.min(1)` gallery unset.
- Rounds 5-6: after a structural edit, cleanup skips only the gallery images
  that match one it was loaded with (by value, as a multiset); a newly added
  image is cleaned like any new value.
- Deferred to #66: a new `z.date()` inside a nested object is saved quoted; an
  empty value in a newly added nullable primitive row saves `''`; top-level
  stored keys the schema does not render are dropped.
