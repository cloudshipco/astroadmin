/**
 * File-based content store round-trip tests
 *
 * Exercises the default (files) store: server/utils/content-files.js via the
 * content-store dispatcher + content.js + the listing in collections.js, with
 * no running server and no Astro config (collections default to glob under
 * src/content/<collection>).
 *
 * Run with a throwaway project root:
 *   ASTROADMIN_PROJECT_ROOT=/tmp/aa-files-root bun tests/content-files.test.js
 *
 * (Does NOT set ASTROADMIN_CONTENT_STORE — 'files' is the default.)
 */

import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import {
  readContent,
  writeContent,
  deleteContent,
  contentExists,
  getAvailableLocales,
} from '../server/utils/content.js';
import { getCollectionEntries } from '../server/utils/collections.js';
import { config } from '../server/config.js';

const CONTENT_DIR = config.paths.content;

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

// Start from a clean content dir so listing assertions are deterministic.
await fs.rm(CONTENT_DIR, { recursive: true, force: true });

console.log('\n🧪 File content store round-trip\n' + '='.repeat(40));

await check('write markdown content writes a real .md file with frontmatter', async () => {
  const result = await writeContent(
    'pages',
    'home',
    { data: { title: 'Home' }, body: '# Welcome', type: 'content' },
    null
  );
  const expected = path.join(CONTENT_DIR, 'pages', 'home.md');
  assert.equal(result.filePath, expected, 'real file path returned');

  const onDisk = await fs.readFile(expected, 'utf-8');
  assert.ok(onDisk.includes('title: Home'), 'frontmatter written');
  assert.ok(onDisk.includes('# Welcome'), 'body written');
});

await check('read round-trips frontmatter + body', async () => {
  const entry = await readContent('pages', 'home', null);
  assert.equal(entry.type, 'content', 'type content');
  assert.equal(entry.data.title, 'Home', 'frontmatter round-trips');
  assert.equal(entry.body.trim(), '# Welcome', 'body round-trips');
});

await check('contentExists reflects presence', async () => {
  assert.equal(await contentExists('pages', 'home', null), true, 'exists');
  assert.equal(await contentExists('pages', 'missing', null), false, 'absent');
});

await check('read of missing entry throws not-found', async () => {
  await assert.rejects(() => readContent('pages', 'missing', null), /not found/i);
});

await check('listing returns distinct slugs sorted', async () => {
  await writeContent('pages', 'about', { data: { title: 'About' }, body: '', type: 'content' }, null);
  const slugs = await getCollectionEntries('pages');
  assert.deepEqual(slugs, ['about', 'home'], 'distinct slugs sorted');
});

await check('data-type entry writes JSON with null body', async () => {
  const result = await writeContent('settings', 'site', { data: { siteName: 'Acme' }, type: 'data' }, null);
  assert.ok(result.filePath.endsWith(path.join('settings', 'site.json')), 'json path');
  const entry = await readContent('settings', 'site', null);
  assert.equal(entry.type, 'data', 'type data');
  assert.equal(entry.body, null, 'body null for data');
  assert.equal(entry.data.siteName, 'Acme', 'data round-trips');
});

await check('i18n: locale-suffixed files and available locales', async () => {
  await writeContent('pages', 'home', { data: { title: 'Accueil' }, body: 'Bonjour', type: 'content' }, 'fr');
  const expected = path.join(CONTENT_DIR, 'pages', 'home.fr.md');
  await fs.access(expected); // throws if not written
  const fr = await readContent('pages', 'home', 'fr');
  assert.equal(fr.data.title, 'Accueil', 'fr entry distinct from locale-less');
  assert.equal(fr.locale, 'fr', 'fr locale echoed');

  // Listing dedupes locales: 'home' appears once despite home.md + home.fr.md.
  // (i18n is off by default, so the locale suffix is part of the slug here;
  // this asserts the file was written, not locale-aware listing.)
  const available = await getAvailableLocales('pages', 'home', ['en', 'fr', 'de']);
  assert.deepEqual(available, ['fr'], 'only fr present among configured');
});

await check('delete removes the file and is idempotent-guarded', async () => {
  const result = await deleteContent('pages', 'about', null);
  assert.ok(result.deleted.endsWith(path.join('pages', 'about.md')), 'deleted path');
  assert.equal(await contentExists('pages', 'about', null), false, 'gone');
  await assert.rejects(() => deleteContent('pages', 'about', null), /not found/i, 'second delete rejects');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(0);
