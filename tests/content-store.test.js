/**
 * Content store round-trip tests (Chunk ① — storage core)
 *
 * Exercises server/utils/db.js + server/utils/content.js + the listing in
 * server/utils/collections.js directly, with no running server.
 *
 * Run with a throwaway database:
 *   ASTROADMIN_DB=/tmp/aa-test.db ASTROADMIN_PROJECT_ROOT=/tmp/aa-root \
 *     bun tests/content-store.test.js
 *
 * (No Astro config is present, so every collection is treated as a glob
 * collection — file-loader specifics are covered by the fixture e2e later.)
 */

// This suite asserts the SQLite store's behaviour (synthetic `db:` ids,
// countAll), so pin the dispatcher to the db store regardless of the default.
process.env.ASTROADMIN_CONTENT_STORE = 'db';

import assert from 'assert';
import {
  readContent,
  writeContent,
  deleteContent,
  contentExists,
  getAvailableLocales,
} from '../server/utils/content.js';
import { getCollectionEntries } from '../server/utils/collections.js';
import { countAll } from '../server/utils/db.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    process.exit(1);
  }
}

console.log('\n🧪 Content store round-trip\n' + '='.repeat(40));

await check('write + read markdown content entry', async () => {
  const result = await writeContent(
    'pages',
    'home',
    { data: { title: 'Home' }, body: '# Welcome', type: 'content' },
    null
  );
  assert.equal(result.filePath, 'db:pages/home', 'synthetic filePath');
  assert.equal(result.locale, null, 'locale null');

  const entry = await readContent('pages', 'home', null);
  assert.equal(entry.type, 'content', 'type content');
  assert.equal(entry.data.title, 'Home', 'frontmatter round-trips');
  assert.equal(entry.body, '# Welcome', 'body round-trips');
  assert.equal(entry.filePath, 'db:pages/home', 'read filePath');
});

await check('contentExists reflects presence', async () => {
  assert.equal(await contentExists('pages', 'home', null), true, 'exists');
  assert.equal(await contentExists('pages', 'missing', null), false, 'absent');
});

await check('read of missing entry throws not-found', async () => {
  await assert.rejects(
    () => readContent('pages', 'missing', null),
    /not found/i,
    'should reject with not found'
  );
});

await check('listing returns slugs ordered', async () => {
  await writeContent('pages', 'about', { data: { title: 'About' }, body: '', type: 'content' }, null);
  const slugs = await getCollectionEntries('pages');
  assert.deepEqual(slugs, ['about', 'home'], 'distinct slugs sorted');
});

await check('data-type entry stores null body', async () => {
  await writeContent('settings', 'site', { data: { siteName: 'Acme' }, type: 'data' }, null);
  const entry = await readContent('settings', 'site', null);
  assert.equal(entry.type, 'data', 'type data');
  assert.equal(entry.body, null, 'body null for data');
  assert.equal(entry.data.siteName, 'Acme', 'data round-trips');
});

await check('i18n: per-locale entries and available locales', async () => {
  await writeContent('pages', 'home', { data: { title: 'Accueil' }, body: 'Bonjour', type: 'content' }, 'fr');
  const fr = await readContent('pages', 'home', 'fr');
  assert.equal(fr.data.title, 'Accueil', 'fr entry distinct from locale-less');
  assert.equal(fr.locale, 'fr', 'fr locale echoed');
  assert.equal(fr.filePath, 'db:pages/home.fr', 'fr synthetic id');

  const available = await getAvailableLocales('pages', 'home', ['en', 'fr', 'de']);
  assert.deepEqual(available, ['fr'], 'only fr present among configured');
});

await check('delete removes entry and is idempotent-guarded', async () => {
  const result = await deleteContent('pages', 'about', null);
  assert.equal(result.deleted, 'db:pages/about', 'deleted id');
  assert.equal(await contentExists('pages', 'about', null), false, 'gone');
  await assert.rejects(() => deleteContent('pages', 'about', null), /not found/i, 'second delete rejects');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed. Total rows remaining: ${countAll()}\n`);
process.exit(0);
