/**
 * Video uploads through the real upload route (server/api/images.js).
 *
 * The library takes short MP4 and WebM files beside its images, in
 * public/images, with their own 20MB cap (under the hosted nginx's 25m body
 * limit, so the editor gets our message instead of nginx's 413 page). A video
 * is checked by its first bytes, not just its name: an `ftyp` box for .mp4
 * (not QuickTime's `qt  ` brand) and the EBML header for .webm. Videos are
 * public files only: an image() upload, entry-value and the entry-file
 * preview refuse them.
 *
 * Fixtures in tests/fixtures/video are real ffmpeg output (96x54 testsrc):
 *   ffmpeg -f lavfi -i testsrc=size=96x54:rate=10:duration=2 -c:v libvpx-vp9 -b:v 50k -an clip.webm
 *   ffmpeg -f lavfi -i testsrc=size=96x54:rate=10:duration=2 -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart clip.mp4
 *   ffmpeg -f lavfi -i testsrc=size=96x54:rate=10:duration=1 -c:v libx264 -pix_fmt yuv420p -an -f mov clip.mov
 *   ffmpeg -f lavfi -i sine=frequency=440:duration=1 -c:a aac -b:a 16k tone.m4a
 *   ffmpeg -f lavfi -i testsrc=size=96x54:rate=10:duration=1 -c:v libvpx-vp9 -b:v 30k -an -f matroska clip.mkv
 * An AVIF still (ISO base media too, brands avif/mif1) is made with sharp.
 *
 *   bun tests/video-upload.test.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtures = path.join(repoRoot, 'tests/fixtures/video');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-video-upload-')));
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
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
writeProjectFile('package.json', JSON.stringify({ type: 'module' }));
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');

const MP4 = fs.readFileSync(path.join(fixtures, 'clip.mp4'));
const WEBM = fs.readFileSync(path.join(fixtures, 'clip.webm'));
const MOV = fs.readFileSync(path.join(fixtures, 'clip.mov'));
// An Apple M4V export (Compressor, AVFoundation): the real MP4 with its ftyp
// box rewritten in place, same length: major 'M4V ', compatible
// 'M4V ' 'M4A ' 'mp42' 'isom'. Browsers play it; the M4A brand is not audio.
const M4V = Buffer.from(MP4);
assert.equal(M4V.toString('latin1', 4, 12), 'ftypisom', 'the fixture ftyp is where it is rewritten');
M4V.write('M4V ', 8, 'latin1');
M4V.write('M4V M4A mp42isom', 16, 'latin1');
const M4A = fs.readFileSync(path.join(fixtures, 'tone.m4a'));
const MKV = fs.readFileSync(path.join(fixtures, 'clip.mkv'));
const AVIF = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 40, b: 40 } } }).avif().toBuffer();
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
const MB = 1024 * 1024;

/** The real MP4's bytes, padded to `size` (its ftyp box is untouched). */
function paddedMp4(size) {
  return Buffer.concat([MP4, Buffer.alloc(size - MP4.length)]);
}

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

async function upload(bytes, filename, query = '') {
  const form = new FormData();
  form.append('image', new Blob([bytes]), filename);
  const response = await fetch(`${base}/api/images${query}`, { method: 'POST', headers: { cookie }, body: form });
  return { status: response.status, body: await response.json() };
}

/** Every file in a project folder (nothing is left behind by a refusal). */
function filesIn(relativeDirectory) {
  try {
    return fs.readdirSync(path.join(projectRoot, relativeDirectory)).sort();
  } catch {
    return [];
  }
}

console.log('\n🧪 video uploads\n' + '='.repeat(40));

await check('an MP4 and a WebM install into public/images, byte for byte, and list as videos', async () => {
  for (const [bytes, name] of [[MP4, 'Hero Loop.mp4'], [WEBM, 'hero-loop.webm']]) {
    const { status, body } = await upload(bytes, name);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.image.kind, 'video');
    assert.match(body.image.url, /^\/images\/hero-loop-\d+\.(mp4|webm)$/);
    const onDisk = fs.readFileSync(path.join(projectRoot, 'public', body.image.url));
    assert.ok(onDisk.equals(bytes), `${name}: installed file differs`);
  }
  const listing = await (await fetch(`${base}/api/images`, { headers: { cookie } })).json();
  const videos = listing.images.filter((item) => item.kind === 'video').map((item) => item.extension).sort();
  assert.deepEqual(videos, ['mp4', 'webm']);
});

await check('an uploaded video is served with its type and answers a Range request (players seek)', async () => {
  const { body } = await upload(WEBM, 'range.webm');
  const full = await fetch(base + body.image.url, { headers: { cookie } });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-type') || '', /^video\/webm/);
  const ranged = await fetch(base + body.image.url, { headers: { cookie, Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(WEBM.subarray(0, 4)));
});

await check('an image still uploads and lists as an image (control)', async () => {
  const { status, body } = await upload(PNG_HEADER, 'still.png');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.image.kind, 'image');
  const listing = await (await fetch(`${base}/api/images`, { headers: { cookie } })).json();
  assert.equal(listing.images.find((item) => item.url === body.image.url)?.kind, 'image');
});

await check('a .mov is refused by extension', async () => {
  const before = filesIn('public/images');
  const { status, body } = await upload(MOV, 'clip.mov');
  assert.equal(status, 400);
  assert.match(body.error, /File type not allowed/);
  assert.deepEqual(filesIn('public/images'), before);
});

await check('a QuickTime file renamed .mp4 is refused by its ftyp brand', async () => {
  const before = filesIn('public/images');
  const { status, body } = await upload(MOV, 'renamed.mp4');
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.error, 'That file is not an MP4 or WebM video');
  assert.deepEqual(filesIn('public/images'), before);
});

await check('a text file renamed .mp4 or .webm is refused by its content', async () => {
  const before = filesIn('public/images');
  for (const name of ['notes.mp4', 'notes.webm']) {
    const { status, body } = await upload(Buffer.from('hello, this is not a video at all'), name);
    assert.equal(status, 400, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.error, 'That file is not an MP4 or WebM video');
  }
  // An MP4 renamed .webm is not a WebM either.
  const swapped = await upload(MP4, 'swapped.webm');
  assert.equal(swapped.status, 400);
  assert.deepEqual(filesIn('public/images'), before);
});

await check('other ISO base media and Matroska files renamed .mp4/.webm are refused', async () => {
  const before = filesIn('public/images');
  assert.equal(AVIF.toString('latin1', 4, 8), 'ftyp', 'the AVIF really is ISO base media (control)');
  for (const [bytes, name] of [[AVIF, 'still.mp4'], [M4A, 'tone.mp4'], [MKV, 'clip.webm']]) {
    const { status, body } = await upload(bytes, name);
    assert.equal(status, 400, `${name}: ${JSON.stringify(body)}`);
    assert.equal(body.error, 'That file is not an MP4 or WebM video', name);
  }
  assert.deepEqual(filesIn('public/images'), before);
});

await check('an Apple M4V export renamed .mp4 is accepted (its compatible brands list M4A)', async () => {
  const { status, body } = await upload(M4V, 'apple-export.mp4');
  assert.equal(status, 200, JSON.stringify(body));
});

await check("a picker's upload (?kind=) takes only its own kind", async () => {
  const before = filesIn('public/images');
  const videoIntoImage = await upload(MP4, 'clip.mp4', '?kind=image');
  assert.equal(videoIntoImage.status, 400);
  assert.equal(videoIntoImage.body.error, 'This field takes an image, not a video');
  const imageIntoVideo = await upload(PNG_HEADER, 'still.png', '?kind=video');
  assert.equal(imageIntoVideo.status, 400);
  assert.equal(imageIntoVideo.body.error, 'This field takes a video (MP4 or WebM)');
  assert.deepEqual(filesIn('public/images'), before);
  // Control: each kind into its own picker.
  assert.equal((await upload(MP4, 'clip.mp4', '?kind=video')).status, 200);
  assert.equal((await upload(PNG_HEADER, 'still.png', '?kind=image')).status, 200);
});

await check('a video over 20MB is refused with our message; one just under is accepted', async () => {
  const before = filesIn('public/images');
  const over = await upload(paddedMp4(20 * MB + 1), 'too-long.mp4');
  assert.equal(over.status, 400, JSON.stringify(over.body));
  assert.equal(over.body.error, 'Videos must be under 20MB; export at 720p, about 20 seconds');
  assert.deepEqual(filesIn('public/images'), before);

  const under = await upload(paddedMp4(19 * MB), 'nineteen.mp4');
  assert.equal(under.status, 200, JSON.stringify(under.body));
});

await check('an image keeps its 10MB cap, though the multer limit is now the video cap', async () => {
  const before = filesIn('public/images');
  const over = await upload(Buffer.concat([PNG_HEADER, Buffer.alloc(10 * MB)]), 'huge.png');
  assert.equal(over.status, 400, JSON.stringify(over.body));
  assert.equal(over.body.error, 'File too large. Maximum size is 10MB');
  const wayOver = await upload(Buffer.concat([PNG_HEADER, Buffer.alloc(21 * MB)]), 'huger.png');
  assert.equal(wayOver.status, 400);
  assert.equal(wayOver.body.error, 'File too large. Maximum size is 10MB');
  assert.deepEqual(filesIn('public/images'), before);
});

await check('a video is never an image() value: upload, entry-value and entry-file refuse it', async () => {
  const assetsBefore = filesIn('src/content/assets/images');
  const imageField = await upload(MP4, 'field.mp4', '?for=image-field');
  assert.equal(imageField.status, 400, JSON.stringify(imageField.body));
  assert.equal(imageField.body.error, 'This field takes an image, not a video');
  assert.deepEqual(filesIn('src/content/assets/images'), assetsBefore);

  const { body } = await upload(MP4, 'library.mp4');
  const entryValue = await fetch(`${base}/api/images/${encodeURIComponent(body.image.filename)}/entry-value`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'pages', slug: 'home' }),
  });
  assert.equal(entryValue.status, 400);
  assert.deepEqual(filesIn('src/content/assets/images'), assetsBefore, 'nothing copied into image() assets');

  writeProjectFile('src/content/assets/images/beside.mp4', MP4);
  const entryFile = await fetch(`${base}/api/images/entry-file?${new URLSearchParams({ collection: 'pages', slug: 'home', path: '../assets/images/beside.mp4' })}`, { headers: { cookie } });
  assert.equal(entryFile.status, 400);
});

await check('a video\'s metadata and delete go through the shared filename guard', async () => {
  const { body } = await upload(WEBM, 'deletable.webm');
  const put = await fetch(`${base}/api/images/${body.image.filename}/metadata`, {
    method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ alt: 'Waves' }),
  });
  assert.equal(put.status, 200);
  const removed = await fetch(`${base}/api/images/${body.image.filename}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(projectRoot, 'public', body.image.url)), false);
});

server.close();
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
