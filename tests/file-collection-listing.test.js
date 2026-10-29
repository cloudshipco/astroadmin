/**
 * Listing a file() collection reads and parses its JSON file once (#19).
 *
 * The entry list with previews (`/api/collections/:name/entries`) and the
 * collection list's entry titles read each entry through `readContent`, and
 * for a file() collection each of those read and parsed the whole file: n
 * entries cost n + 1 reads and parses of the same file. Now each listing reads
 * it once. A glob() collection still reads each entry's own file once.
 *
 * Counts `fs/promises` readFile calls on the collection's file and
 * `JSON.parse` calls on its text, around the real collections.js functions on
 * a throwaway site (real content config, real parser). The listed values are
 * checked too: titles and previews, an item with no id (listed by index, as
 * before, and shown without data), a repeated id (the first item wins, as a
 * read does) and a 50-entry collection.
 *
 *   bun tests/file-collection-listing.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-file-listing-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { file, glob } from 'astro/loaders';
export const collections = {
  people: defineCollection({
    loader: file('src/content/people.json'),
    schema: z.object({ id: z.string(), name: z.string(), description: z.string().optional() }),
  }),
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string() }),
  }),
};
`);

const ENTRY_COUNT = 50;
const people = Array.from({ length: ENTRY_COUNT }, (_, index) => ({
  id: `person-${index}`,
  name: `Person ${index}`,
  description: index === 3 ? 'x'.repeat(120) : `About person ${index}`,
}));
people.push({ name: 'No id' });
people.push({ id: 'person-1', name: 'A second person-1' });
const peopleFile = path.join(projectRoot, 'src/content/people.json');
writeProjectFile('src/content/people.json', JSON.stringify(people, null, 2));
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\nHome.\n');
writeProjectFile('src/content/pages/about.md', '---\ntitle: About\n---\nAbout.\n');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const { getCollectionEntriesWithPreview, getAllCollections, loadSchemas } = await import('../server/utils/collections.js');
await loadSchemas();

/** Run `fn`, counting reads of `filePath` (any path ending in `suffix`) and parses of its text. */
async function countReads(suffix, fn) {
  const originalReadFile = fsPromises.readFile;
  const originalParse = JSON.parse;
  const fileText = fs.readFileSync(peopleFile, 'utf8');
  const counts = { reads: 0, parses: 0, allReads: [] };
  fsPromises.readFile = function (target, ...rest) {
    const name = String(target);
    counts.allReads.push(name);
    if (name.endsWith(suffix)) counts.reads++;
    return originalReadFile.call(this, target, ...rest);
  };
  JSON.parse = function (text, ...rest) {
    if (text === fileText) counts.parses++;
    return originalParse.call(this, text, ...rest);
  };
  try {
    counts.result = await fn();
  } finally {
    fsPromises.readFile = originalReadFile;
    JSON.parse = originalParse;
  }
  return counts;
}

console.log('\n🧪 file() collection listing\n' + '='.repeat(40));

await check('the counter sees reads through the store (positive control)', async () => {
  const { readContent } = await import('../server/utils/content-store.js');
  const counts = await countReads('people.json', () => readContent('people', 'person-7'));
  assert.equal(counts.reads, 1, counts.allReads.join('\n'));
  assert.equal(counts.parses, 1);
  assert.equal(counts.result.data.name, 'Person 7');
});

await check(`the entry list with previews reads and parses the ${ENTRY_COUNT}-entry file once`, async () => {
  const counts = await countReads('people.json', () => getCollectionEntriesWithPreview('people'));
  assert.equal(counts.reads, 1, `${counts.reads} reads`);
  assert.equal(counts.parses, 1, `${counts.parses} parses`);
  const entries = counts.result;
  assert.equal(entries.length, ENTRY_COUNT + 2);
  assert.deepEqual(entries[0], { slug: 'person-0', title: 'Person 0', preview: 'About person 0', data: people[0] });
  assert.equal(entries[3].preview, `${'x'.repeat(100)}...`);
  // An item with no id is listed by its index and cannot be read by it.
  assert.deepEqual(entries[ENTRY_COUNT], { slug: String(ENTRY_COUNT), title: String(ENTRY_COUNT), preview: '' });
  // A repeated id lists twice, and both show the first item, as a read would.
  assert.equal(entries[ENTRY_COUNT + 1].slug, 'person-1');
  assert.equal(entries[ENTRY_COUNT + 1].title, 'Person 1');
});

await check('the collection list reads and parses the file once for its entry titles', async () => {
  const counts = await countReads('people.json', () => getAllCollections());
  assert.equal(counts.reads, 1, `${counts.reads} reads`);
  assert.equal(counts.parses, 1, `${counts.parses} parses`);
  const collection = counts.result.find((item) => item.name === 'people');
  assert.equal(collection.entryCount, ENTRY_COUNT + 2);
  assert.equal(collection.entryTitles['person-42'], 'Person 42');
  assert.equal(collection.entryTitles['person-1'], 'Person 1');
  assert.equal(collection.entryTitles[String(ENTRY_COUNT)], String(ENTRY_COUNT));
  const pages = counts.result.find((item) => item.name === 'pages');
  assert.deepEqual(pages.entryTitles, { about: 'About', home: 'Home' });
});

await check('a glob() collection reads each entry file once', async () => {
  const counts = await countReads('.md', () => getCollectionEntriesWithPreview('pages'));
  assert.equal(counts.reads, 2, counts.allReads.join('\n'));
  assert.deepEqual(counts.result.map((entry) => [entry.slug, entry.title]), [['about', 'About'], ['home', 'Home']]);
});

await check('an undeclared collection is still refused', async () => {
  await assert.rejects(() => getCollectionEntriesWithPreview('nope'), (error) => error.code === 'INVALID_CONTENT_PATH');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
fs.rmSync(projectRoot, { recursive: true, force: true });
process.exit(process.exitCode || 0);
