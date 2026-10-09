/**
 * Page path -> live-site URL mapping (ui/live-url.js)
 *
 * The editor's "View live site" link and the post-publish live check both turn
 * a page path (the entry's route, or wherever the preview iframe has been
 * navigated) into a URL on the configured public site. The path comes from the
 * preview, so it is untrusted: it must never produce a link off the public site.
 *
 *   bun tests/live-url.test.js
 */

import assert from 'node:assert';
import { resolveLiveUrl, liveSiteHref } from '../ui/live-url.js';

let passed = 0;
let failed = 0;
// Every check runs even after a failure, so a red run shows each case's state.
function check(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.error(`❌ ${name}\n   ${e.message}`); }
}

const site = 'https://example.com';

// --- liveSiteHref: what the header link points at -------------------------

check('entry path maps onto the public origin', () => {
  assert.strictEqual(liveSiteHref(site, '/about'), 'https://example.com/about');
});
check('nested entry/preview route keeps its full path', () => {
  assert.strictEqual(liveSiteHref(site, '/blog/first-post'), 'https://example.com/blog/first-post');
});
check('root path maps to the site root', () => {
  assert.strictEqual(liveSiteHref(site, '/'), 'https://example.com/');
});
check('unknown path (null/undefined/empty) falls back to the site root', () => {
  assert.strictEqual(liveSiteHref(site, null), 'https://example.com/');
  assert.strictEqual(liveSiteHref(site, undefined), 'https://example.com/');
  assert.strictEqual(liveSiteHref(site, ''), 'https://example.com/');
});
check('query and hash on the page path are kept', () => {
  assert.strictEqual(liveSiteHref(site, '/search?q=a%20b#results'), 'https://example.com/search?q=a%20b#results');
});
check('query and hash on publicUrl itself are dropped', () => {
  assert.strictEqual(liveSiteHref('https://example.com/?utm=x#top', '/about'), 'https://example.com/about');
});
check('publicUrl with a trailing slash does not double the slash', () => {
  assert.strictEqual(liveSiteHref('https://example.com/', '/about'), 'https://example.com/about');
  assert.strictEqual(liveSiteHref('https://example.com/', '/'), 'https://example.com/');
});
check('publicUrl with a base path prefixes page paths with it', () => {
  assert.strictEqual(liveSiteHref('https://example.com/site', '/about'), 'https://example.com/site/about');
  assert.strictEqual(liveSiteHref('https://example.com/site/', '/about'), 'https://example.com/site/about');
});
check('base path: the root is the base path, not the origin', () => {
  assert.strictEqual(liveSiteHref('https://example.com/site', '/'), 'https://example.com/site/');
  assert.strictEqual(liveSiteHref('https://example.com/site', null), 'https://example.com/site/');
});
check('dot-dot cannot climb above the base path', () => {
  assert.strictEqual(liveSiteHref('https://example.com/site', '/a/../../etc'), 'https://example.com/site/etc');
});
check('escape attempts fall back to the site root, never another host', () => {
  for (const hostile of ['//evil.com/x', 'https://evil.com/x', 'http://example.com/x', '/\\evil.com/x',
    'javascript:alert(1)', 'about', '\\\\evil.com']) {
    assert.strictEqual(liveSiteHref(site, hostile), 'https://example.com/', `for ${JSON.stringify(hostile)}`);
  }
});
check('escape attempts under a base path fall back to the base path root', () => {
  assert.strictEqual(liveSiteHref('https://example.com/site', '//evil.com/x'), 'https://example.com/site/');
});
check('no publicUrl (or an unusable one) means no link', () => {
  assert.strictEqual(liveSiteHref(null, '/about'), null);
  assert.strictEqual(liveSiteHref('', '/about'), null);
  assert.strictEqual(liveSiteHref('not a url', '/about'), null);
  assert.strictEqual(liveSiteHref('javascript:alert(1)', '/about'), null);
});

// --- resolveLiveUrl: the strict form the server's live-status check uses ---

check('resolveLiveUrl returns a URL on the public site', () => {
  const url = resolveLiveUrl('https://example.com/site/', '/about');
  assert.ok(url instanceof URL);
  assert.strictEqual(url.href, 'https://example.com/site/about');
});
check('resolveLiveUrl throws on an escape attempt rather than falling back', () => {
  assert.throws(() => resolveLiveUrl(site, '//evil.com/x'), /public site/);
  assert.throws(() => resolveLiveUrl(site, 'about'), /public site/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
