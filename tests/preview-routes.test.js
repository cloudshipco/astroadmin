/**
 * Preview URL -> content entry resolution
 *
 * Run: bun tests/preview-routes.test.js
 *
 * This is what keeps the editor in step with the preview beside it. When it
 * fails to resolve, nothing errors — the sidebar simply stays on whatever was
 * open and quietly describes a different page than the one on screen.
 */

import assert from 'node:assert';
import { resolvePreviewTarget } from '../ui/preview-routes.js';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`✅ ${name}`);
  passed++;
}

// A site whose homepage is its own single-entry collection, plus the usual
// pages, a multi-entry collection on a static route, and one on a {slug} route.
const PAGES = [
  { collection: 'pages', slug: 'about' },
  { collection: 'pages', slug: 'agencies' },
  { collection: 'pages', slug: 'faq' },
  { collection: 'home', slug: 'home' },
  { collection: 'faqs', slug: 'what-is-it' },
  { collection: 'faqs', slug: 'how-much' },
  { collection: 'articles', slug: 'first-post' },
];
const COLLECTIONS = [
  { name: 'pages', previewRoute: null },
  { name: 'home', previewRoute: '/' },
  { name: 'faqs', previewRoute: '/faq' },
  { name: 'articles', previewRoute: '/articles/{slug}' },
];

check('a pages entry resolves by slug', () => {
  assert.deepStrictEqual(resolvePreviewTarget('/agencies', PAGES, COLLECTIONS),
    { collection: 'pages', slug: 'agencies' });
});

check('the site root resolves to a single-entry home collection', () => {
  // The regression this covers: clicking the site logo in the preview navigates
  // to '/', which matched no `pages` entry once the homepage moved into its own
  // collection — so the editor stayed on the previous entry.
  assert.deepStrictEqual(resolvePreviewTarget('/', PAGES, COLLECTIONS),
    { collection: 'home', slug: 'home' });
});

check('a {slug} route resolves to that entry', () => {
  assert.deepStrictEqual(resolvePreviewTarget('/articles/first-post', PAGES, COLLECTIONS),
    { collection: 'articles', slug: 'first-post' });
});

check('a pages entry wins over a static route on the same path', () => {
  // /faq is both a pages entry (its heading and intro) and the faqs collection's
  // preview route. The editable page entry is the useful target.
  assert.deepStrictEqual(resolvePreviewTarget('/faq', PAGES, COLLECTIONS),
    { collection: 'pages', slug: 'faq' });
});

check('a static route over a multi-entry collection stays unresolved', () => {
  // Without the pages/faq entry, /faq names no particular FAQ — guessing one
  // would be worse than leaving the editor where it is.
  const pages = PAGES.filter((p) => !(p.collection === 'pages' && p.slug === 'faq'));
  assert.strictEqual(resolvePreviewTarget('/faq', pages, COLLECTIONS), null);
});

check('a home collection with a root route resolves at / with no pages/home', () => {
  // Negative control for the branch above: the same shape, but the collection
  // holding two entries must NOT resolve.
  const pages = [...PAGES, { collection: 'home', slug: 'other' }];
  assert.strictEqual(resolvePreviewTarget('/', pages, COLLECTIONS), null);
});

check('a legacy pages/home still wins at /', () => {
  // Sites that keep their homepage as a pages entry must be unaffected.
  const pages = [{ collection: 'pages', slug: 'home' }, { collection: 'home', slug: 'home' }];
  assert.deepStrictEqual(resolvePreviewTarget('/', pages, COLLECTIONS),
    { collection: 'pages', slug: 'home' });
});

check('an unknown path resolves to nothing', () => {
  assert.strictEqual(resolvePreviewTarget('/nope', PAGES, COLLECTIONS), null);
});

check('a {slug} route with no matching entry resolves to nothing', () => {
  assert.strictEqual(resolvePreviewTarget('/articles/missing', PAGES, COLLECTIONS), null);
});

check('a configured trailing slash on a route still matches', () => {
  const collections = [{ name: 'articles', previewRoute: '/articles/{slug}/' }];
  assert.deepStrictEqual(resolvePreviewTarget('/articles/first-post', PAGES, collections),
    { collection: 'articles', slug: 'first-post' });
});

console.log('\n========================================\n');
console.log(`📊 ${passed} checks passed.`);
