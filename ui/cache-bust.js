/**
 * A preview URL with a `t=<timestamp>` cache-buster, added as a query
 * parameter rather than by appending '?t=': a URL that already has a query
 * (the component preview's `?field=...`) must keep it intact.
 *
 * @param {string} url - absolute, or root-relative (`/blog/post`)
 * @param {number} [stamp] - defaults to Date.now()
 * @returns {string}
 */
export function withCacheBuster(url, stamp = Date.now()) {
  const isRootRelative = url.startsWith('/') && !url.startsWith('//');
  const parsed = new URL(url, 'http://placeholder.invalid');
  parsed.searchParams.set('t', String(stamp));
  return isRootRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}
