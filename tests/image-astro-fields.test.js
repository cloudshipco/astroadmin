/**
 * Astro image() fields beyond the plain case, against a real content config,
 * the real createServer() app, the real renderer (happy-dom) and a real
 * `astro build`:
 *
 * - image().describe('Portrait') is still image(). The stand-in used to be
 *   recognised by its description ('Image path'), which .describe() replaced,
 *   so the picker stored a public /images/... URL the build refuses. It is now
 *   marked with its own keyword (IMAGE_MARKER, server/utils/schema-parser.js),
 *   which survives .describe(), .optional() and .nullable().
 * - z.array(z.object({src: image(), alt})) is not a gallery. The gallery
 *   editor stores public library URLs; an array whose `src` is image() goes
 *   through the shared item renderer instead, whose image picker resolves an
 *   entry-relative value (applyPickedImage). The build accepts the result.
 * - an entry-relative value previews the file it NAMES. src/assets/images/x.png
 *   and src/content/assets/images/x.png both used to preview as
 *   /assets/images/x.png, which serves the content one; with an entry open the
 *   preview now comes from GET /api/images/entry-file, resolved against the
 *   entry's own directory, contained in the project's src/ and refusing
 *   anything else.
 *
 *   bun tests/image-astro-fields.test.js     (~10 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawnSync } from 'child_process';
import { Window } from 'happy-dom';
import { linkNodeModules } from './link-node-modules.js';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;

const repoRoot = path.resolve(import.meta.dir, '..');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-image-astro-fields-')));
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
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, red, green, blue]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SOURCE_SAME = png(0, 200, 0); // src/assets/images/same.png
const CONTENT_SAME = png(0, 0, 200); // src/content/assets/images/same.png

linkNodeModules(repoRoot, projectRoot);
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
    schema: ({ image }) => z.object({
      title: z.string(),
      photo: image().describe('Portrait'),
      hero: image().optional().describe('Hero image'),
      poster: image().nullable().optional(),
      gallery: z.array(z.object({ src: image(), alt: z.string() })).optional(),
      plainGallery: z.array(z.object({ src: z.string(), alt: z.string() })).optional(),
    }),
  }),
};
`);
writeProjectFile('src/pages/index.astro', `---
import { getCollection } from 'astro:content';
const posts = await getCollection('posts');
---
<ul>
{posts.map((post) => <li data-photo={post.id}>{post.data.photo.src}</li>)}
{posts.flatMap((post) => (post.data.gallery || []).map((item, index) => <li data-gallery={post.id + '-' + index}>{item.src.src}</li>))}
</ul>
`);
writeProjectFile('src/content/posts/a.md', '---\ntitle: A\nphoto: ./missing.png\n---\n');
writeProjectFile('public/images/pub.png', png(200, 0, 0));
writeProjectFile('src/assets/images/same.png', SOURCE_SAME);
writeProjectFile('src/content/assets/images/same.png', CONTENT_SAME);
fs.writeFileSync(path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-outside.png`), png(1, 2, 3));

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

const { parseAstroSchemas, IMAGE_MARKER } = await import('../server/utils/schema-parser.js');
const { enrichSchemaWithBlockTypes } = await import('../server/utils/block-types.js');
const { generateForm, generateFields } = await import('../ui/form-generator.js');
const { registerEntryContext, resolveImageUrl } = await import('../ui/field-widgets.js');
const { createServer } = await import('../server/index.js');

const { app } = await createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function astroBuild() {
  fs.rmSync(path.join(projectRoot, 'dist'), { recursive: true, force: true });
  const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/astro'), ['build'], {
    cwd: projectRoot, encoding: 'utf-8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

try {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 200, 'login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const jsonHeaders = { cookie, 'Content-Type': 'application/json' };

  async function save(data) {
    const response = await fetch(`${base}/api/content/posts/a`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ data, body: '' }),
    });
    assert.equal(response.status, 200, `save: ${await response.text()}`);
  }

  console.log('\n🧪 image() fields: descriptions, galleries, previews\n' + '='.repeat(40));

  const schemas = await parseAstroSchemas(projectRoot);
  const properties = schemas.posts.schema.properties;
  const editorSchema = enrichSchemaWithBlockTypes(schemas.posts.schema, schemas.posts.discriminatedUnions);
  const render = (data) => {
    const form = document.createElement('form');
    form.innerHTML = generateForm(editorSchema, data);
    document.body.appendChild(form);
    return form;
  };

  await check('image() is marked through .describe(), .optional() and .nullable()', async () => {
    assert.equal(typeof IMAGE_MARKER, 'string', 'the marker is exported');
    assert.equal(properties.photo[IMAGE_MARKER], true, JSON.stringify(properties.photo));
    assert.equal(properties.photo.description, 'Portrait', 'control: the site\'s description is kept');
    assert.equal(properties.hero[IMAGE_MARKER], true, JSON.stringify(properties.hero));
    const poster = properties.poster.anyOf?.find((member) => member.type === 'string') || properties.poster;
    assert.equal(poster[IMAGE_MARKER], true, JSON.stringify(properties.poster));
    assert.equal(properties.gallery.items.properties.src[IMAGE_MARKER], true);
    assert.equal(properties.title[IMAGE_MARKER], undefined, 'control: a plain string is not marked');
  });

  await check('a described image() field renders the image() picker', async () => {
    const form = render({ title: 'A' });
    for (const field of ['photo', 'hero']) {
      const picker = form.querySelector(`.image-picker[data-field="${field}"]`);
      assert.ok(picker, `${field} is an image picker`);
      assert.ok(picker.hasAttribute('data-astro-image'), `${field} lost its image() handling`);
    }
  });

  await check('an array of {src: image(), alt} is edited through the shared item renderer, not the gallery', async () => {
    const form = render({ title: 'A', gallery: [{ src: '../assets/images/same.png', alt: 'x' }], plainGallery: [{ src: '/images/pub.png', alt: 'y' }] });
    assert.ok(form.querySelector('.gallery-field[data-field="plainGallery"]'), 'control: a plain {src, alt} array is still a gallery');
    assert.equal(form.querySelector('.gallery-field[data-field="gallery"]'), null, 'image() items took the gallery path');
    const cards = form.querySelector('[data-array-cards][data-field="gallery"]');
    assert.ok(cards, 'rendered as array cards (edited in the item modal)');
    // What the item modal renders for one item (ui/array-editor.js uses generateFields).
    const itemSchema = JSON.parse(cards.dataset.schema);
    const modal = document.createElement('form');
    modal.innerHTML = generateFields(itemSchema.properties, { src: '', alt: '' }, { required: itemSchema.required });
    const picker = modal.querySelector('.image-picker[data-field="src"]');
    assert.ok(picker?.hasAttribute('data-astro-image'), 'the item\'s src picker resolves an entry-relative value');
  });

  await check('control: a gallery item holding a public /images URL fails astro build', async () => {
    await save({ title: 'A', photo: '../assets/images/same.png', gallery: [{ src: '/images/pub.png', alt: 'x' }] });
    const build = astroBuild();
    assert.notEqual(build.status, 0, 'the build accepted a public path in a gallery item');
    assert.match(build.output, /ImageNotFound|Could not find requested image/, build.output.slice(-800));
  });

  await check('a gallery item given the entry-value the picker stores builds, and is processed', async () => {
    const response = await fetch(`${base}/api/images/pub.png/entry-value`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ collection: 'posts', slug: 'a', source: 'uploads' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    await save({ title: 'A', photo: result.value, gallery: [{ src: result.value, alt: 'x' }] });
    const build = astroBuild();
    assert.equal(build.status, 0, build.output.slice(-1500));
    const html = fs.readFileSync(path.join(projectRoot, 'dist/index.html'), 'utf-8');
    assert.match(html, /data-gallery="a-0">\/_astro\/[^<]+\.png</, html);
    assert.match(html, /data-photo="a">\/_astro\/[^<]+\.png</, html);
  });

  await check('two files with one name preview as the file each value names', async () => {
    registerEntryContext(() => ({ collection: 'posts', slug: 'a' }));
    const contentUrl = resolveImageUrl('../assets/images/same.png'); // src/content/assets/images
    const sourceUrl = resolveImageUrl('../../assets/images/same.png'); // src/assets/images
    assert.notEqual(contentUrl, sourceUrl, `both preview as ${contentUrl}`);
    const [contentBytes, sourceBytes] = await Promise.all([contentUrl, sourceUrl].map(async (url) => {
      const response = await fetch(base + url, { headers: { cookie } });
      assert.equal(response.status, 200, `${url}: ${response.status}`);
      assert.match(response.headers.get('content-security-policy') || '', /sandbox/, 'sandboxed like /images');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return Buffer.from(await response.arrayBuffer());
    }));
    assert.ok(contentBytes.equals(CONTENT_SAME), 'the content asset previewed the wrong file');
    assert.ok(sourceBytes.equals(SOURCE_SAME), 'the src/assets image previewed the wrong file');
  });

  await check('the first render previews the same way', async () => {
    registerEntryContext(() => ({ collection: 'posts', slug: 'a' }));
    const form = render({ title: 'A', photo: '../../assets/images/same.png' });
    const src = form.querySelector('.image-picker[data-field="photo"] [data-preview-img]').getAttribute('src');
    assert.equal(src, resolveImageUrl('../../assets/images/same.png'));
    const response = await fetch(base + src, { headers: { cookie } });
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(SOURCE_SAME));
  });

  await check('the preview route refuses escapes, non-images, a bad entry and no session', async () => {
    const url = (value, collection = 'posts', slug = 'a') => `${base}/api/images/entry-file?${new URLSearchParams({ collection, slug, path: value })}`;
    const outsideName = `${path.basename(projectRoot)}-outside.png`;
    for (const value of [`../../../../${outsideName}`, '../../../package.json', '/etc/hosts', '../../../node_modules/astro/package.json', '']) {
      const response = await fetch(url(value), { headers: { cookie } });
      assert.equal(response.status, 400, `${value}: ${response.status}`);
      assert.equal((await response.text()).includes(projectRoot), false, 'a refusal named a server path');
    }
    const traversalSlug = await fetch(url('../assets/images/same.png', 'posts', '../../x'), { headers: { cookie } });
    assert.equal(traversalSlug.status, 400);
    const undeclared = await fetch(url('../assets/images/same.png', '../etc', 'a'), { headers: { cookie } });
    assert.equal(undeclared.status, 400);
    const missing = await fetch(url('../assets/images/nope.png'), { headers: { cookie } });
    assert.equal(missing.status, 404);
    const anonymous = await fetch(url('../assets/images/same.png'));
    assert.equal(anonymous.status, 401);
  });

  await check('with no entry open, a relative value falls back to /assets', async () => {
    registerEntryContext(() => null);
    assert.equal(resolveImageUrl('../assets/images/same.png'), '/assets/images/same.png');
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-outside.png`), { force: true });
}
process.exit(process.exitCode || 0);
