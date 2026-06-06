/**
 * Schema parser test for db-backed collections (Chunk ② — Astro 6 loader)
 *
 * Builds a throwaway Astro project whose content.config.ts imports
 * `astroadmin/loader`, and asserts the parser's astroadmin/loader shim records
 * loaderType 'db' (and honours the optional `type` hint) while still extracting
 * the Zod schema.
 *
 * node_modules is symlinked from this repo so esbuild can resolve `zod`.
 *
 *   bun tests/schema-parser-db.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseAstroSchemas } from '../server/utils/schema-parser.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-parser-'));

try {
  // Symlink node_modules so the bundler resolves the project's zod.
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');

  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'src/content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
import { astroadminLoader } from 'astroadmin/loader';

const pages = defineCollection({
  loader: astroadminLoader({ collection: 'pages' }),
  schema: z.object({ title: z.string() }),
});

const team = defineCollection({
  loader: astroadminLoader({ collection: 'team', type: 'data' }),
  schema: z.object({ name: z.string() }),
});

// Block-based page: a discriminated union drives the block editor UI.
const heroBlock = z.object({ type: z.literal('hero'), heading: z.string() });
const featuresBlock = z.object({
  type: z.literal('features'),
  testimonialIds: z.array(z.string()).optional(),
});
const blocks = z.discriminatedUnion('type', [heroBlock, featuresBlock]);

const landing = defineCollection({
  loader: astroadminLoader({ collection: 'landing' }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    blocks: z.array(blocks),
  }),
});

export const collections = { pages, team, landing };
`
  );

  const schemas = await parseAstroSchemas(tmpRoot);

  let passed = 0;
  function check(name, fn) {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  }

  console.log('\n🧪 Schema parser (db loader)\n' + '='.repeat(40));

  check('db loaderType is recorded', () => {
    assert.equal(schemas.pages.loaderType, 'db', 'pages is db-backed');
    assert.equal(schemas.team.loaderType, 'db', 'team is db-backed');
  });

  check('type hint is honoured', () => {
    assert.equal(schemas.pages.type, 'content', 'pages defaults to content');
    assert.equal(schemas.team.type, 'data', 'team uses type: data hint');
  });

  check('zod schema still extracted', () => {
    assert.ok(schemas.pages.schema.properties.title, 'title property present');
    assert.ok(schemas.team.schema.properties.name, 'name property present');
  });

  check('schema with coerce.date does not break extraction', () => {
    // z.coerce.date() is unrepresentable in JSON Schema; it must not throw away
    // the surrounding properties (regression: zod 4 toJSONSchema throws by default).
    assert.ok(schemas.landing.schema.properties.title, 'title present alongside date field');
    assert.ok('pubDate' in schemas.landing.schema.properties, 'date field still listed');
  });

  check('discriminated unions are detected for the block editor', () => {
    const unions = schemas.landing.discriminatedUnions;
    assert.equal(unions.length, 1, 'one discriminated union found');
    assert.equal(unions[0].discriminator, 'type', 'discriminator is "type"');
    const values = unions[0].options.map((o) => o.value).sort();
    assert.deepEqual(values, ['features', 'hero'], 'both block types extracted');
    const hero = unions[0].options.find((o) => o.value === 'hero');
    assert.ok(hero.schema.properties.heading, 'option schema properties extracted');
  });

  check('block-collection references are detected from union options', () => {
    // featuresBlock.testimonialIds (array of strings) -> "testimonials" collection
    const refs = schemas.landing.blockCollectionRefs.testimonials;
    assert.ok(refs, 'testimonials referenced');
    assert.ok(
      refs.some((r) => r.blockType === 'features' && r.field === 'testimonialIds'),
      'features block references testimonials via testimonialIds'
    );
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
  process.exit(0);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
