/**
 * Content validation for the editor's warnings
 *
 * Builds a throwaway Astro-shaped project (content.config.ts with glob() and
 * file() collections) and asserts:
 *   - a stored entry is judged the way the site's build judges it (a dropped
 *     required array, a missing nested block field, a YAML date vs a quoted one,
 *     a file() collection item);
 *   - a save still WRITES invalid content, and its response reports the issues.
 *
 * The publish gate is the site's own Astro, tested in tests/publish-check.test.js.
 *
 * node_modules is symlinked from this repo so the schema bundler resolves zod.
 *
 *   bun tests/content-validation.test.js
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-validate-'));

// Must be set before config loads, hence the dynamic imports below.
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
delete process.env.ASTROADMIN_CONTENT_STORE;

const CONTENT_CONFIG = `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    blocks: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('hero'), title: z.string() }),
    ])),
    published: z.date().optional(),
  }),
});

const clients = defineCollection({
  loader: file('src/content/clients.json'),
  schema: z.object({ id: z.string(), name: z.string(), url: z.string().url() }),
});

const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
});

export const collections = { pages, clients, notes };
`;

function git(...args) {
  return execFileSync('/usr/bin/git', args, { cwd: projectRoot, encoding: 'utf-8' }).trim();
}

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('astroadmin.config.js', "export default { git: { enabled: true, paths: ['src/content/'] } };\n");
writeProjectFile('.gitignore', 'node_modules\n');
writeProjectFile('src/content.config.ts', CONTENT_CONFIG);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\nblocks:\n  - type: hero\n    title: Welcome\n---\n');
writeProjectFile('src/content/clients.json', `${JSON.stringify([{ id: 'acme', name: 'Acme', url: 'https://example.com/' }], null, 2)}\n`);
writeProjectFile('src/content/notes/free-form.md', '---\nanything: [1, 2]\n---\n');

git('init', '-q');
git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '-A');
git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.com');

const { validateStoredEntry, formatIssuePath } =
  await import('../server/utils/content-validation.js');
const { writeContent } = await import('../server/utils/content.js');
const contentRouter = (await import('../server/api/content.js')).default;

function routeHandler(router, routePath, method) {
  return router.stack
    .find((layer) => layer.route?.path === routePath && layer.route.methods[method])
    .route.stack[0].handle;
}
const saveHandler = routeHandler(contentRouter, '/:collection/:slug', 'post');
const updateHandler = routeHandler(contentRouter, '/:collection/:slug', 'put');

let passed = 0;
// Failure sentinel: already reported by check(), unwinds to the finally cleanup.
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


const VALID_HOME = '---\ntitle: Home\nblocks:\n  - type: hero\n    title: Welcome\n---\n';

try {

console.log('\n🧪 Content validation\n' + '='.repeat(40));

await check('issue paths use the editor field names', () => {
  assert.equal(formatIssuePath(['blocks', 0, 'title']), 'blocks[0].title');
  assert.equal(formatIssuePath(['title']), 'title');
  assert.equal(formatIssuePath([]), '');
});

await check('the untouched entries are valid', async () => {
  assert.equal((await validateStoredEntry('pages', 'home')).status, 'valid');
  assert.equal((await validateStoredEntry('clients', 'acme')).status, 'valid');
  assert.equal((await validateStoredEntry('notes', 'free-form')).status, 'valid');
});

await check('a page saved without its required blocks array is invalid', async () => {
  await writeContent('pages', 'home', { data: { title: 'Home' }, body: '', type: 'content' });
  const validation = await validateStoredEntry('pages', 'home');
  assert.equal(validation.status, 'invalid');
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['blocks']);
});

await check('an empty required blocks array is valid', async () => {
  await writeContent('pages', 'home', { data: { title: 'Home', blocks: [] }, body: '', type: 'content' });
  assert.equal((await validateStoredEntry('pages', 'home')).status, 'valid');
});

await check('a block missing a required field is reported at its field path', async () => {
  await writeContent('pages', 'home', {
    data: { title: 'Home', blocks: [{ type: 'hero', title: 'Hi' }, { type: 'hero' }] },
    body: '',
    type: 'content',
  });
  const validation = await validateStoredEntry('pages', 'home');
  assert.equal(validation.status, 'invalid');
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['blocks[1].title']);
});

await check('frontmatter is judged after YAML parsing, as the build reads it', async () => {
  // Unquoted, YAML makes it a Date — what z.date() wants.
  writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\nblocks: []\npublished: 2024-05-01\n---\n');
  assert.equal((await validateStoredEntry('pages', 'home')).status, 'valid');
  // Quoted, it stays a string, and the build rejects it.
  writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\nblocks: []\npublished: "2024-05-01"\n---\n');
  const validation = await validateStoredEntry('pages', 'home');
  assert.equal(validation.status, 'invalid');
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['published']);
  writeProjectFile('src/content/pages/home.md', VALID_HOME);
});

await check('a file() collection item is validated on its own', async () => {
  await writeContent('clients', 'acme', { data: { id: 'acme', name: 'Acme' }, body: null, type: 'data' });
  const validation = await validateStoredEntry('clients', 'acme');
  assert.equal(validation.status, 'invalid');
  assert.deepEqual(validation.issues.map((issue) => issue.path), ['url']);
  await writeContent('clients', 'acme', {
    data: { id: 'acme', name: 'Acme', url: 'https://example.com/' }, body: null, type: 'data',
  });
  assert.equal((await validateStoredEntry('clients', 'acme')).status, 'valid');
});

await check('a collection with no schema accepts anything', async () => {
  assert.equal((await validateStoredEntry('notes', 'free-form')).status, 'valid');
});

await check('a save writes invalid content and reports why', async () => {
  const res = createJsonResponse();
  await saveHandler({
    params: { collection: 'pages', slug: 'home' },
    query: {},
    body: { data: { title: 'Saved anyway' }, body: '', type: 'content' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.validation.status, 'invalid');
  assert.deepEqual(res.body.validation.issues.map((issue) => issue.path), ['blocks']);
  const onDisk = fs.readFileSync(path.join(projectRoot, 'src/content/pages/home.md'), 'utf-8');
  assert.ok(onDisk.includes('Saved anyway'), 'the edit reached disk');
});

await check('a valid save reports valid', async () => {
  const res = createJsonResponse();
  await saveHandler({
    params: { collection: 'pages', slug: 'home' },
    query: {},
    body: { data: { title: 'Saved anyway', blocks: [] }, body: '', type: 'content' },
  }, res);
  assert.equal(res.body.validation.status, 'valid');
});

await check('an update (PUT) also reports validation', async () => {
  const res = createJsonResponse();
  await updateHandler({
    params: { collection: 'pages', slug: 'home' },
    query: {},
    body: { data: { title: 'Updated' }, body: '', type: 'content' },
  }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.validation.status, 'invalid');
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);

} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
