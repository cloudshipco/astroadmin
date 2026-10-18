/**
 * A short, non-reversible name for a session, for logs.
 *
 * A session ID is a credential (whoever holds it is signed in), so it never
 * goes to a log. The first 8 hex characters of its SHA-256 are enough to tie
 * one session's log lines together and useless for signing in.
 */

import { createHash } from 'crypto';

/**
 * @param {string} sessionId
 * @returns {string} 8 hex characters
 */
export function sessionFingerprint(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8);
}
