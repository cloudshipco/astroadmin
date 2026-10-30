/**
 * Image details (`public/images/.metadata.json`) through the real routes
 * (server/api/images.js), for the focal point and crop (#82).
 *
 * The rules it pins: an entry is keyed by the image's SITE PATH as the
 * listing returns it (`/images/<name>` for src/assets and public uploads,
 * `/assets/images/<name>` for the image() folder), in the folder the
 * request's `?source=` names (the listing's `source` field; absent: the
 * first folder in imageDirectories() order holding the file, for an older
 * editor; anything else a fixed 400); for a `/images/<name>` path ONLY, a
 * read (GET, the listing) falls back to the bare-filename key an older admin
 * wrote, and a PUT moves such an entry's remaining fields under the new key
 * and deletes the old one (the image() folder's same-named file starts with
 * no details and its PUT leaves the legacy entry to the upload). An entry at
 * its site-path key is changed in place, so a patch that changes nothing
 * leaves the file byte-identical (mtime too) and a change keeps the key
 * order. An entry left with no keys is removed, and a null patch on an image
 * with no details creates no file. The PUT body goes through
 * `validateMetadataPatch`: only alt, focalPoint and crop, each of its shape or
 * null (null deletes the key), anything else a 400 with fixed text that
 * names the field and never the sent value; a crop is accepted exactly when
 * the build's `parseCrop` accepts it (plus the refusal of an extra key).
 * DELETE removes the entry (both keys) and writes the file BEFORE unlinking
 * the image, in one hold, so a write that fails (read-only file) is a 500
 * that leaves the image and its entry in place, and a file that comes back
 * under the same name starts without the old alt. The listing dedupes by url, so
 * the image() folder's same-named file is listed beside the upload, and
 * carries `crop` beside `focalPoint`. `/api/config` reports `imageCrop` from
 * `images.crop` (default false).
 *
 *   bun tests/image-metadata.test.js     (~1 s)
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const repoRoot = path.resolve(import.meta.dir, '..');
const selfPath = path.join(import.meta.dir, 'image-metadata.test.js');

function makeProject(prefix, configSource) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const write = (relativePath, content) => {
    const fullPath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
  write('package.json', JSON.stringify({ type: 'module' }));
  if (configSource !== null) write('astroadmin.config.js', configSource);
  write('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
  write('src/content/pages/home.md', '---\ntitle: Home\n---\n');
  return { projectRoot, write };
}

async function startServer() {
  const { createServer } = await import('../server/index.js');
  const { app } = await createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A child process, for a site whose astroadmin.config.js sets no images.crop
// (the user config is loaded once per process).
if (process.argv[2] === '--child') {
  const { projectRoot } = makeProject('aa-image-metadata-child-', process.argv[3] === 'none' ? null : process.argv[3]);
  Object.assign(process.env, { ASTROADMIN_PROJECT_ROOT: projectRoot, GIT_ENABLED: 'false', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin' });
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ASTROADMIN_CONTENT_STORE;
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/api/config`);
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
  } finally {
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.exit(0);
}

const { projectRoot, write } = makeProject('aa-image-metadata-', "export default { images: { crop: true } };\n");
process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;
process.env.GIT_ENABLED = 'false';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ASTROADMIN_CONTENT_STORE;

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

const metadataPath = path.join(projectRoot, 'public/images/.metadata.json');
const readMetadata = () => JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const writeMetadata = (metadata) => fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

write('public/images/photo.png', png(255, 0, 0));
write('public/images/legacy.png', png(0, 255, 0));
write('public/images/read-legacy.png', png(0, 0, 255));
write('public/images/shared.png', png(9, 9, 9));
write('src/assets/images/shared.png', png(8, 8, 8));
write('src/content/assets/images/shared.png', png(7, 7, 7));
write('src/content/assets/images/asset-only.png', png(6, 6, 6));
write('public/images/gone-soon.png', png(5, 5, 5));
write('public/images/lonely.png', png(4, 4, 4));
write('public/images/bare.png', png(3, 3, 3));
write('public/images/twin.png', png(2, 2, 2));
write('src/content/assets/images/twin.png', png(1, 1, 1));
write('public/images/steady.png', png(0, 0, 1));
write('public/images/doomed.png', png(0, 0, 2));
writeMetadata({
  'legacy.png': { alt: 'Legacy alt', focalPoint: { x: 10, y: 20 } },
  'read-legacy.png': { alt: 'Read me' },
  'gone-soon.png': { alt: 'Old alt (bare key)' },
  'twin.png': { alt: 'Twin alt', focalPoint: { x: 10, y: 20 } },
});

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

const { server, base } = await startServer();
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
assert.equal(login.status, 200, 'login');
const cookie = login.headers.get('set-cookie').split(';')[0];

/** A JSON request; `text` is the raw body, for the no-path and no-echo checks. */
async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { cookie, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, text };
}
/** The metadata route for `filename`, with `?source=` (the listing's field) when given. */
const metadataRoute = (filename, source) => `/api/images/${encodeURIComponent(filename)}/metadata${source === undefined ? '' : `?source=${encodeURIComponent(source)}`}`;
const putMetadata = (filename, body, source) => request(metadataRoute(filename, source), { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
const getMetadata = (filename, source) => request(metadataRoute(filename, source));
const listImages = async () => {
  const { status, body } = await request('/api/images');
  assert.equal(status, 200, 'the listing');
  return body.images;
};

async function upload(bytes, filename) {
  const form = new FormData();
  form.append('image', new Blob([bytes]), filename);
  const response = await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie }, body: form });
  return { status: response.status, body: await response.json() };
}

function assertNoServerPath(text, label) {
  for (const needle of [projectRoot, os.tmpdir(), repoRoot]) {
    assert.ok(!text.includes(needle), `${label}: the body names ${needle}: ${text}`);
  }
}

console.log('\n🧪 image details: keys, validation, delete, listing\n' + '='.repeat(40));

try {
  await check('a PUT body that is not an object, holds an unknown or prototype key, or a wrong-typed field is a 400 with fixed text', async () => {
    const before = fs.readFileSync(metadataPath, 'utf8');
    const refusals = [
      // (A JSON primitive such as `"text"` never reaches the route: the app's
      // own body parser refuses it in strict mode.)
      ['[]', 'object', ['[]']],
      [JSON.stringify({ caption: 'A caption' }), 'alt, focalPoint and crop', ['caption', 'A caption']],
      ['{"__proto__": {"alt": "polluted"}}', 'alt, focalPoint and crop', ['polluted']],
      ['{"constructor": {"prototype": {"alt": "polluted"}}}', 'alt, focalPoint and crop', ['polluted']],
      ['{"alt": "x", "focalPoint": {"x": 1, "y": 2}, "extra": true}', 'alt, focalPoint and crop', ['extra']],
      [JSON.stringify({ alt: 5 }), 'alt', ['5']],
      [JSON.stringify({ alt: ['a'] }), 'alt', []],
      [JSON.stringify({ focalPoint: { x: 150, y: 10 } }), 'focalPoint', ['150']],
      [JSON.stringify({ focalPoint: { x: 10 } }), 'focalPoint', []],
      [JSON.stringify({ focalPoint: { x: -1, y: 10 } }), 'focalPoint', ['-1']],
      [JSON.stringify({ focalPoint: { x: '10', y: 10 } }), 'focalPoint', []],
      [JSON.stringify({ focalPoint: { x: 10, y: 10, z: 3 } }), 'focalPoint', []],
      [JSON.stringify({ focalPoint: [10, 10] }), 'focalPoint', []],
      [JSON.stringify({ focalPoint: 'centre' }), 'focalPoint', ['centre']],
      [JSON.stringify({ crop: { x: 60, y: 0, width: 50, height: 10 } }), 'crop', ['60']],
      [JSON.stringify({ crop: { x: 0, y: 60, width: 10, height: 50 } }), 'crop', []],
      [JSON.stringify({ crop: { x: 0, y: 0, width: 0, height: 10 } }), 'crop', []],
      [JSON.stringify({ crop: { x: 0, y: 0, width: 10, height: -5 } }), 'crop', []],
      [JSON.stringify({ crop: { x: -1, y: 0, width: 10, height: 10 } }), 'crop', []],
      [JSON.stringify({ crop: { x: 0, y: 0, width: 10 } }), 'crop', []],
      [JSON.stringify({ crop: { x: 0, y: 0, width: 10, height: 10, unit: 'px' } }), 'crop', ['px']],
      [JSON.stringify({ crop: { x: 0, y: 0, width: '10', height: 10 } }), 'crop', []],
      [JSON.stringify({ crop: true }), 'crop', []],
    ];
    for (const [body, field, echoes] of refusals) {
      const response = await putMetadata('photo.png', body);
      assert.equal(response.status, 400, `${body}: ${response.status} ${response.text}`);
      assert.equal(response.body?.success, false, body);
      assert.equal(typeof response.body?.error, 'string', body);
      assert.ok(response.body.error.includes(field), `${body}: "${response.body.error}" does not name ${field}`);
      for (const echo of echoes) assert.ok(!response.body.error.includes(echo), `${body}: the message echoes ${echo}: ${response.body.error}`);
      assertNoServerPath(response.text, body);
    }
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'a refused PUT writes nothing');
  });

  await check('a PUT writes under the site-path key and reports the entry as written; null deletes a key', async () => {
    const set = await putMetadata('photo.png', { alt: 'A photo', focalPoint: { x: 30, y: 40 }, crop: { x: 0, y: 10, width: 50, height: 90 } });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body, {
      success: true,
      filename: 'photo.png',
      metadata: { alt: 'A photo', focalPoint: { x: 30, y: 40 }, crop: { x: 0, y: 10, width: 50, height: 90 } },
    });
    const stored = readMetadata();
    assert.ok(Object.hasOwn(stored, '/images/photo.png'), `keyed by site path: ${Object.keys(stored)}`);
    assert.ok(!Object.hasOwn(stored, 'photo.png'), 'no bare-filename key');
    assert.deepEqual(stored['/images/photo.png'], set.body.metadata);

    const cleared = await putMetadata('photo.png', { focalPoint: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.deepEqual(cleared.body.metadata, { alt: 'A photo', crop: { x: 0, y: 10, width: 50, height: 90 } });
    assert.deepEqual(Object.keys(readMetadata()['/images/photo.png']), ['alt', 'crop']);
    const emptied = await putMetadata('photo.png', { crop: null, alt: '' });
    assert.equal(emptied.status, 200, emptied.text);
    assert.deepEqual(emptied.body.metadata, { alt: '' });
    assert.deepEqual(readMetadata()['/images/photo.png'], { alt: '' });
    const unchanged = await putMetadata('photo.png', {});
    assert.equal(unchanged.status, 200, unchanged.text);
    assert.deepEqual(unchanged.body.metadata, { alt: '' });
  });

  await check('the server refuses exactly the crops the build ignores: validateMetadataPatch agrees with parseCrop', async () => {
    // One rule, in components/crop.js: a crop the server stores is one
    // CmsImage and the image service apply. The server adds only the refusal
    // of a key beside the four sides (parseCrop ignores extra keys).
    const { validateMetadataPatch } = await import('../server/api/images.js');
    const { parseCrop } = await import('../components/crop.js');
    const crops = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 60, y: 0, width: 50, height: 10 },
      { x: 0, y: 60, width: 10, height: 50 },
      { x: 50, y: 50, width: 50, height: 50 },
      { x: 50, y: 50, width: 50.0001, height: 50 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -5 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 10 },
      { x: 0, y: 0, width: Infinity, height: 10 },
      { x: 0, y: 0, width: NaN, height: 10 },
      { x: 0, y: 0, width: '10', height: 10 },
      {},
      [],
      true,
      'x',
    ];
    for (const crop of crops) {
      const result = validateMetadataPatch({ crop });
      const accepted = parseCrop(crop) !== undefined;
      assert.equal(result.error === undefined, accepted, `${JSON.stringify(crop)}: server ${result.error === undefined ? 'accepts' : 'refuses'}, parseCrop ${accepted ? 'accepts' : 'refuses'}`);
      if (accepted) assert.deepEqual(result.patch.crop, parseCrop(crop));
    }
    // The server's own addition: a key beside the sides.
    const extra = { x: 0, y: 0, width: 10, height: 10, unit: 'px' };
    assert.ok(parseCrop(extra) !== undefined, 'control: parseCrop ignores the extra key');
    assert.equal(validateMetadataPatch({ crop: extra }).error, validateMetadataPatch({ crop: true }).error);
    // Over HTTP: a crop parseCrop refuses is a 400 (x + width > 100).
    const refused = await putMetadata('photo.png', { crop: { x: 60, y: 0, width: 50, height: 10 } });
    assert.equal(refused.status, 400, refused.text);
    assert.ok(refused.body.error.includes('crop'), refused.body.error);
  });

  await check('the exact crop and focal point bounds are accepted', async () => {
    for (const body of [
      { focalPoint: { x: 0, y: 0 } },
      { focalPoint: { x: 100, y: 100 } },
      { focalPoint: { x: 33.3333, y: 66.6667 } },
      { crop: { x: 0, y: 0, width: 100, height: 100 } },
      { crop: { x: 50, y: 50, width: 50, height: 50 } },
      { crop: { x: 12.5, y: 0, width: 0.5, height: 0.25 } },
    ]) {
      const response = await putMetadata('photo.png', body);
      assert.equal(response.status, 200, `${JSON.stringify(body)}: ${response.text}`);
      for (const [key, value] of Object.entries(body)) assert.deepEqual(response.body.metadata[key], value);
    }
    await putMetadata('photo.png', { focalPoint: null, crop: null });
  });

  await check('a PUT moves a legacy bare-filename entry under the site-path key, keeping its other fields', async () => {
    const response = await putMetadata('legacy.png', { alt: 'New alt' });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.metadata, { alt: 'New alt', focalPoint: { x: 10, y: 20 } });
    const stored = readMetadata();
    assert.deepEqual(Object.keys(stored).filter((key) => key === 'legacy.png' || key === '/images/legacy.png'), ['/images/legacy.png']);
    assert.deepEqual(stored['/images/legacy.png'], { alt: 'New alt', focalPoint: { x: 10, y: 20 } });
    // Still there: the entries this PUT did not touch.
    assert.deepEqual(stored['read-legacy.png'], { alt: 'Read me' });
  });

  await check('GET and the listing read a legacy bare-filename entry', async () => {
    const response = await getMetadata('read-legacy.png');
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body, { success: true, filename: 'read-legacy.png', metadata: { alt: 'Read me' } });
    const listed = (await listImages()).find((image) => image.url === '/images/read-legacy.png');
    assert.ok(listed, 'listed');
    assert.equal(listed.alt, 'Read me');
    assert.equal(listed.focalPoint, null);
    assert.equal(listed.crop, null);
    // A site-path key wins over a legacy one.
    writeMetadata({ ...readMetadata(), '/images/read-legacy.png': { alt: 'Site path' } });
    assert.deepEqual((await getMetadata('read-legacy.png')).body.metadata, { alt: 'Site path' });
    assert.equal((await listImages()).find((image) => image.url === '/images/read-legacy.png').alt, 'Site path');
  });

  await check('an image() folder image is keyed by /assets/images/<name>', async () => {
    const response = await putMetadata('asset-only.png', { alt: 'An asset', focalPoint: { x: 1, y: 2 } });
    assert.equal(response.status, 200, response.text);
    const stored = readMetadata();
    assert.deepEqual(stored['/assets/images/asset-only.png'], { alt: 'An asset', focalPoint: { x: 1, y: 2 } });
    assert.ok(!Object.hasOwn(stored, '/images/asset-only.png'));
    assert.ok(!Object.hasOwn(stored, 'asset-only.png'));
    assert.deepEqual((await getMetadata('asset-only.png')).body.metadata, stored['/assets/images/asset-only.png']);
    const listed = (await listImages()).find((image) => image.url === '/assets/images/asset-only.png');
    assert.equal(listed.alt, 'An asset');
    assert.deepEqual(listed.focalPoint, { x: 1, y: 2 });
    assert.equal(listed.source, 'assets');
  });

  await check('the listing dedupes by url: a same-named image() folder image is listed beside the upload, and every item carries crop', async () => {
    const images = await listImages();
    const shared = images.filter((image) => image.filename === 'shared.png');
    assert.deepEqual(
      shared.map((image) => [image.url, image.source]).sort(),
      [['/assets/images/shared.png', 'assets'], ['/images/shared.png', 'source']],
    );
    for (const image of images) {
      assert.ok(Object.hasOwn(image, 'crop'), `${image.url} has crop`);
      assert.ok(Object.hasOwn(image, 'focalPoint'), `${image.url} has focalPoint`);
    }
    assert.equal(new Set(images.map((image) => image.url)).size, images.length, 'no url twice');
    // The /images url of shared.png is the src/assets one (the admin serves
    // src/assets first), and its details are read under that key.
    await putMetadata('shared.png', { alt: 'Shared' });
    assert.deepEqual(readMetadata()['/images/shared.png'], { alt: 'Shared' });
    const after = await listImages();
    assert.equal(after.find((image) => image.url === '/images/shared.png').alt, 'Shared');
    assert.equal(after.find((image) => image.url === '/assets/images/shared.png').alt, '');
  });

  await check('?source= names the folder: a PUT on the image() folder\'s shared.png writes /assets/images/shared.png and leaves /images/shared.png alone', async () => {
    const before = readMetadata();
    assert.deepEqual(before['/images/shared.png'], { alt: 'Shared' }, 'control: the /images entry from the check above');
    const set = await putMetadata('shared.png', { alt: 'Asset shared', focalPoint: { x: 5, y: 6 } }, 'assets');
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body.metadata, { alt: 'Asset shared', focalPoint: { x: 5, y: 6 } });
    const stored = readMetadata();
    assert.deepEqual(stored['/assets/images/shared.png'], { alt: 'Asset shared', focalPoint: { x: 5, y: 6 } });
    assert.deepEqual(stored['/images/shared.png'], { alt: 'Shared' }, 'the /images entry is untouched');
    assert.ok(!Object.hasOwn(stored, 'shared.png'));
    // GET reads by source too; with no source, the first folder as before.
    assert.deepEqual((await getMetadata('shared.png', 'assets')).body.metadata, { alt: 'Asset shared', focalPoint: { x: 5, y: 6 } });
    assert.deepEqual((await getMetadata('shared.png', 'source')).body.metadata, { alt: 'Shared' });
    assert.deepEqual((await getMetadata('shared.png')).body.metadata, { alt: 'Shared' });
    const listed = await listImages();
    assert.equal(listed.find((image) => image.url === '/assets/images/shared.png').alt, 'Asset shared');
    assert.deepEqual(listed.find((image) => image.url === '/assets/images/shared.png').focalPoint, { x: 5, y: 6 });
    assert.equal(listed.find((image) => image.url === '/images/shared.png').alt, 'Shared');
    assert.equal(listed.find((image) => image.url === '/images/shared.png').focalPoint, null);
    // A folder the file is not in is a 404; the uploads folder's own file is /images.
    assert.equal((await putMetadata('asset-only.png', { alt: 'x' }, 'uploads')).status, 404);
    assert.equal((await getMetadata('asset-only.png', 'source')).status, 404);
    assert.equal((await putMetadata('photo.png', { alt: 'Photo (uploads)' }, 'uploads')).status, 200);
    assert.deepEqual(readMetadata()['/images/photo.png'], { alt: 'Photo (uploads)' });
  });

  await check('a legacy bare-filename entry belongs to /images/<name> only: the image() folder\'s same-named file starts with no details, and its PUT leaves the legacy entry alone', async () => {
    // An older admin wrote `twin.png` for public/images/twin.png (served at
    // /images/twin.png, the only key site-files.js reads it for). The image()
    // folder's twin.png is another file at another url.
    const before = await listImages();
    const publicItem = before.find((image) => image.url === '/images/twin.png');
    const assetItem = before.find((image) => image.url === '/assets/images/twin.png');
    assert.equal(publicItem.alt, 'Twin alt', 'control: the legacy entry shows on the upload');
    assert.deepEqual(publicItem.focalPoint, { x: 10, y: 20 });
    assert.equal(assetItem.alt, '', 'the image() folder item has no alt');
    assert.equal(assetItem.focalPoint, null, 'the image() folder item has no focal point');
    assert.deepEqual((await getMetadata('twin.png', 'assets')).body.metadata, {});
    assert.deepEqual((await getMetadata('twin.png', 'uploads')).body.metadata, { alt: 'Twin alt', focalPoint: { x: 10, y: 20 } });

    const set = await putMetadata('twin.png', { alt: 'Asset twin' }, 'assets');
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body.metadata, { alt: 'Asset twin' }, 'the legacy fields are not folded in');
    const stored = readMetadata();
    assert.deepEqual(stored['twin.png'], { alt: 'Twin alt', focalPoint: { x: 10, y: 20 } }, 'the legacy entry is still there for the upload');
    assert.deepEqual(stored['/assets/images/twin.png'], { alt: 'Asset twin' });
    assert.ok(!Object.hasOwn(stored, '/images/twin.png'), 'nothing written for the upload');
    const after = await listImages();
    assert.equal(after.find((image) => image.url === '/images/twin.png').alt, 'Twin alt');
    assert.deepEqual(after.find((image) => image.url === '/images/twin.png').focalPoint, { x: 10, y: 20 });
    assert.equal(after.find((image) => image.url === '/assets/images/twin.png').alt, 'Asset twin');
    assert.equal(after.find((image) => image.url === '/assets/images/twin.png').focalPoint, null);
    // The upload's own PUT still folds the legacy entry in and removes it.
    assert.deepEqual((await putMetadata('twin.png', { alt: 'Public twin' }, 'uploads')).body.metadata, { alt: 'Public twin', focalPoint: { x: 10, y: 20 } });
    const moved = readMetadata();
    assert.ok(!Object.hasOwn(moved, 'twin.png'), 'the legacy key is folded into /images/twin.png');
    assert.deepEqual(moved['/images/twin.png'], { alt: 'Public twin', focalPoint: { x: 10, y: 20 } });
    assert.deepEqual(moved['/assets/images/twin.png'], { alt: 'Asset twin' }, 'the image() folder entry is untouched');
  });

  await check('a PUT that changes nothing leaves .metadata.json byte-identical and in place; a change writes it, keeping the key order', async () => {
    writeMetadata({
      ...readMetadata(),
      '/images/steady.png': { alt: 'Steady', focalPoint: { x: 10, y: 20 }, crop: { x: 0, y: 0, width: 50, height: 50 } },
      '/images/after-steady.png': { alt: 'After' },
    });
    const bytes = fs.readFileSync(metadataPath);
    const { mtimeMs } = fs.statSync(metadataPath);
    const keysBefore = Object.keys(readMetadata());
    for (const body of [
      { alt: 'Steady' },
      { focalPoint: { x: 10, y: 20 } },
      { crop: { x: 0, y: 0, width: 50, height: 50 } },
      { alt: 'Steady', focalPoint: { x: 10, y: 20 }, crop: { x: 0, y: 0, width: 50, height: 50 } },
      {},
    ]) {
      const response = await putMetadata('steady.png', body);
      assert.equal(response.status, 200, `${JSON.stringify(body)}: ${response.text}`);
      assert.deepEqual(response.body.metadata, { alt: 'Steady', focalPoint: { x: 10, y: 20 }, crop: { x: 0, y: 0, width: 50, height: 50 } });
      assert.ok(fs.readFileSync(metadataPath).equals(bytes), `${JSON.stringify(body)}: the file was rewritten`);
      assert.equal(fs.statSync(metadataPath).mtimeMs, mtimeMs, `${JSON.stringify(body)}: the mtime moved`);
    }
    // Positive control: a changed alt writes, and the entry keeps its place.
    const changed = await putMetadata('steady.png', { alt: 'Steady 2' });
    assert.equal(changed.status, 200, changed.text);
    assert.ok(!fs.readFileSync(metadataPath).equals(bytes), 'control: a change writes the file');
    assert.deepEqual(Object.keys(readMetadata()), keysBefore, 'the key order is kept');
    assert.deepEqual(readMetadata()['/images/steady.png'], { alt: 'Steady 2', focalPoint: { x: 10, y: 20 }, crop: { x: 0, y: 0, width: 50, height: 50 } });
  });

  await check('DELETE whose metadata write fails leaves the file in place and listed (a true 500); writable, it removes both', async () => {
    assert.equal((await putMetadata('doomed.png', { alt: 'Doomed' })).status, 200);
    const imagePath = path.join(projectRoot, 'public/images/doomed.png');
    const bytes = fs.readFileSync(metadataPath);
    fs.chmodSync(metadataPath, 0o444);
    try {
      const refused = await request('/api/images/doomed.png', { method: 'DELETE' });
      assert.equal(refused.status, 500, refused.text);
      assert.equal(refused.body?.success, false);
      assertNoServerPath(refused.text, 'delete 500');
      assert.ok(fs.existsSync(imagePath), 'the image file is still there');
      assert.ok(fs.readFileSync(metadataPath).equals(bytes), 'the metadata file is as it was');
      const listed = (await listImages()).find((image) => image.url === '/images/doomed.png');
      assert.ok(listed, 'still listed');
      assert.equal(listed.alt, 'Doomed');
      assert.equal((await getMetadata('doomed.png')).body.metadata.alt, 'Doomed');
    } finally {
      fs.chmodSync(metadataPath, 0o644);
    }
    // Control: with the file writable the image and its entry both go.
    const deleted = await request('/api/images/doomed.png', { method: 'DELETE' });
    assert.equal(deleted.status, 200, deleted.text);
    assert.ok(!fs.existsSync(imagePath), 'the image file is gone');
    assert.ok(!Object.hasOwn(readMetadata(), '/images/doomed.png'), 'the entry is gone');
    assert.ok(!(await listImages()).some((image) => image.url === '/images/doomed.png'), 'not listed');
  });

  await check('an unknown ?source= is a 400 with fixed text that writes nothing', async () => {
    const before = fs.readFileSync(metadataPath, 'utf8');
    for (const source of ['bogus', '', 'public/images', '../assets']) {
      for (const response of [await putMetadata('shared.png', { alt: 'x' }, source), await getMetadata('shared.png', source)]) {
        assert.equal(response.status, 400, `${JSON.stringify(source)}: ${response.status} ${response.text}`);
        assert.equal(response.body?.success, false);
        assert.equal(response.body?.error, 'source must be source, uploads or assets');
        assertNoServerPath(response.text, source);
      }
    }
    // Two sources (express parses `?source=a&source=b` as an array) are not one.
    const repeated = await request('/api/images/shared.png/metadata?source=assets&source=uploads', { method: 'PUT', body: JSON.stringify({ alt: 'x' }) });
    assert.equal(repeated.status, 400, repeated.text);
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'a refused source writes nothing');
  });

  await check('a null patch on an image with no details creates no file and no entry', async () => {
    const aside = `${metadataPath}.aside`;
    fs.renameSync(metadataPath, aside);
    try {
      for (const body of [{ focalPoint: null }, { crop: null }, {}, { focalPoint: null, crop: null }]) {
        const response = await putMetadata('lonely.png', body);
        assert.equal(response.status, 200, `${JSON.stringify(body)}: ${response.text}`);
        assert.deepEqual(response.body.metadata, {});
        assert.ok(!fs.existsSync(metadataPath), `${JSON.stringify(body)}: the metadata file was created`);
      }
      // Positive control: a value does create it.
      assert.equal((await putMetadata('lonely.png', { alt: 'Lonely' })).status, 200);
      assert.deepEqual(readMetadata(), { '/images/lonely.png': { alt: 'Lonely' } });
    } finally {
      fs.rmSync(metadataPath, { force: true });
      fs.renameSync(aside, metadataPath);
    }
    // With the file present, a null patch on an image that has no entry adds none.
    const before = fs.readFileSync(metadataPath, 'utf8');
    assert.deepEqual((await putMetadata('lonely.png', { focalPoint: null })).body.metadata, {});
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'the file is unchanged');
    assert.ok(!Object.hasOwn(readMetadata(), '/images/lonely.png'));
  });

  await check('clearing the last key of an entry removes the entry, site-path and legacy keys both', async () => {
    assert.equal((await putMetadata('lonely.png', { focalPoint: { x: 1, y: 1 } })).status, 200);
    assert.ok(Object.hasOwn(readMetadata(), '/images/lonely.png'), 'control: the entry exists');
    const cleared = await putMetadata('lonely.png', { focalPoint: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.deepEqual(cleared.body.metadata, {});
    assert.ok(!Object.hasOwn(readMetadata(), '/images/lonely.png'), `the emptied entry is gone: ${Object.keys(readMetadata())}`);
    // A legacy bare-filename entry whose only key is cleared: neither key is left.
    writeMetadata({ ...readMetadata(), 'bare.png': { crop: { x: 0, y: 0, width: 10, height: 10 } } });
    assert.deepEqual((await getMetadata('bare.png')).body.metadata, { crop: { x: 0, y: 0, width: 10, height: 10 } }, 'control');
    const emptied = await putMetadata('bare.png', { crop: null });
    assert.equal(emptied.status, 200, emptied.text);
    assert.deepEqual(emptied.body.metadata, {});
    const stored = readMetadata();
    assert.ok(!Object.hasOwn(stored, 'bare.png'), 'the legacy key is gone');
    assert.ok(!Object.hasOwn(stored, '/images/bare.png'), 'no empty site-path entry');
    // An empty alt is a value, not an empty entry.
    assert.deepEqual((await putMetadata('bare.png', { alt: '' })).body.metadata, { alt: '' });
    assert.deepEqual(readMetadata()['/images/bare.png'], { alt: '' });
  });

  await check('DELETE removes the entry under both keys, so a file back under the same name has no alt', async () => {
    const uploaded = await upload(png(1, 2, 3), 'fresh.png');
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const { filename } = uploaded.body.image;
    assert.ok(filename.startsWith('fresh-') && filename.endsWith('.png'), filename);
    assert.equal((await putMetadata(filename, { alt: 'Fresh alt' })).status, 200);
    // An older admin's entry for the same file, beside the new one.
    writeMetadata({ ...readMetadata(), [filename]: { alt: 'Fresh alt (bare key)' } });
    assert.equal((await getMetadata(filename)).body.metadata.alt, 'Fresh alt', 'control: the alt shows before the delete');

    const deleted = await request(`/api/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, deleted.text);
    assert.ok(!fs.existsSync(path.join(projectRoot, 'public/images', filename)), 'the file is gone');
    const stored = readMetadata();
    assert.ok(!Object.hasOwn(stored, `/images/${filename}`), 'the site-path entry is gone');
    assert.ok(!Object.hasOwn(stored, filename), 'the bare-filename entry is gone');

    // The same name again (a second upload of the file, a pull, a copy).
    write(`public/images/${filename}`, png(1, 2, 3));
    assert.deepEqual((await getMetadata(filename)).body.metadata, {});
    assert.equal((await listImages()).find((image) => image.filename === filename).alt, '');

    // A legacy-only entry is removed too.
    assert.equal((await getMetadata('gone-soon.png')).body.metadata.alt, 'Old alt (bare key)', 'control');
    assert.equal((await request('/api/images/gone-soon.png', { method: 'DELETE' })).status, 200);
    assert.ok(!Object.hasOwn(readMetadata(), 'gone-soon.png'));
    write('public/images/gone-soon.png', png(5, 5, 5));
    assert.deepEqual((await getMetadata('gone-soon.png')).body.metadata, {});
  });

  await check('a PUT for an image that is not there is a 404; a refused name is a 400', async () => {
    const missing = await putMetadata('not-there.png', { alt: 'x' });
    assert.equal(missing.status, 404, missing.text);
    assertNoServerPath(missing.text, 'missing');
    for (const name of ['__proto__', 'constructor', '.metadata.json', '..%2Fx.png']) {
      const response = await request(`/api/images/${name}/metadata`, { method: 'PUT', body: JSON.stringify({ alt: 'x' }) });
      assert.equal(response.status, 400, `${name}: ${response.status}`);
    }
    assert.ok(!Object.hasOwn(readMetadata(), '__proto__'), 'nothing stored under __proto__');
    assert.equal(Object.prototype.alt, undefined);
  });

  await check('/api/config reports imageCrop from images.crop (true here, false by default)', async () => {
    const { status, body } = await request('/api/config');
    assert.equal(status, 200);
    assert.strictEqual(body.imageCrop, true);
    for (const configSource of ['none', 'export default {};\n', "export default { images: { crop: 'yes' } };\n"]) {
      const child = spawnSync(process.execPath, [selfPath, '--child', configSource], { encoding: 'utf8', env: process.env });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split('\n').pop());
      assert.equal(result.status, 200);
      assert.strictEqual(result.body.imageCrop, false, configSource);
    }
  });
} finally {
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
