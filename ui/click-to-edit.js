/**
 * Click-to-edit, the editor's side of a click in the preview: which entry a
 * clicked annotation belongs to, and what the editor does about it.
 *
 * A site marks an editable element with `data-aa-field="<control name>"`. On
 * its own that means a field of the entry the page is for. When a page shows
 * cards from other entries (services listed on the home page, say), the card
 * or an ancestor carries `data-aa-entry="<collection>/<slug>"`, and the click
 * opens THAT entry. See docs/inline-editing.md.
 *
 * Pure, so it can be tested without a DOM (dashboard.js touches `document` at
 * import time).
 */

/**
 * @typedef {Object} EntryRef
 * @property {string} collection
 * @property {string} slug
 */

/**
 * Parse a data-aa-entry value: `<collection>/<slug>`. A collection name has no
 * slash, a slug may (nested content files), so the first slash splits them.
 * @param {unknown} value
 * @returns {EntryRef|null} null when the value is not a well-formed reference
 */
export function parseEntryRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { collection: trimmed.slice(0, slash), slug: trimmed.slice(slash + 1) };
}

/** `<collection>/<slug>`, the form data-aa-entry takes. */
export function formatEntryRef(collection, slug) {
  return `${collection}/${slug}`;
}

/**
 * What the editor does with a `fieldFocus` message from the preview.
 *
 * - An entry-qualified click on the open entry focuses the field.
 * - An entry-qualified click on another (existing) entry opens it, keeping the
 *   preview on the page the click came from (`previewPagePath`), then focuses.
 * - An unqualified click means the entry currently open, as it always has,
 *   UNLESS that entry was opened from a card on this page: then the open entry
 *   is not the page's own, and the click opens the page's entry instead.
 *
 * @param {{field?: unknown, entry?: unknown, pathname?: unknown}} message
 * @param {Object} state
 * @param {EntryRef|null} state.current - the entry open in the editor
 * @param {string|null} state.previewPagePath - set when the open entry was opened from a card on that page
 * @param {EntryRef[]} state.entries - every entry the editor knows
 * @param {(pathname: string) => EntryRef|null} state.resolvePage - the entry a previewed path is for
 * @returns {{action: 'focus', field: string}
 *   | {action: 'open', collection: string, slug: string, field: string, previewPagePath: string|null}
 *   | null} null when the click should do nothing
 */
export function resolveFieldFocus(message, { current, previewPagePath, entries, resolvePage }) {
  const field = message?.field;
  if (typeof field !== 'string' || field === '') return null;
  const pathname = typeof message.pathname === 'string' && message.pathname.startsWith('/') ? message.pathname : null;
  const isCurrent = (ref) => current !== null && ref.collection === current.collection && ref.slug === current.slug;

  if (message.entry !== undefined && message.entry !== null) {
    const ref = parseEntryRef(message.entry);
    // A malformed or unknown reference opens nothing: guessing would focus
    // a field of the wrong entry, which is worse than doing nothing.
    if (!ref) return null;
    if (isCurrent(ref)) return { action: 'focus', field };
    if (!entries.some((entry) => entry.collection === ref.collection && entry.slug === ref.slug)) return null;
    return { action: 'open', collection: ref.collection, slug: ref.slug, field, previewPagePath: pathname };
  }

  if (previewPagePath !== null && pathname !== null) {
    const pageEntry = resolvePage(pathname.replace(/\/+$/, '') || '/');
    if (pageEntry && !isCurrent(pageEntry)) {
      return { action: 'open', collection: pageEntry.collection, slug: pageEntry.slug, field, previewPagePath: null };
    }
  }
  return { action: 'focus', field };
}
