/**
 * Authentication helpers
 *
 * AstroAdmin instances are internet-facing (clients log in to edit), so login
 * must not leak via timing and should verify a hashed password rather than a
 * plaintext one.
 *
 * Password sources (in `config.auth`):
 *   - passwordHash (env ADMIN_PASSWORD_HASH): an argon2 hash — preferred.
 *     Verified with Bun.password (the server runs under Bun in production).
 *   - password (env ADMIN_PASSWORD): plaintext fallback for local/dev. A hash
 *     under a non-Bun runtime fails closed (no verifier available).
 */

import crypto from 'crypto';

/**
 * Constant-time string comparison that does not leak length via early return.
 */
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ab.length !== bb.length) {
    // Compare bb against itself so the work (and timing) is similar regardless
    // of length, then return false.
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a password against the configured credential.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(authConfig, password) {
  if (authConfig.passwordHash) {
    if (typeof Bun !== 'undefined' && Bun.password) {
      try {
        return await Bun.password.verify(String(password ?? ''), authConfig.passwordHash);
      } catch {
        return false;
      }
    }
    // A hash is configured but no verifier is available (non-Bun runtime).
    // Fail closed rather than silently accepting.
    return false;
  }
  return timingSafeEqualStr(password ?? '', authConfig.password);
}

/**
 * Verify a username + password pair. Always runs the password check (even when
 * the username is wrong) so login timing does not reveal valid usernames.
 * @returns {Promise<boolean>}
 */
export async function verifyCredentials(authConfig, username, password) {
  const userOk = timingSafeEqualStr(username ?? '', authConfig.username);
  const passOk = await verifyPassword(authConfig, password);
  return userOk && passOk;
}

/**
 * Hash a plaintext password for use as ADMIN_PASSWORD_HASH (argon2id).
 * @returns {Promise<string>}
 */
export async function hashPassword(plaintext) {
  if (typeof Bun === 'undefined' || !Bun.password) {
    throw new Error('Password hashing requires the Bun runtime (Bun.password).');
  }
  return Bun.password.hash(String(plaintext), { algorithm: 'argon2id' });
}

/**
 * Return human-readable warnings for weak production auth config (empty in dev).
 * @returns {string[]}
 */
export function authConfigWarnings(authConfig, isProd) {
  if (!isProd) return [];
  const warnings = [];
  if (!authConfig.passwordHash && authConfig.password === 'admin') {
    warnings.push('default admin password is in use');
  }
  if (!authConfig.passwordHash) {
    warnings.push('plaintext ADMIN_PASSWORD is in use (set ADMIN_PASSWORD_HASH instead)');
  }
  if (authConfig.username === 'admin') {
    warnings.push('default admin username is in use');
  }
  if (authConfig.sessionSecret === 'dev-secret-change-in-prod') {
    warnings.push('default SESSION_SECRET is in use (set a strong SESSION_SECRET)');
  }
  return warnings;
}
