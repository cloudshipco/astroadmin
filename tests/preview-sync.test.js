/**
 * The editor and its preview in step (ui/preview-sync.js): card mode derived
 * from the page the preview shows, with the preview base and the locale
 * prefix removed; what a save refreshes; which preview navigations open an
 * entry; and an order-independence table over the whole message flow.
 *
 *   bun tests/preview-sync.test.js
 */

import assert from 'assert';
import { createPreviewSync, splitLocalePath, normalisePath, isCardMode, pageEntryAt } from '../ui/preview-sync.js';

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

const ENTRIES = [
  { collection: 'pages', slug: 'home' },
  { collection: 'pages', slug: 'about' },
  { collection: 'services', slug: 'garden' },
  { collection: 'services', slug: 'hedge' },
];
const COLLECTIONS = [{ name: 'pages' }, { name: 'services', previewRoute: '/services/{slug}' }];
const I18N = { enabled: true, defaultLocale: 'en', locales: ['en', 'fr'] };
const NO_I18N = { enabled: false, defaultLocale: 'en', locales: ['en'] };
const home = { collection: 'pages', slug: 'home' };
const about = { collection: 'pages', slug: 'about' };
const garden = { collection: 'services', slug: 'garden' };

/** A sync over a context that a test can change (locale, preview URL). */
function makeSync({ previewUrl = 'http://localhost:4321', i18n = NO_I18N, locale = null } = {}) {
  const context = { previewUrl, entries: ENTRIES, collections: COLLECTIONS, collectionOrder: [], i18n, locale, selectedBlock: null };
  return { sync: createPreviewSync(() => context), context };
}

console.log('\n🧪 preview sync\n' + '='.repeat(40));

check('splitLocalePath: a configured non-default prefix is removed; the default locale has none', () => {
  assert.deepEqual(splitLocalePath('/fr/', I18N), { locale: 'fr', path: '/' });
  assert.deepEqual(splitLocalePath('/fr', I18N), { locale: 'fr', path: '/' });
  assert.deepEqual(splitLocalePath('/fr/about', I18N), { locale: 'fr', path: '/about' });
  assert.deepEqual(splitLocalePath('/about', I18N), { locale: 'en', path: '/about' });
  assert.deepEqual(splitLocalePath('/en/about', I18N), { locale: 'en', path: '/en/about' }, 'the default locale is not a prefix');
  assert.deepEqual(splitLocalePath('/fred', I18N), { locale: 'en', path: '/fred' }, 'a prefix must be a whole segment');
  assert.deepEqual(splitLocalePath('/fr/about', NO_I18N), { locale: null, path: '/fr/about' });
  assert.equal(normalisePath('/about/'), '/about');
  assert.equal(normalisePath('/'), '/');
});

// Finding 1, preview base: the iframe reports /site/...; nothing downstream
// may see the base, or a save refreshes /site/site/.
check('base path: a card opened on /site/ keeps the preview, and a save refreshes /site/ (not /site/site/)', () => {
  const { sync } = makeSync({ previewUrl: 'http://localhost:4321/site' });
  assert.deepEqual(sync.navigated('/site/', home), { sitePath: '/', load: null });
  const action = sync.fieldClicked({ field: 'title', entry: 'services/garden', pathname: '/site/' }, home);
  assert.deepEqual(action, { action: 'open', collection: 'services', slug: 'garden', field: 'title', keepPreview: true });
  assert.equal(sync.previewForLoad(home, garden, { keepPreview: true }), undefined, 'the preview stays put');
  assert.equal(sync.isCardMode(garden), true);
  assert.equal(sync.refreshPath(garden), '/', 'the save refreshes the card page as a SITE path (the URL adds the base once)');
  assert.equal(sync.pagePath(garden), '/');
});

check('base path: in card mode an unqualified click on /site/ opens the page\'s entry', () => {
  const { sync } = makeSync({ previewUrl: 'http://localhost:4321/site' });
  sync.navigated('/site/', home);
  assert.deepEqual(sync.fieldClicked({ field: 'headline', pathname: '/site/' }, garden),
    { action: 'open', collection: 'pages', slug: 'home', field: 'headline', keepPreview: false });
});

// Finding 1, locale: on /fr/ the page entry must resolve with the prefix removed.
check('locale: in card mode on /fr/, an unqualified click opens pages/home, not the card\'s field', () => {
  const { sync } = makeSync({ i18n: I18N, locale: 'fr' });
  sync.navigated('/fr/', home);
  assert.deepEqual(sync.fieldClicked({ field: 'title', entry: 'services/garden', pathname: '/fr/' }, home).keepPreview, true);
  assert.equal(sync.isCardMode(garden), true);
  assert.deepEqual(sync.fieldClicked({ field: 'headline', pathname: '/fr/' }, garden),
    { action: 'open', collection: 'pages', slug: 'home', field: 'headline', keepPreview: false });
  assert.deepEqual(pageEntryAt('/fr/about/', { entries: ENTRIES, collections: COLLECTIONS, collectionOrder: [], i18n: I18N }), { ...about, locale: 'fr' });
});

check('in card mode, an unqualified click on a page no entry owns does nothing (never the card\'s field)', () => {
  const { sync } = makeSync({ i18n: I18N, locale: 'fr' });
  sync.navigated('/fr/', home);
  sync.navigated('/fr/contact', home); // a static page: no entry owns it
  assert.equal(sync.isCardMode(garden), true);
  assert.equal(sync.fieldClicked({ field: 'title', pathname: '/fr/contact' }, garden), null);
});

// Finding 3: following the card's link to its own page ends card mode.
check('following a card\'s link to the entry\'s own page ends card mode; a save refreshes that page', () => {
  const { sync } = makeSync();
  sync.navigated('/', home);
  assert.equal(sync.isCardMode(garden), true);
  assert.deepEqual(sync.navigated('/services/garden/', garden), { sitePath: '/services/garden/', load: null }, 'nothing to open');
  assert.equal(sync.isCardMode(garden), false);
  assert.equal(sync.refreshPath(garden), '/services/garden', 'the save no longer returns the preview to /');
  // And an unqualified click there is the entry's own field.
  assert.deepEqual(sync.fieldClicked({ field: 'summary', pathname: '/services/garden/' }, garden), { action: 'focus', field: 'summary' });
});

check('navigating away to a page no entry owns: no load, and a save refreshes where the preview IS', () => {
  const { sync } = makeSync();
  sync.navigated('/', home);
  assert.deepEqual(sync.navigated('/contact', garden), { sitePath: '/contact', load: null });
  assert.equal(sync.refreshPath(garden), '/contact', 'not the stale card page /');
});

check('navigating to another entry\'s page opens it; a reload of the same page or the entry\'s own page does not', () => {
  const { sync } = makeSync();
  sync.navigated('/', home);
  assert.deepEqual(sync.navigated('/about/', home).load, about);
  sync.shown('/about');
  assert.equal(sync.navigated('/about/', about).load, null, 'the echo of the editor\'s own load');
  assert.deepEqual(sync.navigated('/services/garden', about).load, garden);
});

check('a page in another locale than the one edited is not opened (it would show the edited locale instead)', () => {
  const { sync } = makeSync({ i18n: I18N, locale: 'en' });
  sync.navigated('/', home);
  assert.equal(sync.navigated('/fr/about', home).load, null);
  assert.deepEqual(sync.navigated('/about', home).load, about);
});

check('a click from a page the preview has since left is dropped', () => {
  const { sync } = makeSync();
  sync.navigated('/', home);
  sync.shown('/services/garden'); // the editor pointed the preview elsewhere
  assert.equal(sync.fieldClicked({ field: 'title', entry: 'services/hedge', pathname: '/' }, garden), null);
  // An older preview script sends no pathname: judged against the preview's path.
  assert.deepEqual(sync.fieldClicked({ field: 'summary' }, garden), { action: 'focus', field: 'summary' });
});

check('previewForLoad: card open stays; a reload of the open entry refreshes the preview\'s page; else the entry\'s page', () => {
  const { sync } = makeSync();
  sync.navigated('/', home);
  assert.equal(sync.previewForLoad(home, garden, { keepPreview: true }), undefined);
  assert.equal(sync.previewForLoad(garden, garden), '/', 'a revert in card mode keeps the card page');
  assert.equal(sync.previewForLoad(garden, garden, { toEntryRoute: true }), '/services/garden', 'a locale switch shows the entry');
  assert.equal(sync.previewForLoad(home, about), '/about');
});

check('an entry previewed at a page another entry owns (faqs at /faq, also pages/faq) is not yanked off it', () => {
  const context = { previewUrl: 'http://localhost:4321', collectionOrder: [], i18n: NO_I18N, locale: null, selectedBlock: null,
    entries: [...ENTRIES, { collection: 'pages', slug: 'faq' }, { collection: 'faqs', slug: 'q1' }, { collection: 'faqs', slug: 'q2' }],
    collections: [...COLLECTIONS, { name: 'faqs', previewRoute: '/faq' }] };
  const sync = createPreviewSync(() => context);
  const question = { collection: 'faqs', slug: 'q1' };
  sync.navigated('/about', about);
  // Following a link to /faq while editing a question: its own preview page.
  assert.equal(sync.navigated('/faq/', question).load, null);
  assert.equal(isCardMode(question, sync.path, context), false);
  assert.deepEqual(sync.fieldClicked({ field: 'question', pathname: '/faq/' }, question), { action: 'focus', field: 'question' });
});

check('a component-only entry is never in card mode on its own component preview', () => {
  const context = { previewUrl: 'http://localhost:4321', entries: [...ENTRIES, { collection: 'quotes', slug: 'q1' }], collectionOrder: [], i18n: NO_I18N, locale: null, selectedBlock: null,
    collections: [...COLLECTIONS, { name: 'quotes', previewRoute: null, usedByBlocks: [{ type: 'quotes' }] }] };
  const sync = createPreviewSync(() => context);
  const quote = { collection: 'quotes', slug: 'q1' };
  sync.shown(sync.previewForLoad(home, quote));
  assert.equal(sync.path, '/component-preview/quotes/q1');
  assert.equal(isCardMode(quote, sync.path, context), false);
});

// ---------------------------------------------------------------------------
// Order-independence table. A small simulation of the dashboard's wiring
// (each action calls the sync exactly as dashboard.js does), with a preview
// base and two locales. Every permutation of the seven actions, from the same
// start, must leave the editor in a consistent state after EVERY step:
//
//   - a save writes the open entry, and refreshes exactly the page the preview
//     shows (never a stale card page, never base-doubled);
//   - card mode holds exactly when the open entry does not own that page;
//   - an echo of the editor's own preview load never opens an entry;
//   - an unqualified click either does nothing or leaves open the entry that
//     owns the clicked page (never a card's entry).
// ---------------------------------------------------------------------------

const BASE = '/site';
function simulate(order, { elsewhere }) {
  const context = { previewUrl: `http://localhost:4321${BASE}`, entries: ENTRIES, collections: COLLECTIONS, collectionOrder: [], i18n: I18N, locale: 'en', selectedBlock: null };
  const sync = createPreviewSync(() => context);
  let current = null;
  const localePrefix = () => (context.locale === 'en' ? '' : `/${context.locale}`);
  const report = (sitePath) => sync.navigated(`${BASE}${sitePath}`, current); // the iframe's pageNavigation

  function load(ref, options = {}) {
    const target = sync.previewForLoad(current, ref, options);
    current = ref;
    if (target !== undefined) {
      sync.shown(target);
      if (target !== null) assert.equal(report(target).load, null, `the echo of loading ${target} opened an entry`);
    }
  }
  function click(message) {
    const action = sync.fieldClicked({ ...message, pathname: `${BASE}${sync.path}` }, current);
    if (action?.action === 'open') load({ collection: action.collection, slug: action.slug }, { keepPreview: action.keepPreview });
    return action;
  }
  // The site's pages, written out independently of the code under test.
  const SITE_PAGES = { '/': home, '/about': about, '/services/garden': garden, '/contact': null };
  const owner = () => {
    if (sync.path === null) return null;
    const path = normalisePath(sync.path.replace(/^\/fr(?=\/|$)/, ''));
    assert.ok(path in SITE_PAGES, `the preview is on a page the site does not have: ${sync.path}`);
    return SITE_PAGES[path];
  };
  const owns = (ref) => ref !== null && ((o) => o !== null && o.collection === ref.collection && o.slug === ref.slug)(owner());
  const onHomePage = () => owner() === home;
  const hasUnqualifiedTitle = () => owner() !== null; // every entry-owned page annotates its own title

  const actions = {
    cardClick() {
      if (!onHomePage()) return; // the card is only on the home page
      const page = sync.path;
      assert.ok(click({ field: 'title', entry: 'services/garden' }) !== null, `the card click on ${page} did nothing`);
      assert.deepEqual(current, garden);
      assert.equal(sync.path, page, 'the card click moved the preview');
    },
    pageTitleClick() {
      // Every page an entry owns annotates its own title; a page no entry owns has none.
      if (!hasUnqualifiedTitle()) return;
      const action = click({ field: 'headline' });
      assert.ok(action !== null, `an unqualified click on ${sync.path} did nothing`);
      assert.ok(owns(current), `an unqualified click left ${JSON.stringify(current)} open on ${sync.path}`);
    },
    navigateToCardPage() {
      const result = report(`${localePrefix()}/services/garden/`);
      if (result.load) load(result.load);
    },
    navigateElsewhere() {
      const result = report(`${localePrefix()}${elsewhere}`);
      if (result.load) load(result.load);
    },
    save() {
      if (current === null) return;
      const refreshed = sync.refreshPath(current);
      // What a save writes: the open entry in the edited locale; what it refreshes: the preview's page.
      if (sync.path !== null) assert.equal(normalisePath(refreshed), normalisePath(sync.path), `save refreshed ${refreshed} while the preview showed ${sync.path}`);
      sync.shown(refreshed);
      if (refreshed !== null) assert.equal(report(refreshed).load, null, 'the save\'s refresh opened an entry');
    },
    switchEntry() { load(about); },
    switchLocale() {
      context.locale = context.locale === 'en' ? 'fr' : 'en';
      if (current) load(current, { toEntryRoute: true });
    },
  };

  // Start: the dashboard opened pages/home, the preview on its page.
  load(home);
  for (const name of order) {
    actions[name]();
    assert.ok(sync.path === null || !sync.path.startsWith(`${BASE}/`), `base leaked into the preview path: ${sync.path}`);
    const ownPath = current && sync.pagePath(current, null);
    const ownsPage = owns(current) || (ownPath !== null && sync.path !== null && normalisePath(ownPath) === normalisePath(sync.path));
    assert.equal(sync.isCardMode(current), current !== null && sync.path !== null && !ownsPage, `card mode wrong after ${name}`);
  }
  return JSON.stringify({ entry: current, locale: context.locale, preview: sync.path && normalisePath(sync.path), cardMode: sync.isCardMode(current), saveRefreshes: current && sync.refreshPath(current) });
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

const ACTIONS = ['cardClick', 'pageTitleClick', 'navigateToCardPage', 'navigateElsewhere', 'save', 'switchEntry', 'switchLocale'];
for (const elsewhere of ['/contact', '/about']) {
  check(`order-independence: all ${permutations(ACTIONS).length} orders (elsewhere = ${elsewhere}) stay consistent after every step`, () => {
    const endStates = new Set();
    let runs = 0;
    for (const order of permutations(ACTIONS)) {
      try { endStates.add(simulate(order, { elsewhere })); }
      catch (error) { error.message = `order ${order.join(' > ')}: ${error.message}`; throw error; }
      runs++;
    }
    assert.equal(runs, 5040, 'every permutation ran');
    console.log(`   ${endStates.size} distinct end states, each consistent`);
  });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
