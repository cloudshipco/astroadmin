# Searchable entry picker (replace the long selector)

## Problem
The entry selector is a single native `<select>` (`#pageSelector`, populated in
`dashboard.js` `populatePageSelector`) holding everything at once: virtual site
routes + every collection's entries + a `+ New` per collection. On a real site
that is 40+ options (this one: 4 routes + 7 pages + site + 25 FAQs + blog). Three
problems fall out of that:

1. **Too long.** A native dropdown of 40+ items is unusable; the blog post sits
   below all 25 FAQ entries.
2. **Two "Pages" groups.** The virtual routes group and the `pages` collection
   group were both labelled "Pages" (fixed as a quick win: routes group is now
   "Site pages (read-only)").
3. **Virtual routes are dead-ends.** Selecting a route (Home, Blog, Faq, Find
   Out More = the `.astro` files) shows a read-only "template page" panel, not an
   editor. A user after the blog *posts* clicks "Blog" and lands on the `/blog`
   index template instead.

## Direction (client suggestion, agreed): a modal command-palette picker
Replace the native select with a **searchable modal**. Click the current-entry
button in the header → a modal opens with a search box and a grouped, filtered
list. Type to filter across all entries by title/slug; ↑/↓ to move, Enter to
open, Esc to close. This scales to any number of entries and lets us group and
label clearly.

### Layout
- **Editable collections first**, each its own section with a `+ New …` action:
  Pages, Blog, FAQs, Site. Entry rows show the entry's title (fall back to slug)
  with the slug muted beside it — searchable on both.
- **Site pages (read-only)** in a clearly separate, de-emphasised section at the
  bottom (or behind a "show routes" toggle) so routes don't masquerade as
  editable content. Keep them reachable (preview is useful) but out of the way.
- Current entry marked (check), and focused on open.

### Wiring
- Keep the existing load logic untouched — the modal just calls what the select's
  change handler already calls: `loadEntry(collection, slug)`, `loadVirtualPage`,
  and the `new:`/`__page__:` paths. The picker is a new front-end over the same
  actions, so selection behaviour and URLs don't change.
- Replace `#pageSelector` with a button (shows current entry) + the modal. Keep
  `populatePageSelector`'s data model (it already has collections + staticPages);
  render the modal list from the same arrays.
- Reuse the modal overlay conventions already in the codebase (z-index, focus
  trap, Esc, click-outside) — mirror the image-library / textarea modals.

### Accessibility / behaviour
- Search input autofocused; list is `role="listbox"`, rows `role="option"`,
  aria-selected on the current one; full keyboard nav; Esc restores focus to the
  opener. Empty-search shows the full grouped list; typing filters.

## Also worth doing (smaller, can fold in)
- Entry rows keyed by **title not slug** where the schema has a title-ish field
  (the select currently shows raw slugs like `how-does-pricing-work`).
- Optional: when the preview iframe navigates to a route that *is* an editable
  entry, offer a "jump to edit" affordance (the preview-click-doesn't-sync
  confusion). Nice-to-have, separate.

## Effort / risk
Medium. New self-contained modal component + a thin wiring layer over the
existing load actions; no server or schema changes. Risk is core-navigation
regression, so: keep the load functions unchanged, and verify live (open every
collection kind, `+ New`, a virtual route, search-filter, keyboard nav) before
publishing. Ships fleet-wide with the next astroadmin release.

## Out of scope
- Rethinking virtual pages / inline-editing of routes (separate, larger).
- Multi-select / bulk actions.

## Built (2026-07-30)
- `ui/entry-picker.js` — the modal picker. The native `<select>` is hidden and
  kept as the source of truth; the modal is a view over its option tree and
  drives it via `select.value = …; dispatch('change')`, so loadEntry /
  loadVirtualPage / new-item all run unchanged.
- Search filters across humanised label + raw slug; ↑/↓/Enter/Esc; current entry
  checked and focused; editable collections first, "Site pages (read-only)" last.
- Trigger button shows the current entry; kept in sync wherever the select's
  value is set (`syncEntryPickerLabel`).
- Styles in `input.css`; wired in `dashboard.js`.
- Verified live: button + hidden select, modal groups in order (read-only last),
  search → single blog match, Enter → navigates + URL + button label update.
- Follow-up still open: show real entry titles (needs the collections API to
  return a title per entry) instead of humanised slugs; "FAQ" casing.
