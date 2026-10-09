/**
 * A save changes only what the editor changed (server/utils/content-format.js,
 * through the files store's writeContent).
 *
 * The editor sends an entry's keys in its own order (form order, a file()
 * entry's `id` last) and dates as strings. A save must still keep existing keys
 * where they were, leave untouched file() entries and frontmatter keys byte for
 * byte, keep an inline JSON array inline, and keep an unquoted YAML date a date
 * (z.date() refuses the quoted string it used to become).
 *
 * Self-contained: builds its own temp project root.
 *
 *   bun tests/content-round-trip.test.js
 */

import assert from 'assert';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'aa-roundtrip-'));
process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;
delete process.env.ASTROADMIN_CONTENT_STORE;
fsSync.symlinkSync(path.resolve(import.meta.dir, '..', 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
fsSync.mkdirSync(path.join(tmpRoot, 'src/content/pages'), { recursive: true });
fsSync.writeFileSync(path.join(tmpRoot, 'src/content.config.ts'), `import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), draft: z.boolean(), publishDate: z.date(), tags: z.array(z.string()) }),
  }),
  authors: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/authors' }),
    schema: z.object({ name: z.string() }),
  }),
  team: defineCollection({
    loader: file('src/content/team.json'),
    schema: z.object({ name: z.string(), active: z.boolean(), skills: z.array(z.string()) }),
  }),
};
`);

const TEAM_JSON = `[
  {
    "id": "ada",
    "name": "Ada",
    "active": true,
    "skills": ["analysis", "engines"]
  },
  {
    "id": "grace",
    "name": "Grace",
    "active": false,
    "skills": ["compilers"]
  }
]
`;

const HOME_MD = `---
title: Welcome home
draft: false
# shown on the index page
publishDate: 2026-01-15
tags:
  - intro
  - welcome
---

This is the **home** page body.
`;

const teamPath = path.join(tmpRoot, 'src/content/team.json');
const homePath = path.join(tmpRoot, 'src/content/pages/home.md');

const { readContent, writeContent } = await import('../server/utils/content.js');
const matter = (await import('gray-matter')).default;

let passed = 0;
let failed = 0;
class CheckFailed extends Error {}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    failed++;
  }
}

/** What the editor sends back for an entry: its own key order, `id` dropped. */
async function editorSave(collection, slug, change, keyOrder) {
  const entry = await readContent(collection, slug);
  const data = JSON.parse(JSON.stringify(entry.data)); // dates become ISO strings, as over HTTP
  delete data.id;
  Object.assign(data, change);
  const reordered = {};
  for (const key of keyOrder) if (key in data) reordered[key] = data[key];
  for (const key of Object.keys(data)) if (!(key in reordered)) reordered[key] = data[key];
  await writeContent(collection, slug, { data: reordered, body: entry.body, type: entry.type });
}

try {
  console.log('\n🧪 A save changes only what the editor changed\n' + '='.repeat(40));

  await check('file(): an edited entry keeps its key order and id position; the other entry is byte-identical', async () => {
    fsSync.writeFileSync(teamPath, TEAM_JSON);
    await editorSave('team', 'ada', { active: false }, ['skills', 'active', 'name']);
    const after = fsSync.readFileSync(teamPath, 'utf-8');
    // Positive control: the edit landed.
    assert.equal(JSON.parse(after)[0].active, false, 'the edit was saved');
    assert.deepEqual(Object.keys(JSON.parse(after)[0]), ['id', 'name', 'active', 'skills'], 'key order kept, id first');
    assert.equal(after, TEAM_JSON.replace('"active": true', '"active": false'), `only the edited value changed:\n${after}`);
  });

  await check('file(): a new key is appended after the existing ones', async () => {
    fsSync.writeFileSync(teamPath, TEAM_JSON);
    await editorSave('team', 'grace', { role: 'Admiral' }, ['role', 'name', 'skills', 'active']);
    const parsed = JSON.parse(fsSync.readFileSync(teamPath, 'utf-8'));
    assert.deepEqual(Object.keys(parsed[1]), ['id', 'name', 'active', 'skills', 'role']);
    assert.deepEqual(parsed[1].skills, ['compilers']);
  });

  await check('frontmatter: an edit keeps key order, comments, and an unquoted date unquoted', async () => {
    fsSync.writeFileSync(homePath, HOME_MD);
    await editorSave('pages', 'home', { title: 'Welcome back', publishDate: '2026-01-15' }, ['title', 'publishDate', 'tags', 'draft']);
    const after = fsSync.readFileSync(homePath, 'utf-8');
    assert.equal(after, HOME_MD.replace('title: Welcome home', 'title: Welcome back'), `only the title changed:\n${after}`);
    const reread = await readContent('pages', 'home');
    assert.ok(reread.data.publishDate instanceof Date, 'publishDate is still a Date for Astro');
    assert.equal(reread.body.trim(), 'This is the **home** page body.', 'body kept');
  });

  await check('frontmatter: a changed unquoted date stays an unquoted, date-only date', async () => {
    fsSync.writeFileSync(homePath, HOME_MD);
    await editorSave('pages', 'home', { publishDate: '2026-02-01' }, ['publishDate', 'title', 'draft', 'tags']);
    const after = fsSync.readFileSync(homePath, 'utf-8');
    assert.match(after, /^publishDate: 2026-02-01$/m, after);
    const data = matter(after, {}).data;
    assert.ok(data.publishDate instanceof Date && data.publishDate.toISOString() === '2026-02-01T00:00:00.000Z');
    assert.deepEqual(Object.keys(data), ['title', 'draft', 'publishDate', 'tags']);
  });

  await check('frontmatter: a quoted date stays a string (its type is kept either way)', async () => {
    fsSync.writeFileSync(homePath, HOME_MD.replace('publishDate: 2026-01-15', "publishDate: '2026-01-15'"));
    await editorSave('pages', 'home', { publishDate: '2026-03-01' }, ['title', 'draft', 'publishDate', 'tags']);
    const data = matter(fsSync.readFileSync(homePath, 'utf-8'), {}).data;
    assert.equal(data.publishDate, '2026-03-01');
  });

  await check('frontmatter: a removed key is dropped and a new key appended', async () => {
    fsSync.writeFileSync(homePath, HOME_MD);
    const entry = await readContent('pages', 'home');
    const data = JSON.parse(JSON.stringify(entry.data));
    delete data.draft;
    await writeContent('pages', 'home', { data: { summary: 'Hi', ...data }, body: entry.body, type: 'content' });
    const parsed = matter(fsSync.readFileSync(homePath, 'utf-8'), {});
    assert.deepEqual(Object.keys(parsed.data), ['title', 'publishDate', 'tags', 'summary']);
    assert.ok(parsed.data.publishDate instanceof Date);
  });

  await check('file(): deleting an entry leaves the others byte-identical', async () => {
    const { deleteContent } = await import('../server/utils/content.js');
    fsSync.writeFileSync(teamPath, TEAM_JSON);
    await deleteContent('team', 'ada');
    const after = fsSync.readFileSync(teamPath, 'utf-8');
    assert.equal(JSON.parse(after).length, 1, 'deleted');
    assert.ok(after.includes('"skills": ["compilers"]'), `grace kept as written:\n${after}`);
  });

  await check('file(): a file with one-item-per-line arrays keeps that style for the edited entry', async () => {
    const expanded = `${JSON.stringify(JSON.parse(TEAM_JSON), null, 2)}\n`;
    fsSync.writeFileSync(teamPath, expanded);
    await editorSave('team', 'ada', { name: 'Ada L' }, ['name', 'skills', 'active']);
    assert.equal(fsSync.readFileSync(teamPath, 'utf-8'), expanded.replace('"Ada"', '"Ada L"'));
  });

  await check('frontmatter: a nested change re-writes only that key; values the splice cannot follow fall back safely', async () => {
    fsSync.writeFileSync(homePath, HOME_MD);
    await editorSave('pages', 'home', { tags: ['intro'] }, ['tags', 'title']);
    assert.equal(fsSync.readFileSync(homePath, 'utf-8'), HOME_MD.replace('  - intro\n  - welcome\n', '  - intro\n'));
    // An alias to an anchor on an edited key: the kept text would dangle, so the
    // whole frontmatter is re-serialised, and the data is still exactly right.
    fsSync.writeFileSync(homePath, `---\ntitle: &t Welcome\ndraft: false\npublishDate: 2026-01-15\ntags:\n  - *t\n---\nBody\n`);
    await editorSave('pages', 'home', { title: 'Changed' }, ['title']);
    const parsed = matter(fsSync.readFileSync(homePath, 'utf-8'), {});
    assert.equal(parsed.data.title, 'Changed');
    assert.deepEqual(parsed.data.tags, ['Welcome']);
    assert.ok(parsed.data.publishDate instanceof Date);
    assert.equal(parsed.content.trim(), 'Body');
  });

  await check('a new entry in a JSON-only glob() collection is a .json file the loader reads, whatever type the editor sends', async () => {
    const result = await writeContent('authors', 'new-author', { data: { name: 'New Author' }, body: '', type: 'content' });
    assert.equal(path.extname(result.filePath), '.json', result.filePath);
    assert.ok(!fsSync.existsSync(path.join(tmpRoot, 'src/content/authors/new-author.md')), 'no unreadable .md');
    assert.deepEqual(JSON.parse(fsSync.readFileSync(path.join(tmpRoot, 'src/content/authors/new-author.json'), 'utf-8')), { name: 'New Author' });
    const reread = await readContent('authors', 'new-author');
    assert.equal(reread.data.name, 'New Author');
  });

  await check('a new entry follows the schema: its z.date() field is an unquoted date', async () => {
    // No original to follow, so key order is the editor's. publishDate is z.date()
    // in this collection, and the schema parser marks it a date, so the new value
    // must be a YAML date: a quoted string would fail z.date() at build time.
    await writeContent('pages', 'fresh', { data: { title: 'Fresh', draft: true, publishDate: '2026-04-01', tags: [] }, body: 'Hi', type: 'content' });
    const written = fsSync.readFileSync(path.join(tmpRoot, 'src/content/pages/fresh.md'), 'utf-8');
    assert.equal(written, '---\ntitle: Fresh\ndraft: true\npublishDate: 2026-04-01\ntags: []\n---\nHi\n');
    assert.ok(matter(written, {}).data.publishDate instanceof Date, 'publishDate reads back as a Date');
  });

  // Fields the collection's schema says are dates (format date / date-time in
  // the parsed JSON schema). The schema parser decides that; here the
  // serialiser is handed the set, as content-files.js does.
  const { serializeMarkdown, dateFieldsFromSchema } = await import('../server/utils/content-format.js');

  await check('schema date field: a NEW YYYY-MM-DD value is written as an unquoted date (new entry and new key)', () => {
    const dateFields = new Set(['publishDate']);
    const fresh = serializeMarkdown('Hi', { title: 'T', publishDate: '2026-02-01' }, null, { dateFields });
    assert.match(fresh, /^publishDate: 2026-02-01$/m, fresh);
    assert.ok(matter(fresh, {}).data.publishDate instanceof Date);
    const added = serializeMarkdown('Hi', { title: 'T', publishDate: '2026-02-01' }, '---\ntitle: T\n---\nHi\n', { dateFields });
    assert.equal(added, '---\ntitle: T\npublishDate: 2026-02-01\n---\nHi\n');
  });

  await check('schema date field: an existing quoted (string) value stays a string; a non-date field is never converted', () => {
    const dateFields = new Set(['publishDate']);
    const kept = serializeMarkdown('Hi', { publishDate: '2026-03-01' }, "---\npublishDate: '2026-01-15'\n---\nHi\n", { dateFields });
    assert.equal(matter(kept, {}).data.publishDate, '2026-03-01');
    const other = serializeMarkdown('Hi', { code: '2026-02-01' }, null, { dateFields });
    assert.equal(matter(other, {}).data.code, '2026-02-01', 'not in the date set: stays a string');
    const noSchema = serializeMarkdown('Hi', { publishDate: '2026-02-01' }, null);
    assert.equal(matter(noSchema, {}).data.publishDate, '2026-02-01', 'no schema information: no guessing from the string');
  });

  await check('dateFieldsFromSchema reads top-level format date / date-time (through anyOf for optional/nullable)', () => {
    const fields = dateFieldsFromSchema({ type: 'object', properties: {
      a: { type: 'string', format: 'date' },
      b: { type: 'string', format: 'date-time' },
      c: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
      d: { type: 'string' },
      e: { type: 'string', format: 'email' },
    } });
    assert.deepEqual([...fields].sort(), ['a', 'b', 'c']);
    assert.equal(dateFieldsFromSchema(null).size, 0);
  });

  await check('the files store hands the collection schema\'s date fields to the serialiser', async () => {
    // What the schema parser emits for a date field (zod 3 does natively; the
    // zod 4 path is the parser's job). Set on the cached parse, as the parser
    // would produce it.
    const { loadSchemas } = await import('../server/utils/collections.js');
    const schemas = await loadSchemas();
    const original = schemas.pages.schema.properties.publishDate;
    schemas.pages.schema.properties.publishDate = { type: 'string', format: 'date' };
    try {
      await writeContent('pages', 'dated', { data: { title: 'Dated', draft: false, publishDate: '2026-05-01', tags: [] }, body: 'Hi', type: 'content' });
      const written = fsSync.readFileSync(path.join(tmpRoot, 'src/content/pages/dated.md'), 'utf-8');
      assert.match(written, /^publishDate: 2026-05-01$/m, written);
    } finally {
      schemas.pages.schema.properties.publishDate = original;
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed, ${failed} failed.\n`);
  if (failed > 0) process.exitCode = 1;
} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(`❌ Test setup failed\n   ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  fsSync.rmSync(tmpRoot, { recursive: true, force: true });
}
