/**
 * Auth helper tests
 *
 * Covers timing-safe comparison, plaintext + argon2-hash password
 * verification, the username/password pair check, and the production
 * weak-config warnings.
 *
 *   bun tests/auth.test.js
 */

import assert from 'assert';
import {
  timingSafeEqualStr,
  verifyPassword,
  verifyCredentials,
  hashPassword,
  authConfigWarnings,
} from '../server/utils/auth.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exit(1);
  }
}

console.log('\n🧪 Auth helpers\n' + '='.repeat(40));

await check('timingSafeEqualStr matches equal, rejects unequal/length-mismatch', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false, 'length mismatch does not throw');
  assert.equal(timingSafeEqualStr('', ''), true);
});

await check('plaintext password verification', async () => {
  const cfg = { username: 'admin', password: 's3cret', passwordHash: null };
  assert.equal(await verifyPassword(cfg, 's3cret'), true);
  assert.equal(await verifyPassword(cfg, 'nope'), false);
});

await check('verifyCredentials requires both username and password', async () => {
  const cfg = { username: 'james', password: 's3cret', passwordHash: null };
  assert.equal(await verifyCredentials(cfg, 'james', 's3cret'), true);
  assert.equal(await verifyCredentials(cfg, 'james', 'wrong'), false, 'wrong password');
  assert.equal(await verifyCredentials(cfg, 'eve', 's3cret'), false, 'wrong username');
});

await check('argon2 hash round-trips through hashPassword + verifyPassword', async () => {
  const hash = await hashPassword('hunter2');
  assert.ok(hash.startsWith('$argon2'), 'argon2 hash format');
  const cfg = { username: 'admin', password: null, passwordHash: hash };
  assert.equal(await verifyPassword(cfg, 'hunter2'), true, 'correct password verifies');
  assert.equal(await verifyPassword(cfg, 'hunter3'), false, 'wrong password rejected');
  assert.equal(await verifyCredentials(cfg, 'admin', 'hunter2'), true, 'pair check');
});

await check('authConfigWarnings: dev is silent, prod flags weak config', () => {
  const weak = { username: 'admin', password: 'admin', passwordHash: null, sessionSecret: 'dev-secret-change-in-prod' };
  assert.deepEqual(authConfigWarnings(weak, false), [], 'no warnings in dev');
  const prodWarnings = authConfigWarnings(weak, true);
  assert.ok(prodWarnings.length >= 3, 'flags default password, plaintext, username, secret');

  const strong = { username: 'james', password: null, passwordHash: '$argon2id$v=19$...', sessionSecret: 'a-real-long-secret' };
  assert.deepEqual(authConfigWarnings(strong, true), [], 'no warnings when hardened');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(0);
