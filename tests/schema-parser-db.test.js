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

export const collections = { pages, team };
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

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
  process.exit(0);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
