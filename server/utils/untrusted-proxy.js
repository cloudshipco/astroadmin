/**
 * A TLS proxy the app does not trust.
 *
 * Production trusts a loopback proxy only (`trustProxy`, server/config.js).
 * Behind a TLS proxy on another machine or container, its
 * `X-Forwarded-Proto: https` is ignored, so the request looks like plain
 * HTTP (`req.secure` is false) and express-session silently drops the
 * HTTPS-only session cookie: the login succeeds with no cookie and the
 * editor is sent back to the login page. This module tells the site owner
 * (a server log line) and the editor (the login response) why, in fixed
 * sentences that name no address. The same holds for any request that is
 * not HTTPS (a production server reached directly over plain HTTP), which
 * gets its own sentence.
 */

/** The login response's `error` when the cookie could not be set. */
export const UNTRUSTED_PROXY_LOGIN_ERROR =
  'Sign-in could not complete: the server does not trust the proxy in front of it, so it cannot tell that the connection is HTTPS and cannot set the sign-in cookie. The site owner needs to list that proxy in TRUST_PROXY (see the "Trusted proxies" section of docs/configuration.md).';

/**
 * The login response's `error` when the request is plain HTTP with no
 * untrusted proxy involved (a direct request, or a trusted proxy that says
 * the connection was http): the cookie would be dropped all the same.
 */
export const PLAIN_HTTP_LOGIN_ERROR =
  'Sign-in needs HTTPS: this server is in production mode, so its session cookie is HTTPS-only. Put it behind an HTTPS proxy, or, on a machine only you can reach, run it without NODE_ENV=production.';

/** The server log line, at most once per interval. */
export const UNTRUSTED_PROXY_WARNING =
  '⚠️  A request came with X-Forwarded-Proto or X-Forwarded-For from a peer that is not a trusted proxy, so it counts as plain HTTP and the HTTPS-only session cookie cannot be set: sign-in fails. If AstroAdmin runs behind a TLS proxy on another machine or container, list that proxy in TRUST_PROXY (docs/configuration.md, "Trusted proxies").';

/** How often the warning may repeat: once an hour. */
export const WARNING_INTERVAL_MS = 60 * 60 * 1000;

/**
 * True when the session cookie is HTTPS-only, the request does not count as
 * HTTPS, and it carries a forwarded header from a peer `trust proxy` does
 * not trust: the layout where a login can never keep its cookie. A direct
 * plain-HTTP request (no forwarded header) is not this problem.
 * @param {import('express').Request} req
 * @param {boolean} cookieSecure - the session cookie's `secure` setting
 */
export function isUntrustedProxyRequest(req, cookieSecure) {
  if (cookieSecure !== true || req.secure) return false;
  if (req.get('x-forwarded-proto') === undefined && req.get('x-forwarded-for') === undefined) return false;
  const trusts = req.app.get('trust proxy fn');
  return !(typeof trusts === 'function' && trusts(req.socket?.remoteAddress, 0));
}

/**
 * Why a correct login here could not keep its session cookie, or null when
 * it can. express-session drops an HTTPS-only cookie whenever the request
 * does not count as HTTPS (`req.secure`, which follows `trust proxy`), so
 * that is exactly when the editor would be sent back to the login page.
 * An untrusted proxy gets the sentence naming TRUST_PROXY; anything else
 * (a direct plain-HTTP request, a trusted proxy forwarding http) the one
 * saying sign-in needs HTTPS.
 * @param {import('express').Request} req
 * @param {boolean} cookieSecure - the session cookie's `secure` setting
 * @returns {string|null}
 */
export function loginCookieRefusal(req, cookieSecure) {
  if (cookieSecure !== true || req.secure) return null;
  return isUntrustedProxyRequest(req, cookieSecure) ? UNTRUSTED_PROXY_LOGIN_ERROR : PLAIN_HTTP_LOGIN_ERROR;
}

/**
 * Middleware that logs UNTRUSTED_PROXY_WARNING for such a request, at most
 * once per `intervalMs`, so the first request through a misconfigured proxy
 * is noticed and a stream of them (or a client forging the headers) does
 * not flood the log. It never refuses anything.
 * @param {object} options
 * @param {boolean} options.cookieSecure
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.warn]
 * @returns {import('express').RequestHandler}
 */
export function untrustedProxyWarning({ cookieSecure, intervalMs = WARNING_INTERVAL_MS, now = Date.now, warn = (line) => console.warn(line) }) {
  let lastWarned = -Infinity;
  return function warnAboutUntrustedProxy(req, res, next) {
    if (isUntrustedProxyRequest(req, cookieSecure)) {
      const time = now();
      if (time - lastWarned >= intervalMs) {
        lastWarned = time;
        warn(UNTRUSTED_PROXY_WARNING);
      }
    }
    next();
  };
}
