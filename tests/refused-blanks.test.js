/**
 * #70: a "" inside a block is dropped on save only where the site's REAL zod
 * refuses it (server/utils/content-validation.js `dropRefusedBlanks`, called
 * by the content routes with the save's `blankOptionals`).
 *
 * The candidate list comes from the client, so it is untrusted: a path to a
 * non-empty value, a required key, a prototype key, a path outside the entry
 * or not a form path at all removes nothing. A refinement at a PARENT path
 * never drops a candidate (exact path only), an image() field's "" counts as
 * refused (its bundled stand-in accepts "", the build does not), and with the
 * schemas unloadable the save writes everything as sent.
 *
 * Throwaway site on this repo's zod (4), its config parsed by the real parser;
 * then the real `createServer()` app over HTTP. The block-level round trip
 * through the renderer, zod 4 and zod 3, is blank-optional-round-trip.
 *
 *   bun tests/refused-blanks.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-refused-blanks-')));
const projectRoot = path.join(tmpRoot, 'site');
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};
fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
fs.symlinkSync(path.join(repoRoot, 'node_modules', 'zod'), path.join(projectRoot, 'node_modules', 'zod'), 'dir');
writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
writeFile(path.join(projectRoot, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/pages' }),
    schema: ({ image }) => z.object({
      title: z.string(),
      blocks: z.array(z.discriminatedUnion('type', [
        z.object({
          type: z.literal('note'),
          heading: z.string().min(1),
          minOpt: z.string().min(1).optional(),
          opt: z.string().optional(),
          email: z.string().email().optional(),
          picture: image().optional(),
        }),
        z.object({
          type: z.literal('pair'),
          first: z.string().optional(),
          second: z.string().optional(),
        }).refine((block) => block.first !== '' || block.second !== '', { message: 'Fill one of them' }),
      ])),
    }),
  }),
};
`);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}\n   ${String(error.message).split('\n').join('\n   ')}`);
  }
}

try {
  const { dropRefusedBlanks } = await import('../server/utils/content-validation.js');
  const { loadSchemas, clearSchemaCache, setSchemaParserForTests } = await import('../server/utils/collections.js');
  const pages = (await loadSchemas()).pages;
  assert.ok(pages?._zodSchema, 'control: the real parser loaded the collection with its zod schema');

  const note = (fields) => ({ type: 'note', heading: 'H', ...fields });
  const entry = (...blocks) => ({ title: 'T', blocks });

  await check('a candidate the site\'s zod refuses at its own path is dropped; an accepted one is kept', async () => {
    const data = entry(note({ minOpt: '', opt: '' }));
    const result = await dropRefusedBlanks(pages, data, ['blocks[0].minOpt', 'blocks[0].opt']);
    assert.deepStrictEqual(result, entry(note({ opt: '' })));
    assert.deepStrictEqual(data, entry(note({ minOpt: '', opt: '' })), 'the data sent is not mutated');
  });

  await check('an image() field\'s "" counts as refused (the stand-in accepts it, the build does not)', async () => {
    const result = await dropRefusedBlanks(pages, entry(note({ picture: '' })), ['blocks[0].picture']);
    assert.deepStrictEqual(result, entry(note()));
  });

  await check('a refinement at the PARENT path drops nothing', async () => {
    const data = entry({ type: 'pair', first: '', second: '' });
    const validation = await pages._zodSchema.safeParseAsync(data);
    assert.ok(!validation.success && validation.error.issues.some((issue) => issue.path.join('.') === 'blocks.0'), 'control: the block-level refinement fires at blocks[0]');
    assert.deepStrictEqual(await dropRefusedBlanks(pages, data, ['blocks[0].first', 'blocks[0].second']), data);
  });

  await check('hostile candidates remove nothing they should not', async () => {
    const data = JSON.parse(JSON.stringify(entry(note({ email: 'not-an-email', minOpt: '' }), note({ heading: '' }))));
    // An own __proto__ key, as JSON.parse makes it.
    data.blocks[0] = JSON.parse('{"type":"note","heading":"H","email":"not-an-email","minOpt":"","__proto__":""}');
    const before = JSON.stringify(data);
    const hostile = [
      'blocks[0].email', // refused, but not ""
      'blocks[1].heading', // "" and refused, but REQUIRED: absent is refused too
      'blocks[0].__proto__', '__proto__', 'constructor', 'blocks[0].constructor',
      'blocks[9].minOpt', 'blocks[0].minOpt.deeper', 'blocks[0]', 'blocks', '',
      '[0].minOpt', 'blocks..x', 'blocks[0]minOpt', 'blocks[-1].minOpt', 'blocks[0].',
      42, null, { path: 'blocks[0].minOpt' }, ['blocks', 0, 'minOpt'],
      'x'.repeat(5000),
    ];
    const result = await dropRefusedBlanks(pages, data, hostile);
    assert.strictEqual(JSON.stringify(result), before, 'nothing removed');
    assert.ok(Object.hasOwn(result.blocks[0], '__proto__'), 'the own __proto__ key is still there');
    const withReal = await dropRefusedBlanks(pages, data, [...hostile, 'blocks[0].minOpt']);
    const expected = JSON.parse(before);
    delete expected.blocks[0].minOpt;
    assert.strictEqual(JSON.stringify(withReal), JSON.stringify(expected), 'positive control: a real candidate beside them is dropped, and only it');
  });

  await check('no schema, no zod, or no candidates: the data comes back as it was', async () => {
    const data = entry(note({ minOpt: '' }));
    assert.strictEqual(await dropRefusedBlanks(undefined, data, ['blocks[0].minOpt']), data);
    assert.strictEqual(await dropRefusedBlanks({ schema: pages.schema }, data, ['blocks[0].minOpt']), data);
    assert.strictEqual(await dropRefusedBlanks(pages, data, 'blocks[0].minOpt'), data);
    assert.strictEqual(await dropRefusedBlanks(pages, data, []), data);
  });

  // --- Over HTTP, through the real routes --------------------------------------
  const entryFile = path.join(projectRoot, 'src/content/pages/page.json');
  const STORED_TEXT = `${JSON.stringify(entry(note({ minOpt: 'm', opt: 'o' })), null, 2)}\n`;
  writeFile(entryFile, STORED_TEXT);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); originalError(...args); };

  const { createServer } = await import('../server/index.js');
  const { app } = await createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(login.status, 200, 'login');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const save = async (method, body) => {
      writeFile(entryFile, STORED_TEXT);
      const response = await fetch(`${base}/api/content/pages/page`, {
        method, headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), saved: JSON.parse(fs.readFileSync(entryFile, 'utf8')) };
    };
    const blankBlock = { data: entry(note({ minOpt: '', opt: '' })), type: 'data', blankOptionals: ['blocks[0].minOpt', 'blocks[0].opt'] };

    for (const method of ['POST', 'PUT']) {
      await check(`${method}: a refused candidate is not written, an accepted one is, and the save is valid`, async () => {
        const { status, json, saved } = await save(method, blankBlock);
        assert.equal(status, 200);
        assert.deepStrictEqual(saved, entry(note({ opt: '' })));
        assert.equal(json.validation.status, 'valid', JSON.stringify(json.validation));
      });
    }

    await check('control: with no blankOptionals the "" is written as sent (and reported invalid)', async () => {
      const { status, json, saved } = await save('POST', { data: blankBlock.data, type: 'data' });
      assert.equal(status, 200);
      assert.deepStrictEqual(saved, blankBlock.data);
      assert.equal(json.validation.status, 'invalid');
    });

    await check('schemas that cannot be loaded: the save still writes, everything as sent', async () => {
      // The first load (the blank check's) fails; the store's own load, just
      // after, succeeds, as when a config is being fixed mid-save. A store
      // that cannot load the schemas at all refuses the save on its own.
      const { parseAstroSchemas } = await import('../server/utils/schema-parser.js');
      let loads = 0;
      setSchemaParserForTests(async (root) => {
        loads++;
        if (loads === 1) throw new Error('config does not bundle (test)');
        return parseAstroSchemas(root);
      });
      clearSchemaCache();
      logged.length = 0;
      try {
        const { status, saved } = await save('POST', blankBlock);
        assert.equal(status, 200);
        assert.deepStrictEqual(saved, blankBlock.data);
        assert.ok(logged.some((line) => line.includes('blank optionals') && line.includes('config does not bundle (test)')), 'the reason is in the server log');
      } finally {
        setSchemaParserForTests(null);
        clearSchemaCache();
      }
    });
  } finally {
    server.close();
    console.error = originalError;
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
