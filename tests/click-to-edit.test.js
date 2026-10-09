/**
 * Click-to-edit, the editor's side (ui/click-to-edit.js): which entry a click
 * in the preview belongs to, and whether the editor focuses a field of the open
 * entry or opens another one.
 *
 *   bun tests/click-to-edit.test.js
 */

import assert from 'assert';
import { parseEntryRef, resolveFieldFocus } from '../ui/click-to-edit.js';
import { resolvePreviewTarget } from '../ui/preview-routes.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const entries = [
  { collection: 'pages', slug: 'home' },
  { collection: 'pages', slug: 'about' },
  { collection: 'services', slug: 'garden-design' },
  { collection: 'services', slug: 'hedge-trimming' },
  { collection: 'articles', slug: '2024/first-post' },
];
const collections = [{ name: 'pages' }, { name: 'services', previewRoute: null }, { name: 'articles', previewRoute: '/articles/{slug}' }];
const resolvePage = (pathname) => resolvePreviewTarget(pathname, entries, collections);
const home = { collection: 'pages', slug: 'home' };
const onHome = (overrides = {}) => ({ current: home, previewPagePath: null, entries, resolvePage, ...overrides });

console.log('\n🧪 click-to-edit: resolving a preview click\n' + '='.repeat(40));

check('parseEntryRef: collection, then the slug after the FIRST slash (slugs may nest)', () => {
  assert.deepEqual(parseEntryRef('services/garden-design'), { collection: 'services', slug: 'garden-design' });
  assert.deepEqual(parseEntryRef('articles/2024/first-post'), { collection: 'articles', slug: '2024/first-post' });
  assert.deepEqual(parseEntryRef(' services/garden-design '), { collection: 'services', slug: 'garden-design' });
});

check('parseEntryRef: malformed values are not references', () => {
  for (const value of ['', 'services', '/garden-design', 'services/', null, undefined, 42]) {
    assert.equal(parseEntryRef(value), null, JSON.stringify(value));
  }
});

check('an unqualified click focuses the field of the open entry (unchanged behaviour)', () => {
  assert.deepEqual(resolveFieldFocus({ field: 'title', pathname: '/' }, onHome()), { action: 'focus', field: 'title' });
  // An older preview script sends no pathname or entry at all.
  assert.deepEqual(resolveFieldFocus({ field: 'title' }, onHome()), { action: 'focus', field: 'title' });
});

check('an entry-qualified click on another entry opens it and keeps the preview on the clicked page', () => {
  const action = resolveFieldFocus({ field: 'title', entry: 'services/hedge-trimming', pathname: '/' }, onHome());
  assert.deepEqual(action, { action: 'open', collection: 'services', slug: 'hedge-trimming', field: 'title', previewPagePath: '/' });
});

check('an entry-qualified click on the entry already open just focuses', () => {
  const current = { collection: 'services', slug: 'hedge-trimming' };
  const action = resolveFieldFocus({ field: 'summary', entry: 'services/hedge-trimming', pathname: '/' }, onHome({ current, previewPagePath: '/' }));
  assert.deepEqual(action, { action: 'focus', field: 'summary' });
});

check('a reference to an entry that does not exist, or a malformed one, does nothing', () => {
  assert.equal(resolveFieldFocus({ field: 'title', entry: 'services/no-such-service', pathname: '/' }, onHome()), null);
  assert.equal(resolveFieldFocus({ field: 'title', entry: 'services', pathname: '/' }, onHome()), null);
});

check('with a card\'s entry open, an unqualified click goes back to the page\'s own entry', () => {
  const current = { collection: 'services', slug: 'hedge-trimming' };
  const action = resolveFieldFocus({ field: 'headline', pathname: '/' }, onHome({ current, previewPagePath: '/' }));
  assert.deepEqual(action, { action: 'open', collection: 'pages', slug: 'home', field: 'headline', previewPagePath: null });
  // Control: the same click with the entry opened normally (not from a card) focuses it.
  assert.deepEqual(resolveFieldFocus({ field: 'headline', pathname: '/' }, onHome({ current, previewPagePath: null })), { action: 'focus', field: 'headline' });
});

check('with a card\'s entry open on a page that resolves to no entry, an unqualified click focuses as before', () => {
  const current = { collection: 'services', slug: 'hedge-trimming' };
  const action = resolveFieldFocus({ field: 'headline', pathname: '/no-entry-here' }, onHome({ current, previewPagePath: '/no-entry-here' }));
  assert.deepEqual(action, { action: 'focus', field: 'headline' });
});

check('an unqualified click when the pinned entry IS the page\'s entry just focuses (no reload)', () => {
  const action = resolveFieldFocus({ field: 'headline', pathname: '/' }, onHome({ previewPagePath: '/' }));
  assert.deepEqual(action, { action: 'focus', field: 'headline' });
});

check('a nested slug reference opens that entry', () => {
  const action = resolveFieldFocus({ field: 'title', entry: 'articles/2024/first-post', pathname: '/' }, onHome());
  assert.equal(action.action, 'open');
  assert.equal(action.slug, '2024/first-post');
});

check('no field, or a non-string field, does nothing; a pathname that is not a path is dropped', () => {
  assert.equal(resolveFieldFocus({ entry: 'services/hedge-trimming' }, onHome()), null);
  assert.equal(resolveFieldFocus({ field: ['title'] }, onHome()), null);
  const action = resolveFieldFocus({ field: 'title', entry: 'services/hedge-trimming', pathname: 'javascript:alert(1)' }, onHome());
  assert.equal(action.previewPagePath, null);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
