/**
 * URLs that name one entry: the content API and the dashboard.
 *
 * A slug may be nested (`2024/first-post`, a content file in a subfolder), and
 * the server routes are `/:collection/:slug`, where a raw slash in the slug
 * would split it and the route would not match. Each part therefore travels as
 * ONE encoded path segment (`2024%2Ffirst-post`), which Express decodes back
 * into `req.params.slug`.
 */

/**
 * The entry a `<collection>/<slug>` value names (the entry picker's option
 * value). A collection name has no slash, so only the FIRST slash separates
 * it: `articles/2024/first-post` is slug `2024/first-post`.
 * @param {string} value
 * @returns {{collection: string, slug: string}|null}
 */
export function splitEntryValue(value) {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { collection: value.slice(0, separator), slug: value.slice(separator + 1) };
}

/** `/api/content/<collection>/<slug>`, for reads, saves and deletes. */
export function entryApiPath(collection, slug) {
  return `/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`;
}

/** `/dashboard/<collection>/<slug>`, the dashboard's link to an entry. */
export function entryDashboardPath(collection, slug) {
  return `/dashboard/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`;
}

/**
 * The entry a dashboard URL names, decoded; the inverse of entryDashboardPath.
 * @param {string} pathname
 * @returns {{collection: string, slug: string}|null}
 */
export function entryFromDashboardPath(pathname) {
  const match = pathname.match(/^\/dashboard\/([^/]+)\/(.+)$/);
  if (!match) return null;
  try {
    return { collection: decodeURIComponent(match[1]), slug: decodeURIComponent(match[2]) };
  } catch {
    return null; // a malformed escape names no entry
  }
}
