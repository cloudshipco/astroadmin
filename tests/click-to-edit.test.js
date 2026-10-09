/**
 * Click-to-edit, the editor's side (ui/click-to-edit.js): which entry a click
 * in the preview belongs to, and whether the editor focuses a field of the open
 * entry or opens another one.
 *
 *   bun tests/click-to-edit.test.js
 */

import assert from 'assert';
import { parseEntryRef, resolveFieldFocus } from '../ui/click-to-edit.js';

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
const home = { collection: 'pages', slug: 'home' };
const hedge = { collection: 'services', slug: 'hedge-trimming' };
// The editor on the home page with pages/home open (not card mode).
const onHome = (overrides = {}) => ({ current: home, cardMode: false, entries, pageEntry: home, ...overrides });
// services/hedge-trimming opened from its card on the home page.
const cardOnHome = (overrides = {}) => onHome({ current: hedge, cardMode: true, ...overrides });

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
  assert.deepEqual(action, { action: 'open', collection: 'services', slug: 'hedge-trimming', field: 'title', keepPreview: true });
});

check('an entry-qualified click on the entry already open just focuses', () => {
  const action = resolveFieldFocus({ field: 'summary', entry: 'services/hedge-trimming', pathname: '/' }, cardOnHome());
  assert.deepEqual(action, { action: 'focus', field: 'summary' });
});

check('a reference to an entry that does not exist, or a malformed one, does nothing', () => {
  assert.equal(resolveFieldFocus({ field: 'title', entry: 'services/no-such-service', pathname: '/' }, onHome()), null);
  assert.equal(resolveFieldFocus({ field: 'title', entry: 'services', pathname: '/' }, onHome()), null);
});

check('in card mode, an unqualified click goes back to the page\'s own entry (and lets the preview show it)', () => {
  const action = resolveFieldFocus({ field: 'headline', pathname: '/' }, cardOnHome());
  assert.deepEqual(action, { action: 'open', collection: 'pages', slug: 'home', field: 'headline', keepPreview: false });
  // Control: the same click with the entry opened normally (not card mode) focuses it.
  assert.deepEqual(resolveFieldFocus({ field: 'headline', pathname: '/' }, cardOnHome({ cardMode: false })), { action: 'focus', field: 'headline' });
});

check('in card mode, an unqualified click on a page whose entry cannot be found does NOTHING', () => {
  // Focusing the card entry's same-named field would send the next edits to
  // the card (the /fr/ and /site/ cases of the review finding).
  assert.equal(resolveFieldFocus({ field: 'title', pathname: '/no-entry-here' }, cardOnHome({ pageEntry: null })), null);
  assert.equal(resolveFieldFocus({ field: 'headline' }, cardOnHome({ pageEntry: null })), null);
});

check('an unqualified click when the open entry IS the page\'s entry just focuses (no reload)', () => {
  assert.deepEqual(resolveFieldFocus({ field: 'headline', pathname: '/' }, onHome({ cardMode: true })), { action: 'focus', field: 'headline' });
});

check('a nested slug reference opens that entry', () => {
  const action = resolveFieldFocus({ field: 'title', entry: 'articles/2024/first-post', pathname: '/' }, onHome());
  assert.equal(action.action, 'open');
  assert.equal(action.slug, '2024/first-post');
});

check('no field, or a non-string field, does nothing', () => {
  assert.equal(resolveFieldFocus({ entry: 'services/hedge-trimming' }, onHome()), null);
  assert.equal(resolveFieldFocus({ field: ['title'] }, onHome()), null);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
