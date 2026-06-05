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
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exit(1);
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

export const collections = { pages, testimonials, metadata };
`
  );

  // Sample content (mirrors rhythm-works-east: md pages/testimonials, json metadata).
  fs.mkdirSync(path.join(tmpRoot, 'src/content/pages'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/testimonials'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/metadata'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/home.md'), '---\ntitle: Home\n---\n# Welcome');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/about.md'), '---\ntitle: About\n---\nAbout us');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/home-old.md.bak'), 'should be ignored');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/testimonials/alan.md'), '---\nname: Alan\n---\nGreat teacher');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/metadata/site.json'), JSON.stringify({ siteName: 'Acme' }));

  // Point config/db at the temp project BEFORE importing them.
  process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;
  process.env.ASTROADMIN_DB = path.join(tmpRoot, 'content.db');

  const { importFiles } = await import('../server/utils/import-files.js');
  const { getEntry, listSlugs } = await import('../server/utils/db.js');

  const summary = await importFiles();

  console.log('\n🧪 File → DB importer\n' + '='.repeat(40));

  check('imports the expected counts (skips .bak)', () => {
    assert.equal(summary.collections.pages, 2, 'two pages (home, about)');
    assert.equal(summary.collections.testimonials, 1, 'one testimonial');
    assert.equal(summary.collections.metadata, 1, 'one metadata entry');
    assert.equal(summary.total, 4, 'four total');
  });

  check('markdown pages become content entries with body', () => {
    const home = getEntry('pages', 'home');
    assert.equal(home.type, 'content', 'type content');
    assert.equal(JSON.parse(home.data).title, 'Home', 'frontmatter');
    assert.equal(home.body, '# Welcome', 'body preserved');
    assert.ok(home.digest, 'digest computed');
  });

  check('json metadata becomes a data entry (no body)', () => {
    const site = getEntry('metadata', 'site');
    assert.equal(site.type, 'data', 'type data');
    assert.equal(site.body, null, 'no body');
    assert.equal(JSON.parse(site.data).siteName, 'Acme', 'data preserved');
  });

  check('listing reflects imported slugs', () => {
    assert.deepEqual(listSlugs('pages').sort(), ['about', 'home'], 'page slugs');
    assert.equal(listSlugs('metadata').length, 1, 'metadata slug');
  });

  check('re-running is idempotent', async () => {
    const second = await importFiles();
    assert.equal(second.total, 4, 'same count, no duplicates');
    assert.deepEqual(listSlugs('pages').sort(), ['about', 'home'], 'still two pages');
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
  process.exit(0);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
