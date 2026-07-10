/**
 * live-status SSRF guard test
 *
 * resolveLiveUrl() appends a client-supplied page path to the admin-configured
 * public origin. It MUST refuse any path that would change the origin (an SSRF
 * vector: //evil.com, http://internal, etc.) while allowing normal same-site
 * paths.
 *
 *   bun tests/live-status.test.js
 */

import assert from 'assert';
import { resolveLiveUrl } from '../server/api/publish.js';

const base = 'https://example.com';
let passed = 0;
class CheckFailed extends Error {}
function check(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}\n   ${e.stack || e.message}`); throw new CheckFailed(name); }
}

try {
  check('root path resolves same-origin', () => {
    assert.strictEqual(resolveLiveUrl(base, '/').href, 'https://example.com/');
  });
  check('normal page path resolves same-origin', () => {
    assert.strictEqual(resolveLiveUrl(base, '/about').href, 'https://example.com/about');
  });
  check('empty/undefined path defaults to root', () => {
    assert.strictEqual(resolveLiveUrl(base, undefined).href, 'https://example.com/');
  });
  check('protocol-relative //host is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, '//evil.com/x'), /public site/);
  });
  check('absolute http URL is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, 'http://evil.com'), /public site/);
  });
  check('absolute https URL to another host is rejected', () => {
    assert.throws(() => resolveLiveUrl(base, 'https://evil.com/x'), /public site/);
  });
  check('dot-dot traversal stays within origin (normalized, allowed)', () => {
    // new URL normalizes ../ but can't leave the origin.
    assert.strictEqual(resolveLiveUrl(base, '/a/../../etc').origin, 'https://example.com');
  });
  check('base with a subpath still guards origin', () => {
    assert.strictEqual(resolveLiveUrl('https://example.com/site', '/page').origin, 'https://example.com');
    assert.throws(() => resolveLiveUrl('https://example.com/site', 'https://evil.com'), /public site/);
  });

  console.log(`\n${passed} checks passed`);
} catch (e) {
  if (!(e instanceof CheckFailed)) console.error(e);
  process.exitCode = 1;
}
