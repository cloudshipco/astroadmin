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
  { collection: 'site', slug: 'site' },
  { collection: 'faqs', slug: 'what-is-it' },
  { collection: 'faqs', slug: 'how-much' },
  { collection: 'articles', slug: 'first-post' },
];
const COLLECTIONS = [
  { name: 'pages', previewRoute: null },
  // `site` is listed BEFORE `home` on purpose: both are single-entry
  // collections previewing at '/', and natural order would pick site settings.
  { name: 'site', previewRoute: '/' },
  { name: 'home', previewRoute: '/' },
  { name: 'faqs', previewRoute: '/faq' },
  { name: 'articles', previewRoute: '/articles/{slug}' },
];
const ORDER = ['home', 'pages'];

check('a pages entry resolves by slug', () => {
  assert.deepStrictEqual(resolvePreviewTarget('/agencies', PAGES, COLLECTIONS, ORDER),
    { collection: 'pages', slug: 'agencies' });
});

check('the site root resolves to a single-entry home collection', () => {
  // The regression this covers: clicking the site logo in the preview navigates
  // to '/', which matched no `pages` entry once the homepage moved into its own
  // collection — so the editor stayed on the previous entry.
  assert.deepStrictEqual(resolvePreviewTarget('/', PAGES, COLLECTIONS, ORDER),
    { collection: 'home', slug: 'home' });
});

check('a {slug} route resolves to that entry', () => {
  assert.deepStrictEqual(resolvePreviewTarget('/articles/first-post', PAGES, COLLECTIONS, ORDER),
    { collection: 'articles', slug: 'first-post' });
});

check('a pages entry wins over a static route on the same path', () => {
  // /faq is both a pages entry (its heading and intro) and the faqs collection's
  // preview route. The editable page entry is the useful target.
  assert.deepStrictEqual(resolvePreviewTarget('/faq', PAGES, COLLECTIONS, ORDER),
    { collection: 'pages', slug: 'faq' });
});

check('a static route over a multi-entry collection stays unresolved', () => {
  // Without the pages/faq entry, /faq names no particular FAQ — guessing one
  // would be worse than leaving the editor where it is.
  const pages = PAGES.filter((p) => !(p.collection === 'pages' && p.slug === 'faq'));
  assert.strictEqual(resolvePreviewTarget('/faq', pages, COLLECTIONS, ORDER), null);
});

check('a multi-entry collection on a static route does not resolve', () => {
  // Negative control: with `home` holding two entries it names nothing, and
  // `site` is the only remaining single-entry candidate at '/'.
  const pages = [...PAGES, { collection: 'home', slug: 'other' }];
  assert.deepStrictEqual(resolvePreviewTarget('/', pages, COLLECTIONS, ORDER),
    { collection: 'site', slug: 'site' });
});

check('collectionOrder decides between two collections sharing a static route', () => {
  // The bug this covers: `site` and `home` both preview at '/', natural order
  // picks `site`, and clicking the site logo landed the editor on global
  // settings instead of the homepage's own content.
  assert.deepStrictEqual(resolvePreviewTarget('/', PAGES, COLLECTIONS, ['home', 'pages']),
    { collection: 'home', slug: 'home' });
  assert.deepStrictEqual(resolvePreviewTarget('/', PAGES, COLLECTIONS, ['site']),
    { collection: 'site', slug: 'site' });
});

check('with no collectionOrder the tie is stable, not random', () => {
  const a = resolvePreviewTarget('/', PAGES, COLLECTIONS, []);
  const b = resolvePreviewTarget('/', PAGES, COLLECTIONS, []);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, { collection: 'site', slug: 'site' });
});

check('a legacy pages/home still wins at /', () => {
  // Sites that keep their homepage as a pages entry must be unaffected.
  const pages = [{ collection: 'pages', slug: 'home' }, { collection: 'home', slug: 'home' }];
  assert.deepStrictEqual(resolvePreviewTarget('/', pages, COLLECTIONS, ORDER),
    { collection: 'pages', slug: 'home' });
});

check('an unknown path resolves to nothing', () => {
  assert.strictEqual(resolvePreviewTarget('/nope', PAGES, COLLECTIONS, ORDER), null);
});

check('a {slug} route with no matching entry resolves to nothing', () => {
  assert.strictEqual(resolvePreviewTarget('/articles/missing', PAGES, COLLECTIONS, ORDER), null);
});

check('a configured trailing slash on a route still matches', () => {
  const collections = [{ name: 'articles', previewRoute: '/articles/{slug}/' }];
  assert.deepStrictEqual(resolvePreviewTarget('/articles/first-post', PAGES, collections, ORDER),
    { collection: 'articles', slug: 'first-post' });
});

console.log('\n========================================\n');
console.log(`📊 ${passed} checks passed.`);
