/**
 * DB → files exporter test (inverse of import-files)
 *
 * Builds a throwaway Astro 6 project (glob + file() collections), imports the
 * sample files into the DB, wipes the on-disk content, then runs exportFiles()
 * and asserts the files are recreated with the same parsed content and that a
 * file() collection keeps its array order. node_modules is symlinked so the
 * schema parser can resolve zod.
 *
 *   bun tests/export-files.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import matter from 'gray-matter';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-export-'));

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

  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'src/content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({ title: z.string() }),
});
const metadata = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/metadata' }),
  schema: z.object({ siteName: z.string() }),
});
const posts = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/posts' }),
  schema: z.object({ title: z.string() }),
});
const team = defineCollection({
  loader: file('./src/data/team.json'),
  schema: z.object({ id: z.string(), name: z.string() }),
});

export const collections = { pages, metadata, posts, team };
`
  );

  fs.mkdirSync(path.join(tmpRoot, 'src/content/pages/guides'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/metadata'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content/posts'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/home.md'), '---\ntitle: Home\n---\n# Welcome');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/pages/guides/start.md'), '---\ntitle: Start\n---\nStart here');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/metadata/site.json'), JSON.stringify({ siteName: 'Acme' }));
  fs.writeFileSync(path.join(tmpRoot, 'src/content/posts/first.mdx'), '---\ntitle: First\n---\n<Note>MDX body</Note>');
  fs.writeFileSync(
    path.join(tmpRoot, 'src/data/team.json'),
    JSON.stringify([
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
      { id: 'carol', name: 'Carol' },
    ])
  );

  // Files mode for export's writer; DB seeded via the importer below.
  process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;
  process.env.ASTROADMIN_DB = path.join(tmpRoot, 'content.db');

  const { importFiles } = await import('../server/utils/import-files.js');
  const { exportFiles } = await import('../server/utils/export-files.js');

  // Seed the DB from the sample files, then remove the on-disk content so the
  // export has to fully reconstruct it.
  await importFiles();
  fs.rmSync(path.join(tmpRoot, 'src/content'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpRoot, 'src/data'), { recursive: true, force: true });

  const summary = await exportFiles();

  console.log('\n🧪 DB → files exporter\n' + '='.repeat(40));

  await check('export summary counts every entry', () => {
    assert.equal(summary.collections.pages, 2, 'two pages');
    assert.equal(summary.collections.metadata, 1, 'one metadata');
    assert.equal(summary.collections.posts, 1, 'one post');
    assert.equal(summary.collections.team, 3, 'three team members');
    assert.equal(summary.total, 7, 'seven total entries');
  });

  await check('markdown content is re-created with frontmatter + body', () => {
    const file = path.join(tmpRoot, 'src/content/pages/home.md');
    assert.ok(fs.existsSync(file), 'home.md written');
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    assert.equal(parsed.data.title, 'Home', 'frontmatter round-trips');
    assert.equal(parsed.content.trim(), '# Welcome', 'body round-trips');
  });

  await check('nested glob slug maps back to a nested path', () => {
    const file = path.join(tmpRoot, 'src/content/pages/guides/start.md');
    assert.ok(fs.existsSync(file), 'guides/start.md written at nested path');
    assert.equal(matter(fs.readFileSync(file, 'utf-8')).data.title, 'Start', 'frontmatter');
  });

  await check('an mdx-pattern collection round-trips as .mdx', () => {
    const file = path.join(tmpRoot, 'src/content/posts/first.mdx');
    assert.ok(fs.existsSync(file), 'first.mdx written with the pattern\'s extension');
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'src/content/posts/first.md')), 'no stray .md sibling');
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    assert.equal(parsed.data.title, 'First', 'frontmatter round-trips');
    assert.equal(parsed.content.trim(), '<Note>MDX body</Note>', 'MDX body round-trips');
  });

  await check('json data collection is re-created (no frontmatter)', () => {
    const file = path.join(tmpRoot, 'src/content/metadata/site.json');
    assert.ok(fs.existsSync(file), 'site.json written');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).siteName, 'Acme', 'data round-trips');
  });

  await check('file() collection re-creates the JSON array in order', () => {
    const file = path.join(tmpRoot, 'src/data/team.json');
    assert.ok(fs.existsSync(file), 'team.json written to loader path');
    const arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(
      arr.map((m) => m.id),
      ['alice', 'bob', 'carol'],
      'array order preserved'
    );
    assert.equal(arr[1].name, 'Bob', 'member data preserved');
  });

  await check('file() collections: first entry can be created when the JSON file is missing', async () => {
    const { writeContent: writeViaFileStore } = await import('../server/utils/content-files.js');
    fs.rmSync(path.join(tmpRoot, 'src/data/team.json'));
    await writeViaFileStore('team', 'dave', { data: { id: 'dave', name: 'Dave' }, type: 'data' }, null);
    const arr = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'src/data/team.json'), 'utf-8'));
    assert.deepEqual(arr, [{ id: 'dave', name: 'Dave' }], 'array file created with the first entry');
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
