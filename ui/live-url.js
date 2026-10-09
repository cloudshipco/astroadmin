/**
 * Page path -> URL on the public (production) site.
 *
 * Shared by the editor's "View live site" link and the server's post-publish
 * live-status check, so both agree on which live URL a page lives at. Imported
 * by the browser (served from ui/) and by server/api/publish.js.
 *
 * Rules:
 *  - A page path is site-relative ("/about", "/blog/post?x=1#y"). Its query and
 *    hash are kept; publicUrl's own query and hash are not.
 *  - A path on publicUrl is a base path: with https://example.com/site, "/about"
 *    is https://example.com/site/about and the site root is /site/. "../" is
 *    normalised before the base is applied, so it cannot climb above it.
 *  - The path is untrusted (it can come from the preview iframe or a query
 *    string). Anything that is not a plain "/..." path on the same origin —
 *    "//host", "https://host", "/\host", "javascript:", a relative "about" — is
 *    an escape attempt.
 */

function parsePublicBase(publicUrl) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('publicUrl must be an http(s) URL');
  }
  return { origin: base.origin, basePath: base.pathname.replace(/\/+$/, '') };
}

/**
 * Strict form: returns a URL on the public site, or throws if requestedPath
 * would leave it. A missing path means the site root.
 */
export function resolveLiveUrl(publicUrl, requestedPath) {
  const { origin, basePath } = parsePublicBase(publicUrl);
  const pagePath = requestedPath || '/';
  // Only a root-relative path is a page path. Checked on the raw string as well
  // as the parsed origin: a relative "about" or "javascript:" would otherwise be
  // resolved (or rejected) by URL rules that have nothing to do with pages.
  const escapeError = new Error('path must stay within the configured public site');
  if (typeof pagePath !== 'string' || !pagePath.startsWith('/')) throw escapeError;
  const resolved = new URL(pagePath, origin);
  if (resolved.origin !== origin) throw escapeError;
  return new URL(`${basePath}${resolved.pathname}${resolved.search}${resolved.hash}`, origin);
}

/**
 * Lenient form for links: the live URL for pagePath, the site root when the
 * path is unknown or unsafe, or null when there is no usable publicUrl (no link).
 */
export function liveSiteHref(publicUrl, pagePath) {
  if (!publicUrl) return null;
  try {
    return resolveLiveUrl(publicUrl, pagePath).href;
  } catch {
    try {
      return resolveLiveUrl(publicUrl, '/').href;
    } catch {
      return null; // publicUrl itself is unusable
    }
  }
}
