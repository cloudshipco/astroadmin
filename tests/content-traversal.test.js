/**
 * Path traversal through the editor's API, against the REAL Express app.
 *
 * The attacker is a logged-in editor sending arbitrary URLs and JSON. Every
 * request below must stay inside the collection's own directory: a collection
 * has to be one the content config declares (exact match), and every resolved
 * file path is checked for containment after the final filename is built,
 * through symlinks too. Refusals are 400s that name no server path.
 *
 * Builds a throwaway git-backed project, starts createServer() on a free port,
 * logs in, and attacks it. Sentinel files outside the content directory must be
 * byte-identical at the end, and no probe file may appear anywhere outside it.
 *
 *   bun tests/content-traversal.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-traversal-')));
const projectRoot = path.join(scratch, 'site');
const outsideRoot = path.join(scratch, 'outside'); // beside the project, not in it
fs.mkdirSync(projectRoot);
fs.mkdirSync(outsideRoot);
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'true';
process.env.GIT_AUTO_PUSH = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}
function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
const PACKAGE_JSON = JSON.stringify({ type: 'module', name: 'traversal-fixture', scripts: { build: 'astro build' } }, null, 2);
writeProjectFile('package.json', PACKAGE_JSON);
writeProjectFile('victim.md', '---\ntitle: Victim\n---\nMust survive.\n');
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';
export const collections = {
  articles: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }),
  pages: defineCollection({ schema: z.object({ title: z.string() }) }),
  team: defineCollection({ loader: file('src/data/team.json'), schema: z.object({ name: z.string() }) }),
};
`);
writeProjectFile('src/content/articles/2024/first-post.md', '---\ntitle: First post\n---\nHello.\n');
writeProjectFile('src/content/articles/flat.md', '---\ntitle: Flat\n---\nFlat.\n');
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\nHome.\n');
writeProjectFile('src/data/team.json', JSON.stringify([{ id: 'ada', name: 'Ada' }], null, 2));
writeProjectFile('public/images/photo.png', 'not really a png');
writeProjectFile('public/images/.metadata.json', JSON.stringify({ 'photo.png': { alt: 'A photo' } }));

// Symlinks inside the content directory pointing OUTSIDE the project.
fs.writeFileSync(path.join(outsideRoot, 'secret.md'), '---\ntitle: Outside secret\n---\nOUTSIDE-SECRET\n');
fs.symlinkSync(outsideRoot, path.join(projectRoot, 'src/content/articles/linked'), 'dir');
fs.symlinkSync(path.join(outsideRoot, 'secret.md'), path.join(projectRoot, 'src/content/articles/leak.md'));
fs.symlinkSync(path.join(outsideRoot, 'dangling-target.md'), path.join(projectRoot, 'src/content/articles/dangling.md'));

git(['init', '-q']);
git(['config', 'user.name', 'AstroAdmin Test']);
git(['config', 'user.email', 'astroadmin@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'Initial commit']);

const sentinels = {
  [path.join(projectRoot, 'package.json')]: PACKAGE_JSON,
  [path.join(projectRoot, 'victim.md')]: fs.readFileSync(path.join(projectRoot, 'victim.md'), 'utf8'),
  [path.join(outsideRoot, 'secret.md')]: fs.readFileSync(path.join(outsideRoot, 'secret.md'), 'utf8'),
};

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

const { createServer } = await import('../server/index.js');
const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];
const request = (urlPath, options = {}) => fetch(base + urlPath, { ...options, headers: { cookie, 'Content-Type': 'application/json', ...(options.headers || {}) } });
const saveBody = (extra = {}) => JSON.stringify({ data: { title: 'probe', pwned: true }, type: 'data', ...extra });

/** A refusal: 400, and the body names no server path. */
async function assertRefused(response, label) {
  const text = await response.text();
  assert.equal(response.status, 400, `${label}: expected 400, got ${response.status} ${text.slice(0, 300)}`);
  assert.equal(text.includes(scratch), false, `${label}: the refusal echoes a server path: ${text.slice(0, 300)}`);
  assert.equal(text.includes(os.tmpdir()), false, `${label}: the refusal echoes the temp dir`);
}

/** Every file under a directory (lstat, symlinks not followed). */
function walkFiles(directory, out = []) {
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, dirent.name);
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
    if (dirent.isDirectory()) walkFiles(full, out);
    else if (dirent.isFile()) out.push(full); // symlinks are not followed
  }
  return out;
}

console.log('\n🧪 path traversal through the editor API\n' + '='.repeat(40));

// --- Positive controls first: legitimate nested slugs still work ------------

await check('control: a nested slug encoded as one parameter reads', async () => {
  const response = await request('/api/content/articles/2024%2Ffirst-post');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.title, 'First post');
});

await check('control: a nested slug saves into its own file', async () => {
  const response = await request('/api/content/articles/2024%2Ffirst-post', {
    method: 'POST', body: JSON.stringify({ data: { title: 'First post, edited' }, body: 'Hello.\n', type: 'content' }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.match(fs.readFileSync(path.join(projectRoot, 'src/content/articles/2024/first-post.md'), 'utf8'), /First post, edited/);
});

await check('control: a new nested entry is created, then deleted', async () => {
  const created = await request('/api/content/articles/2025%2Fnew-post', {
    method: 'POST', body: JSON.stringify({ data: { title: 'New' }, body: 'New.\n', type: 'content' }),
  });
  assert.equal(created.status, 200, await created.text());
  const newFile = path.join(projectRoot, 'src/content/articles/2025/new-post.md');
  assert.ok(fs.existsSync(newFile), 'the new nested file exists');
  const deleted = await request('/api/content/articles/2025%2Fnew-post', { method: 'DELETE' });
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal(fs.existsSync(newFile), false, 'the nested file is gone');
});

await check('control: a collection with no loader base (src/content/<name>) reads', async () => {
  const response = await request('/api/content/pages/home');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.title, 'Home');
});

await check('control: a file() collection entry reads and saves by id', async () => {
  assert.equal((await request('/api/content/team/ada')).status, 200);
  const saved = await request('/api/content/team/ada', { method: 'POST', body: JSON.stringify({ data: { name: 'Ada L' }, type: 'data' }) });
  assert.equal(saved.status, 200, await saved.text());
  assert.match(fs.readFileSync(path.join(projectRoot, 'src/data/team.json'), 'utf8'), /Ada L/);
});

await check('control: the collection entry list still works', async () => {
  const body = await (await request('/api/collections/articles/entries')).json();
  assert.ok(body.entries.includes('2024/first-post'), JSON.stringify(body.entries));
});

// --- Collections that escape through encoding --------------------------------

const hostileCollections = {
  'leading slash, encoded': '%2F..%2F..%2F',
  'leading slash, lowercase escape': '%2f..%2f..%2f',
  'leading slash, no trailing slash': '%2F..%2F..',
  'declared name then escape': 'articles%2F..%2F..%2F..',
  'double-encoded': '%252F..%252F..%252F',
  backslashes: '%5C..%5C..%5C',
  'absolute collection': encodeURIComponent(projectRoot),
  'absolute collection under the content root': '%2Ftmp',
  'plain dot-dot inside the segment': '..%2F..',
  'encoded dots': '%2E%2E%2F%2E%2E',
  'unicode one-dot leaders': '%E2%80%A4%E2%80%A4%2F%E2%80%A4%E2%80%A4',
  'unicode fullwidth dots': '%EF%BC%8E%EF%BC%8E%2F%EF%BC%8E%EF%BC%8E',
  'NUL byte': 'articles%00',
  'prototype key': '__proto__',
  'inherited key': 'constructor',
  'undeclared plain name': 'nonexistent',
};

for (const [label, collection] of Object.entries(hostileCollections)) {
  await check(`collection (${label}): read is refused`, async () => {
    await assertRefused(await request(`/api/content/${collection}/package`), `GET ${label}`);
  });
  await check(`collection (${label}): write is refused`, async () => {
    await assertRefused(await request(`/api/content/${collection}/probe-write`, { method: 'POST', body: saveBody() }), `POST ${label}`);
    await assertRefused(await request(`/api/content/${collection}/probe-write`, { method: 'PUT', body: saveBody() }), `PUT ${label}`);
  });
  await check(`collection (${label}): delete is refused`, async () => {
    await assertRefused(await request(`/api/content/${collection}/victim`, { method: 'DELETE' }), `DELETE ${label}`);
  });
  await check(`collection (${label}): listing is refused`, async () => {
    await assertRefused(await request(`/api/collections/${collection}/entries?preview=true`), `entries ${label}`);
    await assertRefused(await request(`/api/collections/${collection}`), `collection ${label}`);
  });
}

// --- Slugs that escape, or that would make the server echo a path -----------

const hostileSlugs = {
  'encoded dot-dot': '..%2F..%2F..%2Fpackage',
  'absolute slug': '%2Fetc%2Fpasswd',
  'trailing slash': 'flat%2F',
  'empty segment': '2024%2F%2Ffirst-post',
  'dot segment': '.%2Fflat',
  backslashes: '..%5C..%5C..%5Cpackage',
  'NUL byte': 'flat%00',
  'overlong slug': 'a'.repeat(4096),
  'overlong segment': 'b'.repeat(300),
  'through a symlinked directory': 'linked%2Fsecret',
  'a symlinked file': 'leak',
  'a dangling symlink': 'dangling',
};

for (const [label, slug] of Object.entries(hostileSlugs)) {
  await check(`slug (${label}): read, write and delete are refused`, async () => {
    await assertRefused(await request(`/api/content/articles/${slug}`), `GET ${label}`);
    await assertRefused(await request(`/api/content/articles/${slug}`, { method: 'POST', body: saveBody({ type: 'content', body: 'probe\n' }) }), `POST ${label}`);
    await assertRefused(await request(`/api/content/articles/${slug}`, { method: 'DELETE' }), `DELETE ${label}`);
  });
}

await check('a ?locale= value outside the configured list never reaches a filename', async () => {
  // i18n is off here, so the locale is ignored entirely; the save lands in flat.md.
  const response = await request('/api/content/articles/flat?locale=..%2F..%2F..%2Fpackage', {
    method: 'POST', body: JSON.stringify({ data: { title: 'Flat' }, body: 'Flat.\n', type: 'content' }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(JSON.parse(text).locale, null);
});

// --- Images ------------------------------------------------------------------

await check('images: metadata for a prototype key is refused and pollutes nothing', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const response = await request(`/api/images/${key}/metadata`, { method: 'PUT', body: JSON.stringify({ alt: 'polluted' }) });
    assert.equal(response.status, 400, `${key}: ${response.status}`);
  }
  assert.equal(Object.prototype.alt, undefined, 'Object.prototype.alt was set');
  assert.equal(({}).alt, undefined);
});

await check('images: metadata only for an image that exists', async () => {
  const response = await request('/api/images/not-there.png/metadata', { method: 'PUT', body: JSON.stringify({ alt: 'x' }) });
  assert.equal(response.status, 404);
  const ok = await request('/api/images/photo.png/metadata', { method: 'PUT', body: JSON.stringify({ alt: 'Edited alt' }) });
  assert.equal(ok.status, 200, 'control: an existing image takes metadata');
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectRoot, 'public/images/.metadata.json'), 'utf8'))['photo.png'].alt, 'Edited alt');
});

await check('images: the metadata file and non-image files cannot be deleted', async () => {
  const metadataPath = path.join(projectRoot, 'public/images/.metadata.json');
  await assertRefused(await request('/api/images/.metadata.json', { method: 'DELETE' }), 'DELETE .metadata.json');
  assert.ok(fs.existsSync(metadataPath), '.metadata.json survives');
  await assertRefused(await request('/api/images/..%2F..%2Fpackage.json', { method: 'DELETE' }), 'DELETE ../../package.json');
});

// --- Git routes ----------------------------------------------------------------

const hostileGitFiles = [
  '../package.json',
  'package.json',
  'src/content/../../package.json',
  '/etc/passwd',
  `${projectRoot}/package.json`,
  ':(top)package.json',
  ':/package.json',
  'src/content/articles/linked/secret.md',
];

await check('git: show, diff, file-history, revert and restore refuse paths outside the git paths', async () => {
  const head = git(['rev-parse', 'HEAD']).trim();
  for (const file of hostileGitFiles) {
    const q = encodeURIComponent(file);
    for (const [method, url, body] of [
      ['GET', `/api/git/show?file=${q}`],
      ['GET', `/api/git/diff?file=${q}`],
      ['GET', `/api/git/file-history?file=${q}`],
      ['POST', '/api/git/revert-file', { file }],
      ['POST', '/api/git/restore-from-commit', { file, commit: head }],
    ]) {
      const response = await request(url, { method, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      assert.equal(response.status, 400, `${method} ${url} ${JSON.stringify(body || '')}: ${response.status} ${text.slice(0, 200)}`);
      assert.equal(text.includes('traversal-fixture'), false, 'package.json content leaked');
      assert.equal(text.includes('OUTSIDE-SECRET'), false, 'outside content leaked');
    }
  }
});

await check('git: a non-string file parameter is a 400, not a crash', async () => {
  assert.equal((await request('/api/git/show?file=src/content/articles/flat.md&file=package.json')).status, 400);
  assert.equal((await request('/api/git/revert-file', { method: 'POST', body: JSON.stringify({ file: ['src/content/articles/flat.md'] }) })).status, 400);
});

await check('git: a pathspec glob reverts nothing but the literal file it names', async () => {
  const flat = path.join(projectRoot, 'src/content/articles/flat.md');
  const edited = '---\ntitle: Flat, unpublished edit\n---\nFlat.\n';
  fs.writeFileSync(flat, edited);
  const response = await request('/api/git/revert-file', { method: 'POST', body: JSON.stringify({ file: 'src/content/articles/*.md' }) });
  assert.notEqual(response.status, 200, 'a glob was accepted as a pathspec');
  assert.equal(fs.readFileSync(flat, 'utf8'), edited, 'an unpublished edit to another file was discarded');
});

await check('git control: a literal content path shows and reverts', async () => {
  const show = await request(`/api/git/show?file=${encodeURIComponent('src/content/articles/flat.md')}`);
  assert.equal(show.status, 200);
  assert.match((await show.json()).content, /title: Flat/);
  const revert = await request('/api/git/revert-file', { method: 'POST', body: JSON.stringify({ file: 'src/content/articles/flat.md' }) });
  assert.equal(revert.status, 200, await revert.text());
  assert.match(fs.readFileSync(path.join(projectRoot, 'src/content/articles/flat.md'), 'utf8'), /title: Flat\n/);
  const history = await request(`/api/git/file-history?file=${encodeURIComponent('src/content/articles/flat.md')}`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).commits.length, 1);
});

// --- The shared guards on their own ---------------------------------------------
// The routes above cannot reach every layer separately (an undeclared
// collection is refused before containment is checked), so each layer is
// also pinned directly.

const { assertContainedPath, assertSafeSlug, assertDeclaredCollection, isContentPathError } = await import('../server/utils/glob-files.js');
const articlesRoot = path.join(projectRoot, 'src/content/articles');
async function refuses(promiseOrFn, label) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.ok(isContentPathError(error), `${label}: wrong error ${error.message}`);
    return;
  }
  assert.fail(`${label}: was accepted`);
}

await check('assertContainedPath: lexical escapes, the root itself and a sibling prefix are refused', async () => {
  await refuses(assertContainedPath(articlesRoot, path.join(articlesRoot, '../../../package.json')), 'dot-dot');
  await refuses(assertContainedPath(articlesRoot, articlesRoot), 'the root itself');
  await refuses(assertContainedPath(articlesRoot, `${articlesRoot}-evil/x.md`), 'sibling with the same prefix');
  await refuses(assertContainedPath(articlesRoot, '/etc/passwd'), 'absolute elsewhere');
});

await check('assertContainedPath: symlinks out (directory, file, dangling) are refused', async () => {
  await refuses(assertContainedPath(articlesRoot, path.join(articlesRoot, 'linked/brand-new.md')), 'through a linked directory, missing file');
  await refuses(assertContainedPath(articlesRoot, path.join(articlesRoot, 'leak.md')), 'linked file');
  await refuses(assertContainedPath(articlesRoot, path.join(articlesRoot, 'dangling.md')), 'dangling link');
});

await check('assertContainedPath control: existing, missing and nested-missing files inside are accepted', async () => {
  const inside = [path.join(articlesRoot, 'flat.md'), path.join(articlesRoot, 'nope.md'), path.join(articlesRoot, 'a/b/c.md')];
  for (const candidate of inside) assert.equal(await assertContainedPath(articlesRoot, candidate), candidate);
});

await check('assertSafeSlug and assertDeclaredCollection', async () => {
  for (const slug of ['', '/x', 'x/', 'a//b', './x', 'a/../b', 'a\\b', 'a\u0000b', 'c'.repeat(201), 42, null]) {
    await refuses(() => assertSafeSlug(slug), `slug ${JSON.stringify(slug)}`);
  }
  for (const slug of ['flat', '2024/first-post', 'a.b', 'ü-ñ', 'd'.repeat(200)]) assert.equal(assertSafeSlug(slug), slug);
  const schemas = { articles: {} };
  for (const name of ['__proto__', 'constructor', 'toString', 'Articles', 'articles/', '/articles']) {
    await refuses(() => assertDeclaredCollection(name, schemas), `collection ${name}`);
  }
  assert.equal(assertDeclaredCollection('articles', schemas), 'articles');
});

// --- Nothing outside the content directory changed ---------------------------

await check('sentinels outside the content directory are byte-identical', async () => {
  for (const [file, content] of Object.entries(sentinels)) {
    assert.equal(fs.readFileSync(file, 'utf8'), content, `${file} changed`);
  }
  assert.equal(fs.existsSync(path.join(outsideRoot, 'dangling-target.md')), false, 'a write followed a dangling symlink');
  assert.equal(fs.readdirSync(outsideRoot).join(','), 'secret.md', 'a file appeared outside the project');
});

await check('no probe file was written anywhere in the project', async () => {
  const probes = walkFiles(projectRoot).filter((file) => /probe|pwned/.test(path.basename(file)) || /"pwned"|pwned: true/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(probes.map((file) => path.relative(projectRoot, file)), []);
});

server.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
