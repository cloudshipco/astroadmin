/**
 * components/image-service.js (`astroadmin/image-service`): Astro's sharp
 * service wrapped with a non-destructive `crop` (#82), without a site build:
 *
 * - `getURL` appends `crop=<x>,<y>,<width>,<height>` to the parent's dev URL,
 *   and `parseURL` reads it back as numbers; a malformed or out-of-range
 *   crop in a URL parses as none (the dev endpoint calls parseURL then
 *   transform, with no validateOptions between);
 * - `validateOptions` refuses a crop missing a side (`{x:60,width:50}`) or
 *   out of range (`x+width > 100`) with an error naming `crop`, accepts a
 *   valid one unchanged, and drops a `null` or absent one;
 * - two transforms differing only in crop hash differently (Astro's own
 *   `hashTransform` with the service's `propertiesToHash`, which keeps every
 *   default property), and the same crop hashes the same;
 * - `getHTMLAttributes` emits no `crop` attribute;
 * - `cropPixels` rounds each percentage against the size and never runs past
 *   the edge (a rounded left + width can exceed the width by one);
 * - `transform` on a generated 100x50 PNG with a distinct colour in the crop
 *   region returns an image of the crop's pixel size holding only that
 *   colour, resized when a smaller width is asked for, crops a rotated
 *   (EXIF orientation 6) source against its ROTATED size, keeps an animated
 *   WebP animated (two frames, each cropped, delays kept: read without
 *   `pages: -1` it came back a still), hands a 16-bit PNG to the parent at
 *   16 bits (byte-identical to the parent's transform of a sharp-made
 *   16-bit crop, which differs from an 8-bit one), and without a crop
 *   returns the parent's bytes;
 * - `components/site-files.js` imports crop.js, never image-service.js (which
 *   loads `astro/assets` and the sharp service at module top), so CmsVideo
 *   and a crop-free CmsImage render load no image service.
 *
 *   bun tests/image-service.test.js     (<1 s)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import sharpService from 'astro/assets/services/sharp';
import { baseService, hashTransform } from 'astro/assets';
import service from '../components/image-service.js';
import { cropPixels } from '../components/crop.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const config = {
  endpoint: { route: '/_image' },
  domains: [],
  remotePatterns: [],
  service: { entrypoint: 'astroadmin/image-service', config: {} },
};
const logger = { warn() {}, error() {}, info() {}, debug() {} };
const src = { src: '/_astro/photo.abc.png', width: 100, height: 50, format: 'png', fsPath: '/tmp/photo.png' };
const crop = { x: 20, y: 20, width: 50, height: 60 };

console.log('image-service:');

// --- the module boundary ----------------------------------------------------
check('site-files.js does not import image-service.js (CmsVideo and a crop-free CmsImage never load the sharp service)', () => {
  const siteFiles = fs.readFileSync(path.resolve(import.meta.dir, '../components/site-files.js'), 'utf8');
  const imports = [...siteFiles.matchAll(/^\s*import\b[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'the import list was read (positive control)');
  assert.ok(!imports.some((specifier) => /image-service/.test(specifier)), `imports: ${imports.join(', ')}`);
  assert.ok(imports.includes('./crop.js'), `imports crop.js: ${imports.join(', ')}`);
});

// --- URLs ----------------------------------------------------------------
check('getURL appends crop=x,y,width,height; parseURL reads it back as numbers', () => {
  const options = service.validateOptions({ src, width: 50, height: 30, format: 'webp', quality: 80, crop }, config);
  const url = service.getURL(options, config);
  assert.ok(url.endsWith('&crop=20%2C20%2C50%2C60') || url.endsWith('&crop=20,20,50,60'), url);
  const parsed = service.parseURL(new URL(url, 'http://localhost'), config);
  assert.deepStrictEqual(parsed.crop, crop);
  assert.strictEqual(parsed.width, 50);
  assert.strictEqual(parsed.format, 'webp');
  const parent = sharpService.parseURL(new URL(sharpService.getURL(options, config), 'http://localhost'), config);
  const { crop: _crop, ...rest } = parsed;
  assert.deepStrictEqual(rest, parent, 'everything but crop is the parent\'s');
});

check('a URL with no crop, a malformed crop, or an out-of-range crop parses as none', () => {
  for (const query of ['', '&crop=1,2', '&crop=a,b,c,d', '&crop=10,20,95,40', '&crop=-1,0,50,50', '&crop=0,0,0,50', '&crop=0,0,50,50,1']) {
    const parsed = service.parseURL(new URL(`/_image?href=%2Fa.png&w=50&h=25&f=webp${query}`, 'http://localhost'), config);
    assert.strictEqual(parsed.crop, undefined, query);
    assert.ok(!('crop' in parsed) || parsed.crop === undefined, query);
  }
});

// --- validateOptions ------------------------------------------------------
check('validateOptions refuses a crop with a side missing or out of range, naming crop', () => {
  for (const bad of [{ x: 60, width: 50 }, { x: 60, y: 0, width: 50, height: 50 }, { x: 0, y: 60, width: 50, height: 50 }, { x: 0, y: 0, width: 0, height: 50 }, { x: -1, y: 0, width: 50, height: 50 }, { x: '10', y: 0, width: 50, height: 50 }, { x: NaN, y: 0, width: 50, height: 50 }, 'x', 5, []]) {
    assert.throws(
      () => service.validateOptions({ src, width: 50, height: 30, format: 'webp', crop: bad }, config),
      (error) => error instanceof Error && /\bcrop\b/.test(error.message),
      `refused: ${JSON.stringify(bad)}`,
    );
  }
});

check('validateOptions accepts a valid crop unchanged and drops a null or absent one', () => {
  const valid = service.validateOptions({ src, width: 50, height: 30, format: 'webp', crop: { ...crop } }, config);
  assert.deepStrictEqual(valid.crop, crop);
  assert.strictEqual(valid.width, 50);
  const edge = service.validateOptions({ src, width: 50, height: 30, format: 'webp', crop: { x: 0, y: 0, width: 100, height: 100 } }, config);
  assert.deepStrictEqual(edge.crop, { x: 0, y: 0, width: 100, height: 100 });
  for (const none of [null, undefined]) {
    const options = service.validateOptions({ src, width: 50, height: 30, format: 'webp', crop: none }, config);
    assert.ok(!('crop' in options), `no crop key for ${none}`);
  }
  const parent = sharpService.validateOptions({ src, width: 50, height: 30, format: 'webp' }, config);
  const ours = service.validateOptions({ src, width: 50, height: 30, format: 'webp' }, config);
  assert.deepStrictEqual(ours, parent, 'without a crop the parent\'s result');
});

// --- the hash -------------------------------------------------------------
check('two transforms differing only in crop hash differently; the same crop hashes the same', () => {
  const base = { src, width: 50, height: 30, format: 'webp', quality: 80 };
  const a = hashTransform({ ...base, crop }, 'astroadmin/image-service', service.propertiesToHash);
  const b = hashTransform({ ...base, crop: { ...crop, x: 21 } }, 'astroadmin/image-service', service.propertiesToHash);
  const none = hashTransform(base, 'astroadmin/image-service', service.propertiesToHash);
  const again = hashTransform({ ...base, crop: { ...crop } }, 'astroadmin/image-service', service.propertiesToHash);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, none);
  assert.strictEqual(a, again);
  for (const property of baseService.propertiesToHash) {
    assert.ok(service.propertiesToHash.includes(property), `keeps the default property ${property}`);
  }
  assert.ok(service.propertiesToHash.includes('crop'));
});

// --- the <img> attributes --------------------------------------------------
check('getHTMLAttributes emits no crop attribute', () => {
  const options = service.validateOptions({ src, width: 50, height: 30, format: 'webp', crop, class: 'photo' }, config);
  const attributes = service.getHTMLAttributes(options, config);
  assert.ok(!('crop' in attributes), JSON.stringify(attributes));
  assert.deepStrictEqual(attributes, { class: 'photo', width: 50, height: 30, loading: 'lazy', decoding: 'async' });
});

// --- cropPixels -----------------------------------------------------------
check('cropPixels rounds against the size and never runs past the edge', () => {
  assert.deepStrictEqual(cropPixels(crop, 100, 50), { left: 20, top: 10, width: 50, height: 30 });
  assert.deepStrictEqual(cropPixels({ x: 33.3, y: 0, width: 66.7, height: 100 }, 100, 50), { left: 33, top: 0, width: 67, height: 50 });
  // 3 px wide, x 50%: left rounds to 2 and width to 2; the width is clamped.
  assert.deepStrictEqual(cropPixels({ x: 50, y: 50, width: 50, height: 50 }, 3, 3), { left: 2, top: 2, width: 1, height: 1 });
  // A sliver rounds to nothing; one pixel at least.
  assert.deepStrictEqual(cropPixels({ x: 0, y: 0, width: 0.1, height: 0.1 }, 100, 50), { left: 0, top: 0, width: 1, height: 1 });
});

// --- transform ---------------------------------------------------------------
/** 100x50, red, with the crop's region (left 20, top 10, 50x30) blue. */
async function regionPng() {
  const blue = await sharp({ create: { width: 50, height: 30, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
  return sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .composite([{ input: blue, left: 20, top: 10 }])
    .png()
    .toBuffer();
}
async function pixels(data) {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const colours = new Set();
  for (let offset = 0; offset < raw.length; offset += info.channels) {
    colours.add(`${raw[offset]},${raw[offset + 1]},${raw[offset + 2]}`);
  }
  return { width: info.width, height: info.height, colours: [...colours] };
}

const png = await regionPng();
await checkAsync('transform with a crop returns the region at its pixel size, holding only its colour', async () => {
  const options = service.validateOptions({ src: '/photo.png', width: 50, height: 30, format: 'png', crop }, config);
  const { data, format } = await service.transform(png, options, config, logger);
  assert.strictEqual(format, 'png');
  assert.deepStrictEqual(await pixels(data), { width: 50, height: 30, colours: ['0,0,255'] });
});

await checkAsync('transform with a crop and a smaller width resizes the cropped region', async () => {
  const options = service.validateOptions({ src: '/photo.png', width: 25, height: 15, format: 'png', crop }, config);
  const { data } = await service.transform(png, options, config, logger);
  assert.deepStrictEqual(await pixels(data), { width: 25, height: 15, colours: ['0,0,255'] });
});

await checkAsync('transform crops a rotated source against its rotated size', async () => {
  // 100x50 with the left half green, marked EXIF orientation 6 (rotate 90°
  // clockwise to display): shown, it is 50x100 with the green on top. A crop
  // of the top 40% in display terms (clear of the colour boundary at the
  // half, which JPEG smears) must be all green, 50x40. Against the STORED
  // size the same percentages would be a 40x50 box with red in it.
  const green = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();
  const rotated = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .composite([{ input: green, left: 0, top: 0 }])
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const meta = await sharp(rotated).metadata();
  assert.deepStrictEqual([meta.width, meta.height, meta.orientation], [100, 50, 6], 'stored landscape, marked rotated');
  const displayed = await sharp(rotated).rotate().png().toBuffer();
  const shown = await pixels(displayed);
  assert.deepStrictEqual([shown.width, shown.height], [50, 100], 'displayed portrait (control)');
  const options = service.validateOptions({ src: '/photo.jpg', width: 50, height: 40, format: 'png', crop: { x: 0, y: 0, width: 100, height: 40 } }, config);
  const { data } = await service.transform(rotated, options, config, logger);
  const result = await pixels(data);
  assert.deepStrictEqual([result.width, result.height], [50, 40]);
  // JPEG at q100 is near-lossless; every pixel is green within a few levels.
  for (const colour of result.colours) {
    const [r, g, b] = colour.split(',').map(Number);
    assert.ok(r < 16 && g > 240 && b < 16, `green, got ${colour}`);
  }
});

await checkAsync('transform keeps an animated WebP animated through a crop (every frame cropped)', async () => {
  // Two 100x50 frames, red then green, joined as an animated WebP. The crop
  // (left 20, top 10, 50x30 of each FRAME) must come back as two pages of
  // 50x30, each its frame's colour, with the delays kept. Read without
  // `pages: -1`, the source is its first frame only and the result a still.
  const redFrame = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const greenFrame = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();
  const animated = await sharp([redFrame, greenFrame], { join: { animated: true } }).webp({ lossless: true, delay: [100, 200] }).toBuffer();
  const sourceMeta = await sharp(animated, { pages: -1 }).metadata();
  assert.deepStrictEqual([sourceMeta.pages, sourceMeta.pageHeight, sourceMeta.width], [2, 50, 100], 'two 100x50 frames (control)');
  const options = service.validateOptions({ src: '/anim.webp', width: 50, height: 30, format: 'webp', quality: 100, crop }, config);
  const { data, format } = await service.transform(animated, options, config, logger);
  assert.strictEqual(format, 'webp');
  const meta = await sharp(data, { pages: -1 }).metadata();
  assert.deepStrictEqual(
    [meta.pages, meta.width, meta.pageHeight, meta.delay],
    [2, 50, 30, [100, 200]],
    `pages, width, frame height, delays: ${JSON.stringify([meta.pages, meta.width, meta.pageHeight, meta.delay])}`,
  );
  const frames = await Promise.all([0, 1].map(async (page) => pixels(await sharp(data, { page }).png().toBuffer())));
  assert.deepStrictEqual(frames.map((frame) => [frame.width, frame.height]), [[50, 30], [50, 30]]);
  const dominant = (frame) => frame.colours.map((colour) => colour.split(',').map(Number)).every(([r, g]) => (r > 200 && g < 50) || (g > 200 && r < 50));
  assert.ok(dominant(frames[0]) && dominant(frames[1]), `each frame its own colour: ${JSON.stringify(frames.map((frame) => frame.colours))}`);
  assert.notDeepStrictEqual(frames[0].colours, frames[1].colours, 'the two frames differ');
});

await checkAsync('transform hands a 16-bit PNG to the parent at 16 bits', async () => {
  // A noisy 16-bit source: the parent's resize of a 16-bit crop and of the
  // same crop reduced to 8 bits first encode to different bytes, so the
  // intermediate's depth is visible in the output. Ours must match the
  // 16-bit one (the parent's own pipeline on a sharp-made 16-bit crop).
  const png16 = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 30000, g: 10000, b: 50000 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } },
  })
    .toColourspace('rgb16')
    .png()
    .toBuffer();
  assert.strictEqual((await sharp(png16).metadata()).depth, 'ushort', 'a 16-bit source (control)');
  const box = cropPixels(crop, 100, 50);
  const crop16 = await sharp(png16, { failOn: 'none', pages: -1 }).rotate().extract(box).toColourspace('rgb16').png({ compressionLevel: 0 }).toBuffer();
  const crop8 = await sharp(png16, { failOn: 'none', pages: -1 }).rotate().extract(box).png({ compressionLevel: 0 }).toBuffer();
  assert.strictEqual((await sharp(crop16).metadata()).depth, 'ushort');
  assert.strictEqual((await sharp(crop8).metadata()).depth, 'uchar');
  const options = service.validateOptions({ src: '/deep.png', width: 25, height: 15, format: 'png', crop }, config);
  const { crop: _crop, ...parentOptions } = options;
  const from16 = Buffer.from((await sharpService.transform(crop16, { ...parentOptions }, config, logger)).data);
  const from8 = Buffer.from((await sharpService.transform(crop8, { ...parentOptions }, config, logger)).data);
  assert.ok(!from16.equals(from8), 'the parent encodes a 16-bit and an 8-bit crop differently (control)');
  const ours = Buffer.from((await service.transform(png16, options, config, logger)).data);
  assert.ok(ours.equals(from16), 'byte-identical to the parent on the 16-bit crop');
});

await checkAsync('transform without a crop returns the parent\'s bytes', async () => {
  const options = service.validateOptions({ src: '/photo.png', width: 50, height: 25, format: 'webp', quality: 80 }, config);
  const ours = await service.transform(png, { ...options }, config, logger);
  const parent = await sharpService.transform(png, { ...options }, config, logger);
  assert.strictEqual(ours.format, parent.format);
  assert.ok(Buffer.from(ours.data).equals(Buffer.from(parent.data)), 'byte-identical to the parent');
});

console.log(`\nimage-service: ${passed} passed`);
