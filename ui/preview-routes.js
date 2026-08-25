/**
 * Mapping a previewed URL back to the content entry that renders it.
 *
 * Split out of dashboard.js so it can be tested without a DOM — the dashboard
 * touches `document` at import time, so anything left in there is unreachable
 * from a unit test.
 */

// Escape a string for literal use inside a RegExp (the fixed parts of a preview
// route like "/blog/" around its {slug} placeholder).
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a previewed path to the entry that renders it, or null.
 *
 * Pure: everything it needs is passed in, so it can be tested without a DOM or a
 * live editor. Order matters — the most specific match wins:
 *
 *   1. a `pages` entry whose slug is the path,
 *   2. a collection with a STATIC preview route and exactly one entry,
 *   3. a collection whose preview route carries `{slug}`.
 *
 * Step 2 is what makes a homepage held in its own single-entry collection
 * reachable. `pages` alone is not enough: with the homepage moved out of
 * `pages`, `/` matched nothing and clicking the site logo in the preview left
 * the editor sitting on an unrelated entry, disagreeing with the page beside it.
 *
 * A static route over a MULTI-entry collection (`faqs: '/faq'`) names no
 * particular entry, so it stays unresolved — guessing would be worse than
 * leaving the editor where it is.
 *
 * @param {string} norm      Previewed path, trailing slash already stripped ('/' for root)
 * @param {Array<{collection: string, slug: string}>} pages
 * @param {Array<{name: string, previewRoute?: string|null}>} collections
 * @returns {{collection: string, slug: string}|null}
 */
export function resolvePreviewTarget(norm, pages = [], collections = []) {
  const slug = norm === '/' ? 'home' : norm.replace(/^\/+/, '');
  if (pages.some((p) => p.collection === 'pages' && p.slug === slug)) {
    return { collection: 'pages', slug };
  }

  for (const coll of collections) {
    const route = coll.previewRoute;
    if (!route || route.includes('{slug}')) continue;
    if ((route.replace(/\/+$/, '') || '/') !== norm) continue;
    const entries = pages.filter((p) => p.collection === coll.name);
    if (entries.length !== 1) continue;
    return { collection: coll.name, slug: entries[0].slug };
  }

  for (const coll of collections) {
    const route = coll.previewRoute;
    if (!route || !route.includes('{slug}')) continue;
    // Normalise the route's trailing slash the same way `norm` is, so a
    // configured `/blog/{slug}/` still matches the normalised `/blog/x`.
    const pattern = '^' + route.replace(/\/+$/, '').split('{slug}').map(escapeRegExp).join('(.+)') + '$';
    const match = norm.match(new RegExp(pattern));
    if (!match) continue;
    const entrySlug = match[1];
    if (pages.some((p) => p.collection === coll.name && p.slug === entrySlug)) {
      return { collection: coll.name, slug: entrySlug };
    }
  }
  return null;
}

