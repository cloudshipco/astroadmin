/**
 * Cache-busted preview URLs (ui/cache-bust.js). The dashboard reloads and
 * polls preview pages with a `t=<timestamp>` parameter. It used to append
 * `'?t=' + Date.now()` by hand, so a URL that already had a query (the
 * component preview's `?field=members`) became `?field=members?t=...`: the
 * field name was lost and the preview rendered an empty block.
 *
 *   bun tests/preview-cache-bust.test.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { withCacheBuster } from '../ui/cache-bust.js';

const repoRoot = path.resolve(import.meta.dir, '..');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${error.message}`);
  }
}

check('a URL with a query keeps its parameters and gains t', () => {
  const busted = withCacheBuster('http://localhost:4321/component-preview/team/ada?field=members', 123);
  const url = new URL(busted);
  assert.equal(url.searchParams.get('field'), 'members', busted);
  assert.equal(url.searchParams.get('t'), '123', busted);
  assert.equal((busted.match(/\?/g) || []).length, 1, busted);
});

check('a URL without a query gains ?t=', () => {
  assert.equal(withCacheBuster('http://localhost:4321/about', 5), 'http://localhost:4321/about?t=5');
});

check('an existing t is replaced, and a hash stays last', () => {
  assert.equal(withCacheBuster('http://localhost:4321/a?t=1#top', 9), 'http://localhost:4321/a?t=9#top');
});

check('a root-relative URL stays root-relative', () => {
  assert.equal(withCacheBuster('/blog/post?x=1', 7), '/blog/post?x=1&t=7');
});

check('dashboard.js adds no cache-buster by hand', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'ui/dashboard.js'), 'utf8');
  assert.ok(!/['"`]\?t=/.test(source), "ui/dashboard.js still appends '?t=' by string concatenation");
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
