/**
 * Images for Astro image() fields must be importable by `astro build`.
 *
 * image() resolves its value as an import relative to the entry's file
 * (`../assets/images/x.png`); the public path the picker used to store
 * (`/images/x.png`) fails the build with ImageNotFound, so every image picked
 * for an image() field failed the publish check. The picker now:
 *   - uploads an image() field's image to src/content/assets/images
 *     (POST /api/images?for=image-field), which the default git.paths stage;
 *   - asks POST /api/images/:filename/entry-value for the value to store: the
 *     path relative to THIS entry's file (flat and nested slugs, file()
 *     collections), copying a public upload into the importable folder first.
 * Plain z.string() image fields keep the public /images/... value.
 *
 * Drives the real createServer() app the way the editor does (upload, resolve,
 * save through the content API), then runs this repo's real `astro build` on
 * the site. ~10 s.
 *
 *   bun tests/image-field-astro.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawnSync } from 'child_process';
import { linkNodeModules, sharedAstroStore } from './link-node-modules.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-image-field-')));
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

function writeProjectFile(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** A valid 1x1 PNG of one colour, so each image is a distinct file. */
function png(red, green, blue) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, red, green, blue]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Each package linked, but not node_modules/.astro: `astro build` writes its
// content data store there, which a wholesale link would share with this
// checkout and every other test site.
linkNodeModules(repoRoot, projectRoot);
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';
export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
    schema: ({ image }) => z.object({ title: z.string(), cover: image(), banner: z.string().optional() }),
  }),
  people: defineCollection({
    loader: file('src/data/people.json'),
    schema: ({ image }) => z.object({ id: z.string(), photo: image() }),
  }),
};
`);
writeProjectFile('src/pages/index.astro', `---
import { getCollection } from 'astro:content';
const posts = await getCollection('posts');
const people = await getCollection('people');
---
<ul>
{posts.map((post) => <li data-post={post.id}>{post.data.cover.src}</li>)}
{people.map((person) => <li data-person={person.id}>{person.data.photo.src}</li>)}
</ul>
`);
writeProjectFile('src/content/posts/a.md', '---\ntitle: A\ncover: ./missing.png\n---\n');
writeProjectFile('src/data/people.json', JSON.stringify([{ id: 'ada', photo: './missing.png' }]));
writeProjectFile('public/images/public-photo.png', png(255, 0, 0));
writeProjectFile('src/assets/images/source-photo.png', png(0, 255, 0));

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
const jsonHeaders = { cookie, 'Content-Type': 'application/json' };

async function upload(bytes, name, query = '') {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), name);
  const response = await fetch(`${base}/api/images${query}`, { method: 'POST', headers: { cookie }, body: form });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.image;
}

/** What the picker stores for an image() field of this entry. */
async function entryValue(filename, collection, slug, source) {
  const response = await fetch(`${base}/api/images/${encodeURIComponent(filename)}/entry-value`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ collection, slug, source }),
  });
  return { status: response.status, body: await response.json() };
}

async function save(collection, slug, data) {
  const response = await fetch(`${base}/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ data, body: '' }),
  });
  assert.equal(response.status, 200, `save ${collection}/${slug}: ${await response.text()}`);
}

function astroBuild() {
  fs.rmSync(path.join(projectRoot, 'dist'), { recursive: true, force: true });
  const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/astro'), ['build'], {
    cwd: projectRoot, encoding: 'utf-8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

console.log('\n🧪 image() fields build\n' + '='.repeat(40));

let uploaded = null;
let copied = null;

await check('control: a public /images path in an image() field fails astro build', async () => {
  const publicUpload = await upload(png(0, 0, 255), 'public.png');
  assert.match(publicUpload.url, /^\/images\/public-\d+\.png$/, 'a plain upload stays public');
  await save('posts', 'a', { title: 'A', cover: publicUpload.url });
  const build = astroBuild();
  assert.notEqual(build.status, 0, 'the build accepted a public path');
  assert.match(build.output, /ImageNotFound|Could not find requested image/, build.output.slice(-800));
});

await check('an upload for an image() field lands in src/content/assets/images and previews', async () => {
  uploaded = await upload(png(10, 20, 30), 'cover.png', '?for=image-field');
  assert.match(uploaded.url, /^\/assets\/images\/cover-\d+\.png$/, JSON.stringify(uploaded));
  assert.ok(fs.existsSync(path.join(projectRoot, 'src/content/assets/images', uploaded.filename)), 'file on disk');
  assert.equal(fs.existsSync(path.join(projectRoot, 'public/images', uploaded.filename)), false, 'not public');
  const preview = await fetch(base + uploaded.url, { headers: { cookie } });
  assert.equal(preview.status, 200, 'the editor can show its thumbnail');
});

await check('the stored value is relative to the entry file (flat, nested, file())', async () => {
  const flat = await entryValue(uploaded.filename, 'posts', 'a', 'assets');
  assert.equal(flat.status, 200, JSON.stringify(flat.body));
  assert.equal(flat.body.value, `../assets/images/${uploaded.filename}`);
  assert.equal(flat.body.previewUrl, uploaded.url);
  const nested = await entryValue(uploaded.filename, 'posts', '2024/b', 'assets');
  assert.equal(nested.body.value, `../../assets/images/${uploaded.filename}`);
  const person = await entryValue(uploaded.filename, 'people', 'ada', 'assets');
  assert.equal(person.body.value, `../content/assets/images/${uploaded.filename}`);
});

await check('picking a public library image for an image() field copies it somewhere importable', async () => {
  const result = await entryValue('public-photo.png', 'posts', '2024/b', 'uploads');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.value, '../../assets/images/public-photo.png');
  copied = result.body.value;
  const copy = path.join(projectRoot, 'src/content/assets/images/public-photo.png');
  assert.ok(fs.readFileSync(copy).equals(png(255, 0, 0)), 'the copy is the same image');
  assert.ok(fs.existsSync(path.join(projectRoot, 'public/images/public-photo.png')), 'the public original stays');
  const again = await entryValue('public-photo.png', 'posts', '2024/b', 'uploads');
  assert.equal(again.body.value, copied, 'picking it again reuses the copy');
});

await check('a src/assets/images library image is used where it is', async () => {
  const result = await entryValue('source-photo.png', 'posts', 'c', 'source');
  assert.equal(result.body.value, '../../assets/images/source-photo.png');
  assert.equal(result.body.previewUrl, '/images/source-photo.png');
});

await check('entries saved with those values build, and each image is processed', async () => {
  await save('posts', 'a', { title: 'A', cover: `../assets/images/${uploaded.filename}`, banner: '/images/public-photo.png' });
  await save('posts', '2024/b', { title: 'B', cover: copied });
  await save('posts', 'c', { title: 'C', cover: '../../assets/images/source-photo.png' });
  await save('people', 'ada', { id: 'ada', photo: `../content/assets/images/${uploaded.filename}` });
  const build = astroBuild();
  assert.equal(build.status, 0, build.output.slice(-1500));
  const html = fs.readFileSync(path.join(projectRoot, 'dist/index.html'), 'utf-8');
  for (const id of ['data-post="a"', 'data-post="2024/b"', 'data-post="c"', 'data-person="ada"']) {
    assert.match(html, new RegExp(`${id}>/_astro/[^<]+\\.png<`), `${id} not processed: ${html}`);
  }
});

await check('the builds wrote their own Astro data store, not this checkout\'s', () => {
  const shared = sharedAstroStore(repoRoot, projectRoot);
  assert.equal(shared, null, `node_modules/.astro resolves into this checkout: ${shared}`);
  assert.ok(fs.existsSync(path.join(projectRoot, 'node_modules', '.astro')), 'positive control: the builds wrote a store in the site');
});

await check('refusals: undeclared collection, traversal slug, bad filename, missing image', async () => {
  const undeclared = await entryValue(uploaded.filename, '../../etc', 'a');
  assert.equal(undeclared.status, 400);
  const traversal = await entryValue(uploaded.filename, 'posts', '../../x');
  assert.equal(traversal.status, 400);
  const badName = await fetch(`${base}/api/images/${encodeURIComponent('../x.png')}/entry-value`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ collection: 'posts', slug: 'a' }),
  });
  assert.ok([400, 404].includes(badName.status), `bad filename: ${badName.status}`);
  const missing = await entryValue('nope.png', 'posts', 'a');
  assert.equal(missing.status, 404);
  for (const response of [undeclared, traversal, missing]) {
    assert.equal(JSON.stringify(response.body).includes(projectRoot), false, 'a refusal named a server path');
  }
});

await check('the library lists image() files as source "assets" at /assets/images', async () => {
  const response = await fetch(`${base}/api/images`, { headers: { cookie } });
  const { images } = await response.json();
  const listed = images.find((image) => image.filename === uploaded.filename);
  assert.equal(listed?.source, 'assets', JSON.stringify(listed));
  assert.equal(listed.url, uploaded.url);
  assert.ok(images.some((image) => image.filename === 'source-photo.png' && image.source === 'source'), 'control');
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
process.exit(process.exitCode || 0);
