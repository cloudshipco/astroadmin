/**
 * The /api rate limits (production only; server/config.js `rateLimit`).
 *
 * Three budgets per window:
 * - anyone not signed in, and every login attempt, share a strict budget per
 *   IP address (`max`);
 * - FAILED logins also have their own, much smaller budget per address
 *   (`loginMax`; a successful login is not counted). That is the brute-force
 *   guard, and it is the app's own: it does not rely on a proxy in front.
 *   Each failure also logs a fixed `auth.failed ip=<address>` line
 *   (server/utils/auth-log.js) for a host's fail2ban to act on;
 * - a signed-in session has its own, much larger budget (`sessionMax`), keyed
 *   by the session, so an editor's autosaves never use up the address's
 *   budget and cannot reach it in normal work.
 *
 * Mount after the session middleware: the split needs `req.session`.
 *
 * A refusal is JSON (`{ error, message, retryAfter }`, status 429) with a
 * Retry-After header in seconds, so the dashboard can say when to try again
 * instead of failing to parse a plain-text body.
 */

import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';

/** Login paths as Express routes them (case-insensitive, optional trailing slash). */
const LOGIN_PATH = /^\/login\/?$/i;

/**
 * "Too many requests, try again in N minutes."
 * @param {number} retryAfterSeconds
 */
export function tooManyRequestsMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many requests, try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** express-rate-limit's handler: a JSON 429 with Retry-After. */
function refuse(req, res, _next, options) {
  const resetTime = req.rateLimit?.resetTime;
  const remainingMs = resetTime instanceof Date ? resetTime.getTime() - Date.now() : options.windowMs;
  const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
  const message = tooManyRequestsMessage(retryAfter);
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({ error: message, message, retryAfter });
}

/** A signed-in session's request, other than a login attempt. */
function isSessionRequest(req) {
  return req.session?.authenticated === true && !LOGIN_PATH.test(req.path);
}

/**
 * @param {{windowMs: number, max: number, sessionMax: number, loginMax: number}} limits
 * @returns {import('express').RequestHandler[]} mount on '/api/', in order
 */
export function apiRateLimiters({ windowMs, max, sessionMax, loginMax }) {
  const perAddress = rateLimit({
    windowMs,
    limit: max,
    skip: isSessionRequest,
    handler: refuse,
  });
  const perSession = rateLimit({
    windowMs,
    limit: sessionMax,
    skip: (req) => !isSessionRequest(req),
    // A digest, so the limiter's memory never holds a usable session ID.
    keyGenerator: (req) => `session:${createHash('sha256').update(req.sessionID).digest('hex')}`,
    handler: refuse,
  });
  const failedLogins = rateLimit({
    windowMs,
    limit: loginMax,
    skip: (req) => !LOGIN_PATH.test(req.path),
    // A login answered below 400 is a success and gives its count back.
    skipSuccessfulRequests: true,
    handler: refuse,
  });
  return [perAddress, perSession, failedLogins];
}
