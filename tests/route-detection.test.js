/**
 * Auto-detected preview routes (server/utils/routes.js) name only collections
 * the content config declares. A root `[...slug].astro` used to be reported at
 * startup as "slugs -> /{slug}, slug -> /{slug}": guesses from the parameter
 * name, printed before they were matched against any collection.
 *
 * Also which block a non-page collection's component preview renders
 * (getCollectionUsedByBlocks): a block field `<name>Ids` refers to the
 * collection `<name>s`, or `<name>` when that is the declared one (`teamIds`
 * -> `team`).
 *
 * And that a schema reload (clearSchemaCache, which the content-config watcher
 * calls) re-derives the routes: a collection added for an existing dynamic
 * page used to stay route-less until restart, because the route cache was
 * never cleared.
 *
 *   bun tests/route-detection.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-routes-'));
process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;

function writeFile(relativePath, content) {
  const fullPath = path.join(tmpRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

fs.symlinkSync(path.resolve(import.meta.dir, '..', 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
writeFile('src/content.config.ts', `import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({
    title: z.string(),
    blocks: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('team'), heading: z.string(), teamIds: z.array(z.string()) }),
      z.object({ type: z.literal('quotes'), testimonialIds: z.array(z.string()) }),
    ])).default([]),
  }) }),
  testimonials: defineCollection({ loader: file('src/content/testimonials.json'), schema: z.object({ quote: z.string() }) }),
  posts: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/posts' }), schema: z.object({ title: z.string() }) }),
  team: defineCollection({ loader: file('src/content/team.json'), schema: z.object({ name: z.string() }) }),
};
`);
writeFile('src/pages/[...slug].astro', '---\n---\n');
writeFile('src/pages/blog/[post].astro', '---\n---\n');
writeFile('src/pages/team.astro', '---\n---\n');
// A dynamic page whose collection is not declared yet (added mid-test).
writeFile('src/pages/docs/[slug].astro', '---\n---\n');

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

try {
  console.log('\n🧪 Auto-detected preview routes\n' + '='.repeat(40));
  const { detectPreviewRoutes } = await import('../server/utils/routes.js');

  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  let routes;
  try {
    routes = await detectPreviewRoutes();
  } finally {
    console.log = originalLog;
  }

  await check('a declared collection on a dynamic route is detected (positive control)', () => {
    assert.equal(routes.posts, '/blog/{slug}', JSON.stringify(routes));
  });

  await check('parameter-name guesses that are not collections are neither returned nor logged', () => {
    assert.deepEqual(Object.keys(routes).sort(), ['posts'], JSON.stringify(routes));
    const startupLines = logged.filter((line) => line.includes('->'));
    assert.deepEqual(startupLines.map((line) => line.trim()), ['posts -> /blog/{slug}'], logged.join('\n'));
  });

  await check('component preview: a block field <name>Ids finds the declared collection, plural or not', async () => {
    const { getCollectionUsedByBlocks } = await import('../server/utils/collections.js');
    assert.deepEqual(await getCollectionUsedByBlocks('testimonials'), [{ type: 'quotes', field: 'testimonialIds' }], 'plural (positive control)');
    assert.deepEqual(await getCollectionUsedByBlocks('team'), [{ type: 'team', field: 'teamIds' }], 'teamIds -> team');
  });

  await check('a schema reload picks up a collection added for an existing dynamic page', async () => {
    const { clearSchemaCache, getCollectionNames } = await import('../server/utils/collections.js');
    assert.equal((await detectPreviewRoutes()).docs, undefined, 'control: docs is not declared yet, so no route');
    const configPath = path.join(tmpRoot, 'src/content.config.ts');
    const original = fs.readFileSync(configPath, 'utf8');
    const added = original.replace('export const collections = {',
      "export const collections = {\n  docs: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/docs' }), schema: z.object({ title: z.string() }) }),");
    assert.notEqual(added, original, 'the config edit applied');
    fs.writeFileSync(configPath, added);
    clearSchemaCache();
    assert.ok((await getCollectionNames()).includes('docs'), 'control: the reloaded schemas declare docs');
    const reloaded = await detectPreviewRoutes();
    assert.equal(reloaded.docs, '/docs/{slug}', JSON.stringify(reloaded));
    assert.equal(reloaded.posts, '/blog/{slug}', 'existing routes survive the reload');
  });

  await check('an older schema load that finishes late cannot poison the new generation', async () => {
    const { clearSchemaCache, loadSchemas, getCollectionNames, setSchemaParserForTests } = await import('../server/utils/collections.js');
    const pending = [];
    setSchemaParserForTests(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const schemasFor = (names) => Object.fromEntries(names.map((name) => [name, { name }]));
    try {
      clearSchemaCache();
      const loadA = loadSchemas(); // generation N: the old config
      clearSchemaCache(); // the config changed
      const loadB = loadSchemas(); // generation N+1: the new one
      assert.equal(pending.length, 2, 'two parses started (instrument control)');
      pending[1].resolve(schemasFor(['posts', 'docs', 'fresh']));
      await loadB;
      pending[0].resolve(schemasFor(['posts', 'stale']));
      await loadA;
      const names = await getCollectionNames();
      assert.ok(names.includes('fresh'), `the new load's collections stand (${names})`);
      assert.equal(names.includes('stale'), false, `the older load overwrote the cache (${names})`);
      const routes = await detectPreviewRoutes();
      assert.equal(routes.docs, '/docs/{slug}', `the route cache for the new generation (${JSON.stringify(routes)})`);
      assert.equal(pending.length, 2, 'no further parse was needed');
    } finally {
      setSchemaParserForTests(null);
      clearSchemaCache();
    }
  });

  await check("an older schema load that FAILS late does not drop the new load's promise", async () => {
    const { clearSchemaCache, loadSchemas, setSchemaParserForTests } = await import('../server/utils/collections.js');
    const pending = [];
    setSchemaParserForTests(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    try {
      clearSchemaCache();
      const loadA = loadSchemas();
      clearSchemaCache();
      const loadB = loadSchemas();
      pending[0].reject(new Error('the old config no longer parses'));
      await assert.rejects(loadA, /no longer parses/, 'control: the older caller sees its own failure');
      const loadC = loadSchemas();
      assert.equal(pending.length, 2, `a caller during load B joins it rather than starting a third parse (${pending.length} parses)`);
      pending[1].resolve({ posts: { name: 'posts' } });
      assert.deepEqual(Object.keys(await loadC), ['posts']);
      assert.deepEqual(Object.keys(await loadB), ['posts']);
    } finally {
      setSchemaParserForTests(null);
      clearSchemaCache();
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
