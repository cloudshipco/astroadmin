/**
 * Keeping the editor and the preview beside it in step.
 *
 * The preview's current path is the single source of truth. Everything else
 * is derived from it and from the entry open in the editor:
 *
 * - CARD MODE: the open entry is not the entry that owns the page the preview
 *   shows. That is how an entry opened from its card on another page
 *   (data-aa-entry, see docs/inline-editing.md) is edited where it is shown.
 *   There is no separate "pin" to keep in step by hand: a navigation moves the
 *   preview's path, and card mode follows.
 * - What a save refreshes: the page the preview shows in card mode, else the
 *   open entry's own route (as it always has been).
 * - Which entry an unqualified click in the preview belongs to: the owner of
 *   the preview's path, with the preview base and the locale prefix removed.
 *
 * Pure apart from the one path it holds, so the dashboard's message flow can be
 * tested without a DOM (dashboard.js touches `document` at import time).
 */

import { resolvePreviewTarget, previewPathToSitePath } from './preview-routes.js';
import { resolveFieldFocus } from './click-to-edit.js';

/**
 * @typedef {Object} EntryRef
 * @property {string} collection
 * @property {string} slug
 */

/**
 * @typedef {Object} SyncContext  Read on every call (the dashboard fills these in as it loads)
 * @property {string} previewUrl  The configured preview URL, which may carry a base path
 * @property {EntryRef[]} entries  Every entry the editor knows
 * @property {Array<{name: string, previewRoute?: string|null, usedByBlocks?: Array<{type: string}>}>} collections
 * @property {string[]} collectionOrder
 * @property {{enabled: boolean, defaultLocale: string, locales: string[]}} i18n
 * @property {string|null} locale  The locale being edited (null when i18n is off)
 * @property {string|null} selectedBlock  The block type chosen for a component preview
 */

const COMPONENT_PREVIEW = '/component-preview/';

/** '/about/' and '/about' are one page; '' and '/' are the root. */
export function normalisePath(sitePath) {
  return sitePath.replace(/\/+$/, '') || '/';
}

/**
 * Split a configured locale prefix off a site path: '/fr/about' is the 'fr'
 * version of '/about'. The default locale has no prefix (as the editor's own
 * routes are built), so an unprefixed path is the default locale's.
 * @returns {{locale: string|null, path: string}} locale is null when i18n is off
 */
export function splitLocalePath(sitePath, i18n) {
  if (!i18n?.enabled) return { locale: null, path: sitePath };
  const match = sitePath.match(/^\/([^/]+)(\/.*)?$/);
  if (match && match[1] !== i18n.defaultLocale && (i18n.locales || []).includes(match[1])) {
    return { locale: match[1], path: match[2] || '/' };
  }
  return { locale: i18n.defaultLocale, path: sitePath };
}

function isDefaultLocale(ctx) {
  return !ctx.i18n?.enabled || ctx.locale === ctx.i18n.defaultLocale;
}

/**
 * The site path of the open entry's own page ('/', '/about', '/fr/services/x'),
 * or null when it has no page of its own (component-preview-only collections).
 * @param {EntryRef|null} current
 * @param {SyncContext} ctx
 */
export function entryPagePath(current, ctx) {
  if (!current) return null;
  const localePrefix = isDefaultLocale(ctx) ? '' : `/${ctx.locale}`;
  if (current.collection === 'pages') {
    if (current.slug === 'home') return isDefaultLocale(ctx) ? '/' : localePrefix;
    return `${localePrefix}/${current.slug}`;
  }
  const collection = ctx.collections.find((c) => c.name === current.collection);
  if (collection?.previewRoute) return `${localePrefix}${collection.previewRoute.replace('{slug}', current.slug)}`;
  return null;
}

/**
 * The site path the preview shows for the open entry when it is opened
 * normally: its own page, else a component preview of it, else null (no
 * preview: the pane says so).
 */
export function entryPreviewPath(current, ctx) {
  const pagePath = entryPagePath(current, ctx);
  if (pagePath !== null) return pagePath;
  if (!current) return null;
  const collection = ctx.collections.find((c) => c.name === current.collection);
  const usedByBlocks = collection?.usedByBlocks || [];
  if (usedByBlocks.length > 0) {
    return `${COMPONENT_PREVIEW}${ctx.selectedBlock || usedByBlocks[0].type}/${current.slug}`;
  }
  return null;
}

/**
 * The entry that owns a previewed site path, with the locale prefix removed.
 * @returns {(EntryRef & {locale: string|null})|null}
 */
export function pageEntryAt(sitePath, ctx) {
  if (sitePath === null || sitePath.startsWith(COMPONENT_PREVIEW)) return null;
  const { locale, path } = splitLocalePath(sitePath, ctx.i18n);
  const ref = resolvePreviewTarget(normalisePath(path), ctx.entries, ctx.collections, ctx.collectionOrder);
  return ref ? { collection: ref.collection, slug: ref.slug, locale } : null;
}

const sameEntry = (a, b) => a !== null && b !== null && a.collection === b.collection && a.slug === b.slug;

/**
 * Card mode: the preview shows a page that the open entry does not own.
 * Never with no entry open or no page in the preview.
 */
export function isCardMode(current, previewPath, ctx) {
  if (!current || previewPath === null) return false;
  const ownPath = entryPreviewPath(current, ctx);
  if (ownPath !== null && normalisePath(ownPath) === normalisePath(previewPath)) return false;
  return !sameEntry(pageEntryAt(previewPath, ctx), current);
}

/**
 * The dashboard's preview state: the one site path the preview shows.
 * @param {() => SyncContext} getContext
 */
export function createPreviewSync(getContext) {
  /** Site path (preview base removed) the preview shows, or null for nothing. */
  let previewPath = null;

  const sync = {
    get path() { return previewPath; },

    /** The context the dashboard supplies, as of now. */
    context: getContext,

    /** The editor pointed the preview at this site path (null: the pane shows no page). */
    shown(sitePath) { previewPath = sitePath; },

    isCardMode(current) { return isCardMode(current, previewPath, getContext()); },

    /**
     * The page the live link and publish check use: where the preview is in
     * card mode, else the entry's own page. `at` asks the same question for a
     * page the preview is about to show.
     */
    pagePath(current, at = previewPath) {
      const ctx = getContext();
      return isCardMode(current, at, ctx) ? at : entryPagePath(current, ctx);
    },

    /** What a save (or the refresh button) reloads: the preview's page in card mode, else the entry's own. */
    refreshPath(current) {
      return sync.isCardMode(current) ? previewPath : entryPreviewPath(current, getContext());
    },

    /**
     * An entry is being loaded. Returns the site path to point the preview at,
     * or undefined to leave the preview exactly where it is.
     *
     * - keepPreview: opened from a card on the page the preview shows.
     * - Reloading the entry already open (a revert, a failed delete) refreshes
     *   whatever the preview shows, so card mode survives it.
     * - Anything else, including a locale switch (toEntryRoute), shows the
     *   entry's own page.
     * @param {EntryRef|null} previous  the entry open before this load
     * @param {EntryRef} next
     */
    previewForLoad(previous, next, { keepPreview = false, toEntryRoute = false } = {}) {
      if (keepPreview) return undefined;
      if (!toEntryRoute && sameEntry(previous, next)) return sync.refreshPath(next);
      return entryPreviewPath(next, getContext());
    },

    /**
     * The preview reported a page load (pageNavigation). Records the path and
     * says what the editor should do about it.
     * @param {unknown} rawPathname  window.location.pathname of the preview, base included
     * @param {EntryRef|null} current
     * @returns {{sitePath: string, load: EntryRef|null}|null} null for a path outside the preview base
     */
    navigated(rawPathname, current) {
      if (typeof rawPathname !== 'string') return null;
      const ctx = getContext();
      const sitePath = previewPathToSitePath(ctx.previewUrl, rawPathname);
      if (sitePath === null) return null;
      const previous = previewPath;
      previewPath = sitePath;
      if (sitePath.startsWith(COMPONENT_PREVIEW)) return { sitePath, load: null };
      const norm = normalisePath(sitePath);
      // Not a navigation: the page the preview already showed reloaded (a
      // save's refresh, the echo of the editor's own load).
      if (previous !== null && normalisePath(previous) === norm) return { sitePath, load: null };
      // The open entry's own page (the echo of loading it, or following a
      // card's link to its page): nothing to open, and card mode has ended.
      const ownPath = entryPagePath(current, ctx);
      if (ownPath !== null && norm === normalisePath(ownPath)) return { sitePath, load: null };
      const owner = pageEntryAt(sitePath, ctx);
      // A page in another locale than the one being edited stays unresolved:
      // opening its entry would show the edited locale's page instead.
      if (!owner || (ctx.i18n?.enabled && owner.locale !== ctx.locale) || sameEntry(owner, current)) {
        return { sitePath, load: null };
      }
      return { sitePath, load: { collection: owner.collection, slug: owner.slug } };
    },

    /**
     * A click on an annotated element in the preview (fieldFocus). Returns
     * what resolveFieldFocus returns, or null to do nothing.
     */
    fieldClicked(message, current) {
      const ctx = getContext();
      if (typeof message?.pathname === 'string') {
        const sitePath = previewPathToSitePath(ctx.previewUrl, message.pathname);
        if (sitePath === null) return null;
        if (previewPath === null) previewPath = sitePath;
        // A click from a page the preview has since left (the editor pointed it
        // elsewhere before this message arrived) belongs to no page on screen.
        else if (normalisePath(sitePath) !== normalisePath(previewPath)) return null;
      }
      return resolveFieldFocus(message, {
        current,
        cardMode: sync.isCardMode(current),
        entries: ctx.entries,
        pageEntry: pageEntryAt(previewPath, ctx),
      });
    },
  };
  return sync;
}
