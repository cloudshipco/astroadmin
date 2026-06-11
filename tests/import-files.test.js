/**
 * File → DB importer test (Phase 7)
 *
 * Builds a throwaway Astro 6 project (glob-loader collections + sample files),
 * runs importFiles(), and asserts the rows landed in the content database.
 * node_modules is symlinked so the schema parser can resolve zod. Env is set
 * before dynamically importing config/db so they pick up the temp paths.
 *
 *   bun tests/import-files.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-import-'));

let passed = 0;
// Failure sentinel: already reported by check(), just unwinds to the outer
// catch so the finally cleanup still runs (process.exit would skip it).
class CheckFailed extends Error {}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    throw new CheckFailed(name);
  }
}

try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');

  // Content config with Astro 6 glob loaders.
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'src/content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({ title: z.string() }),
});
const testimonials = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/testimonials' }),
  schema: z.object({ name: z.string() }),
});
const metadata = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/metadata' }),
  schema: z.object({ siteName: z.string() }),
});
const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/articles' }),
  schema: z.object({ title: z.string() }),
});

export const collections = { pages, testimonials, metadata, articles };
`
  );

  // Sample content (mirrors rhythm-works-east: md pages/testimonials, json metadata).
  fs.mkdirSync(path.join(tmpRoot, 'src/content/pages'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/pages/guides'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/testimonials'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/metadata'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/articles/news'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/home.md'), '---\ntitle: Home\n---\n# Welcome');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/about.md'), '---\ntitle: About\n---\nAbout us');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/guides/start.md'), '---\ntitle: Start\n---\nStart here');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/home-old.md.bak'), 'should be ignored');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/testimonials/alan.md'), '---\nname: Alan\n---\nGreat teacher');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/metadata/site.json'), JSON.stringify({ siteName: 'Acme' }));
  fs.writeFileSync(path.join(tmpRoot, 'src/articles/news/deep-dive.md'), '---\ntitle: Deep Dive\n---\nArticle');

  // Point config/db at the temp project BEFORE importing them.
  process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;
  process.env.ASTROADMIN_DB = path.join(tmpRoot, 'content.db');

  const { importFiles } = await import('../server/utils/import-files.js');
  const { getEntry, listSlugs } = await import('../server/utils/db.js');
  const { clearSchemaCache } = await import('../server/utils/collections.js');

  const summary = await importFiles();

  console.log('\n🧪 File → DB importer\n' + '='.repeat(40));

  await check('imports the expected counts (skips .bak)', () => {
    assert.equal(summary.collections.pages, 3, 'three pages including nested guide');
    assert.equal(summary.collections.testimonials, 1, 'one testimonial');
    assert.equal(summary.collections.metadata, 1, 'one metadata entry');
    assert.equal(summary.collections.articles, 1, 'one article from custom base');
    assert.equal(summary.total, 6, 'six total');
  });

  await check('markdown pages become content entries with body', () => {
    const home = getEntry('pages', 'home');
    assert.equal(home.type, 'content', 'type content');
    assert.equal(JSON.parse(home.data).title, 'Home', 'frontmatter');
    assert.equal(home.body, '# Welcome', 'body preserved');
    assert.ok(home.digest, 'digest computed');
  });

  await check('nested glob entries keep their relative slug', () => {
    const guide = getEntry('pages', 'guides/start');
    assert.equal(guide.type, 'content', 'type content');
    assert.equal(JSON.parse(guide.data).title, 'Start', 'frontmatter');
  });

  await check('glob loader base is honoured', () => {
    const article = getEntry('articles', 'news/deep-dive');
    assert.equal(article.type, 'content', 'type content');
    assert.equal(JSON.parse(article.data).title, 'Deep Dive', 'custom base content imported');
  });

  await check('json metadata becomes a data entry (no body)', () => {
    const site = getEntry('metadata', 'site');
    assert.equal(site.type, 'data', 'type data');
    assert.equal(site.body, null, 'no body');
    assert.equal(JSON.parse(site.data).siteName, 'Acme', 'data preserved');
  });

  await check('listing reflects imported slugs', () => {
    assert.deepEqual(listSlugs('pages').sort(), ['about', 'guides/start', 'home'], 'page slugs');
    assert.equal(listSlugs('metadata').length, 1, 'metadata slug');
  });

  await check('re-running is idempotent', async () => {
    const second = await importFiles();
    assert.equal(second.total, 6, 'same count, no duplicates');
    assert.deepEqual(listSlugs('pages').sort(), ['about', 'guides/start', 'home'], 'still three pages');
  });

  await check('failed imports do not partially write entries', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'src/content.config.ts'),
      `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({ title: z.string() }),
});
const broken = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/broken' }),
  schema: z.object({ title: z.string() }),
});

export const collections = { pages, broken };
`
    );
    fs.mkdirSync(path.join(tmpRoot, 'src/content/broken'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/contact.md'), '---\ntitle: Contact\n---\nContact');
    fs.writeFileSync(path.join(tmpRoot, 'src/content/broken/bad.json'), '{"title":');

    clearSchemaCache();
    await assert.rejects(() => importFiles(), SyntaxError);
    assert.equal(getEntry('pages', 'contact'), null, 'new page was not partially imported');
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} catch (error) {
  if (!(error instanceof CheckFailed)) {
    console.error(`❌ Test setup failed\n   ${error.stack || error.message}`);
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
