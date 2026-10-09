/**
 * Refuse state-changing API requests that a page on another origin sent.
 *
 * The session cookie is SameSite=Strict, but SameSite is per SITE, not per
 * origin: a page on a sibling origin of the same site (the hosted preview
 * subdomain, which SESSION_COOKIE_DOMAIN shares the cookie with; another
 * localhost port in development) still sends it. A form-encoded or multipart
 * POST needs no CORS preflight, so without this check such a page could save
 * content, revert files or publish as the logged-in editor.
 *
 * A request is accepted when:
 * - its method is safe (GET, HEAD, OPTIONS), or
 * - the browser says it is same-origin (`Sec-Fetch-Site: same-origin`) or
 *   user-initiated (`none`), or
 * - it has no Sec-Fetch-Site (a non-browser client, or an older browser) and
 *   either no Origin, or an Origin equal to the admin's own origin: one of the
 *   configured ALLOWED_ORIGINS, or the origin the request itself was addressed
 *   to (`req.protocol` + Host; behind a proxy that needs `trust proxy` and
 *   X-Forwarded-Proto, which the NixOS module's nginx sends).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `scheme://host[:port]` for a URL-ish string, or null if it is not one. */
function originOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * @param {string[]|string|undefined} configuredOrigins - the CORS allow-list
 *   (ALLOWED_ORIGINS). A non-array (development's '*') adds nothing: '*' is
 *   never treated as "every origin is ours".
 * @returns {import('express').RequestHandler}
 */
export function requireSameOrigin(configuredOrigins) {
  const ownOrigins = new Set(
    (Array.isArray(configuredOrigins) ? configuredOrigins : [])
      .map((entry) => originOf(String(entry).trim()))
      .filter((entry) => entry !== null),
  );

  return function sameOriginGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (isSameOriginRequest(req, ownOrigins)) return next();
    console.warn(`[Security] Refused cross-origin ${req.method} ${req.originalUrl}`);
    res.status(403).json({ error: 'Cross-origin request refused' });
  };
}

function isSameOriginRequest(req, ownOrigins) {
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite !== undefined) {
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }

  const origin = req.get('origin');
  if (origin === undefined) return true;
  const requestOrigin = originOf(origin); // 'null' (sandboxed/opaque) -> null
  if (requestOrigin === null) return false;
  if (ownOrigins.has(requestOrigin)) return true;

  const host = req.get('host');
  if (host === undefined) return false;
  return requestOrigin === originOf(`${req.protocol}://${host}`);
}
