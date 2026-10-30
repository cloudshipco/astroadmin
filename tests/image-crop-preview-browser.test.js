/**
 * A stored crop is shown by the editor's previews: the image field's thumbnail,
 * the gallery field's thumbnails and the gallery editor's, and the library's
 * grid, in the real dashboard in Chromium (Playwright). Until now all showed
 * the raw file, so a crop looked as if it had no effect before Publish.
 *
 * A throwaway site with `images: { crop: true }` and a 400x300 PNG whose left
 * half is red and right half blue (`public/images/photo.png`), so a crop of
 * the right half is visible: a pixel of the preview's composited box is read
 * from a screenshot. The crop view (`ui/crop-view.js`) moves the <img> into a
 * window the shape of the crop region (`[data-crop-window]`, inside the
 * preview, which carries `data-cropped` and a "Cropped" caption) and sizes it
 * from the crop's percentages: width 100/crop.width of the window, left
 * -crop.x/crop.width of it, the same for height and top. An uncropped
 * preview's DOM is as it always was: no window, no attribute, no style.
 *
 * Checks, on the first page load: (a) a crop stored before the page loads
 * crops the field preview; (a') a value stored percent-encoded
 * (`/images/hero%20image.png`) is the file `hero image.png`, asked for once
 * as `hero%20image.png`; (b) an image without a crop is untouched; (b') a
 * gallery field shows its cropped upload clipped and captioned and its other
 * one plain, in the field's thumbnails and the gallery editor's; (c) a crop
 * dragged in the library crops the field's preview on Cancel (no Select), and
 * the grid thumbnail at once; (c') Select shows the chosen image's crop, and
 * applies the crop view once, to that picker only; (e) the grid thumbnail of
 * the cropped image is clipped and another is not; (d) Clear crop puts the
 * whole image back; (f) one metadata request per filename per page load, none
 * for an image() or a video value; (g) picking a cropped file whose image never
 * loads into a cropped picker leaves no window, caption or geometry behind; (h) a
 * crop written to `.metadata.json` by another tab is on the field after the
 * library is opened and cancelled (`loadImages` seeds the page's details).
 * Then on a second load, with metadata GETs held by `page.route`: (i) a GET
 * that failed (500) is asked again by the next reader and a 200 then crops;
 * (i') after a failed GET the library's listing reaches the picker (open and
 * Cancel crops it, no second GET);
 * (j) a page-load GET answered stale, after the library cleared the crop,
 * does not bring the crop back; (k) a page-load GET aborted after the library
 * set a crop neither clears it nor forgets it. The entry is never rewritten by
 * a preview change; no page errors.
 *
 *   bun tests/image-crop-preview-browser.test.js     (~8 s)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtures = path.join(repoRoot, 'tests/fixtures/video');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-crop-preview-')));
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
writeProjectFile('astroadmin.config.js', 'export default { images: { crop: true } };\n');
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: ({ image }) => z.object({
      title: z.string(),
      heroImage: z.string().optional(),
      secondImage: z.string().optional(),
      thirdImage: z.string().optional(),
      fourthImage: z.string().optional(),
      flakyImage: z.string().optional(),
      laterImage: z.string().optional(),
      sourceImage: z.string().optional(),
      heroVideo: z.string().optional(),
      cover: image().optional(),
      gallery: z.array(z.object({ src: z.string(), alt: z.string().optional() })).optional(),
    }),
  }),
};
`);
const HOME_FILE = 'src/content/pages/home.md';
const HOME_TEXT = `---
title: Home
heroImage: /images/photo.png
secondImage: /images/plain.png
thirdImage: /images/photo.png
fourthImage: /images/hero%20image.png
flakyImage: /images/flaky.png
laterImage: /images/later.png
sourceImage: /images/source.png
heroVideo: /images/clip.webm
cover: ./pic.png
gallery:
  - src: /images/photo.png
  - src: /images/plain.png
---
`;
writeProjectFile(HOME_FILE, HOME_TEXT);

const sharp = (await import('sharp')).default;
const RED = { r: 220, g: 30, b: 30 };
const BLUE = { r: 30, g: 40, b: 220 };
const half = (background) => sharp({ create: { width: 200, height: 300, channels: 3, background } }).png().toBuffer();
const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: RED } })
  .composite([{ input: await half(BLUE), left: 200, top: 0 }]).png().toBuffer();
const plain = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 140, b: 160 } } }).png().toBuffer();
writeProjectFile('public/images/photo.png', photo);
writeProjectFile('public/images/plain.png', plain);
writeProjectFile('public/images/hero image.png', photo);
writeProjectFile('public/images/flaky.png', photo);
writeProjectFile('public/images/later.png', photo);
writeProjectFile('public/images/never.png', plain);
writeProjectFile('src/assets/images/source.png', plain);
writeProjectFile('src/content/pages/pic.png', plain);
writeProjectFile('public/images/clip.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));
// (a) the crop is stored before the page loads: the right half of photo.png
const RIGHT_HALF = { x: 50, y: 0, width: 50, height: 100 };
const metadataPath = path.join(projectRoot, 'public/images/.metadata.json');
writeProjectFile('public/images/.metadata.json', JSON.stringify({
  '/images/photo.png': { crop: RIGHT_HALF },
  '/images/hero image.png': { crop: RIGHT_HALF },
  '/images/flaky.png': { crop: RIGHT_HALF },
  '/images/later.png': { crop: RIGHT_HALF },
  '/images/never.png': { crop: RIGHT_HALF },
}, null, 2));

const homeText = () => fs.readFileSync(path.join(projectRoot, HOME_FILE), 'utf8');
const isCropLike = (crop) => Boolean(crop) && typeof crop.width === 'number';
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `what` may be a function, read when the wait fails (so it can show the last reading). */
async function waitUntil(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await settle(50);
  }
  throw new Error(typeof what === 'function' ? what() : what);
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

const browser = await launchChromium(chromium);
const page = await browser.newPage();
page.setDefaultTimeout(8000);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
/** Alerts the page raised (a failed library save says so in one); none are expected. */
const dialogs = [];
page.on('dialog', (dialog) => {
  dialogs.push(dialog.message());
  dialog.dismiss().catch(() => {});
});

/** Metadata GETs by filename since the last page load, the `?source=` each carried, and their raw paths. */
let metadataGets = new Map();
let metadataGetSources = [];
let metadataGetPaths = [];
page.on('request', (request) => {
  const url = new URL(request.url());
  const match = request.method() === 'GET' && url.pathname.match(/^\/api\/images\/([^/]+)\/metadata$/);
  if (!match) return;
  const filename = decodeURIComponent(match[1]);
  metadataGets.set(filename, (metadataGets.get(filename) || 0) + 1);
  metadataGetSources.push(url.searchParams.get('source'));
  metadataGetPaths.push(url.pathname);
});
function resetRequestLog() {
  metadataGets = new Map();
  metadataGetSources = [];
  metadataGetPaths = [];
}

const modal = page.locator('#imageLibraryModal');
const panel = modal.locator('[data-focal-panel]');
const preview = (field) => `.image-picker[data-field="${field}"] [data-preview]`;
const galleryThumb = (index) => `.gallery-field[data-field="gallery"] .gallery-field-thumb:nth-child(${index + 1})`;
const galleryEditorThumb = (index) => `#galleryEditorModal .gallery-editor-item[data-index="${index}"] .gallery-editor-item-thumb`;

/**
 * How a preview shows its image: the container's attribute and caption, the
 * window (if any) and the <img>'s box, its parent and inline style. For the
 * grid and the gallery thumbnails, `imageSelector` is `img`.
 */
async function measure(containerSelector, imageSelector = '[data-preview-img]') {
  return page.evaluate(([containerSelector, imageSelector]) => {
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const container = document.querySelector(containerSelector);
    const cropWindow = container.querySelector('[data-crop-window]');
    const image = container.querySelector(imageSelector);
    return {
      cropped: container.hasAttribute('data-cropped'),
      caption: getComputedStyle(container, '::after').content,
      container: rect(container),
      // inside its border: what a child's 100% is
      inner: { width: container.clientWidth, height: container.clientHeight },
      window: cropWindow ? rect(cropWindow) : null,
      image: rect(image),
      imageInWindow: image.parentElement === cropWindow,
      imageInContainer: image.parentElement === container,
      style: image.getAttribute('style'),
      loaded: image.complete && image.naturalWidth > 0,
      natural: { width: image.naturalWidth, height: image.naturalHeight },
    };
  }, [containerSelector, imageSelector]);
}

/** Wait for a preview's image to be loaded, cropped or not as asked. */
async function waitForPreview(containerSelector, cropped, imageSelector) {
  let last = null;
  await waitUntil(async () => {
    last = await measure(containerSelector, imageSelector);
    return last.loaded && last.cropped === cropped && (!cropped || last.window !== null);
  }, () => `${containerSelector} is not ${cropped ? 'cropped' : 'whole'} (${JSON.stringify(last)})`);
  return last;
}

/**
 * The crop view's geometry for `crop`: the window is the crop region's shape,
 * the image is 100/width wider and 100/height taller than it, offset so the
 * region fills the window.
 */
function assertCropGeometry(seen, crop, what) {
  assert.equal(seen.cropped, true, `${what}: data-cropped`);
  assert.match(seen.caption, /Cropped/, `${what}: caption`);
  assert.ok(seen.imageInWindow, `${what}: the image is inside the window`);
  const { window: box, image, natural } = seen;
  const regionAspect = (natural.width * crop.width / 100) / (natural.height * crop.height / 100);
  near(box.width / box.height, regionAspect, 0.03, `${what}: window aspect`);
  near(image.width / box.width, 100 / crop.width, 0.03, `${what}: image width over window width`);
  near(image.height / box.height, 100 / crop.height, 0.03, `${what}: image height over window height`);
  near((box.x - image.x) / box.width, crop.x / crop.width, 0.03, `${what}: image left`);
  near((box.y - image.y) / box.height, crop.y / crop.height, 0.03, `${what}: image top`);
}

/** The DOM of a preview that was never cropped, or had its crop cleared. */
function assertWhole(seen, what) {
  assert.equal(seen.cropped, false, `${what}: no data-cropped`);
  assert.equal(seen.window, null, `${what}: no window`);
  assert.equal(seen.caption, 'none', `${what}: no caption`);
  assert.ok(seen.imageInContainer, `${what}: the image is the container's own child`);
  assert.equal(seen.style, null, `${what}: no inline style`);
}

/** The colour of a composited pixel at (x, y) of the page, from a screenshot. */
async function pixelAt(x, y) {
  const shot = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
  const { data } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}
const isBlue = ({ r, g, b }) => b > 180 && r < 80 && g < 80;
const isRed = ({ r, g, b }) => r > 180 && g < 80 && b < 80;
const colour = (pixel) => `rgb(${pixel.r},${pixel.g},${pixel.b})`;

/**
 * Where an uncropped picture is drawn inside its contain-fitted <img> box
 * (`object-fit: contain`: scaled to fit, centred), so a pixel reading of the
 * whole image is taken from the picture, not the letterbox beside it.
 */
function containedRect(box, natural) {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** A measured container's box inside its border. */
const innerRect = ({ container, inner }) => ({
  x: container.x + (container.width - inner.width) / 2,
  y: container.y + (container.height - inner.height) / 2,
  width: inner.width,
  height: inner.height,
});

/** Points just inside a box's left and right edges, at mid height, and its centre. */
const edges = (box) => ({
  left: { x: box.x + 3, y: box.y + box.height / 2 },
  centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  right: { x: box.x + box.width - 4, y: box.y + box.height / 2 },
});

async function openLibrary(field) {
  if (await modal.isVisible()) await modal.locator('[data-cancel]').click();
  await page.locator(`.image-picker[data-field="${field}"] [data-browse]`).click();
  await modal.locator('.image-library-item').first().waitFor();
}
async function cancelLibrary() {
  await modal.locator('[data-cancel]').click();
  await modal.waitFor({ state: 'hidden' });
}
async function selectInLibrary(url) {
  await modal.locator(`.image-library-item[data-url="${url}"]`).click();
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector('#imageLibraryModal [data-focal-image]');
    return image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 100;
  });
  return panel.locator('[data-focal-box]').boundingBox();
}
const pointIn = (rect, xPercent, yPercent) => ({ x: rect.x + rect.width * xPercent / 100, y: rect.y + rect.height * yPercent / 100 });
const DRAGGED = { x: 10, y: 10, width: 50, height: 60 };
async function dragCrop(rect) {
  const from = pointIn(rect, DRAGGED.x, DRAGGED.y);
  const to = pointIn(rect, DRAGGED.x + DRAGGED.width, DRAGGED.y + DRAGGED.height);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
/** The metadata file as stored, or null while the server is mid-write (a poll may read half of it). */
function metadataFile() {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}
/** The stored crop of `url`: undefined for none, null while the file is unreadable. */
function storedCrop(url) {
  const file = metadataFile();
  return file === null ? null : file[url]?.crop;
}

/**
 * Count, per picker, the crop view's applications to its preview from now
 * on: each sets `data-cropped` on the container, a mutation record whose
 * target then carries the attribute (a clear's record is delivered with it
 * gone). Read back with `cropApplications()`.
 */
async function countCropApplications() {
  await page.evaluate(() => {
    window.__cropApplications = {};
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (!record.target.hasAttribute('data-cropped')) continue;
        const field = record.target.closest('.image-picker')?.dataset.field;
        window.__cropApplications[field] = (window.__cropApplications[field] || 0) + 1;
      }
    });
    document.querySelectorAll('.image-picker [data-preview]').forEach((container) => {
      observer.observe(container, { attributes: true, attributeFilter: ['data-cropped'] });
    });
  });
}
const cropApplications = () => page.evaluate(() => window.__cropApplications);

/** Tell the page a file's details changed (what the library does after a save), as its own listeners hear it. */
async function announceDetails(filename) {
  await page.evaluate((filename) => {
    document.dispatchEvent(new CustomEvent('astroadmin:image-details', { detail: { filename, source: 'uploads', metadata: null } }));
  }, filename);
}

async function login() {
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForURL(/dashboard/), page.press('#password', 'Enter')]);
}
async function openHome() {
  resetRequestLog();
  await page.goto(`${base}/dashboard/pages/home`);
  await page.locator('.image-picker[data-field="heroImage"]').waitFor();
}

// (g) never.png's image request never answers, so its <img> never loads
await page.route((url) => url.pathname === '/images/never.png', () => {});

try {
  await login();
  await openHome();

  console.log('\n🧪 crop previews in the field and the library grid\n' + '='.repeat(40));

  await check('(a) a crop stored before the page loads: the field preview shows only the cropped region, with the caption', async () => {
    const seen = await waitForPreview(preview('heroImage'), true);
    assertCropGeometry(seen, RIGHT_HALF, 'heroImage');
    assert.ok(seen.window.x >= seen.container.x - 0.5 && seen.window.x + seen.window.width <= seen.container.x + seen.container.width + 0.5, 'the window is inside the preview');
    // What is composited: the window shows the blue (right) half only, edge to edge
    const { left, centre, right } = edges(seen.window);
    for (const [name, point] of Object.entries({ left, centre, right })) {
      const pixel = await pixelAt(point.x, point.y);
      assert.ok(isBlue(pixel), `${name} of the cropped preview is ${colour(pixel)}, not blue`);
    }
    // The same crop for the other field holding the file
    assertCropGeometry(await waitForPreview(preview('thirdImage'), true), RIGHT_HALF, 'thirdImage');
    assert.equal(await page.locator('[name="heroImage"]').inputValue(), '/images/photo.png', 'the control holds the stored value');
  });

  await check("(a') a value stored percent-encoded is the file it names: `/images/hero%20image.png` is cropped as `hero image.png`, asked for once", async () => {
    const seen = await waitForPreview(preview('fourthImage'), true);
    assertCropGeometry(seen, RIGHT_HALF, 'fourthImage');
    assert.equal(await page.locator('[name="fourthImage"]').inputValue(), '/images/hero%20image.png', 'the control is as stored');
    const paths = metadataGetPaths.filter((requestPath) => /hero/.test(requestPath));
    assert.deepEqual(paths, ['/api/images/hero%20image.png/metadata'], 'the request path');
  });

  await check('(b) an image with no crop is shown as before: no window, attribute, caption or style', async () => {
    const seen = await waitForPreview(preview('secondImage'), false);
    assertWhole(seen, 'secondImage');
    // The whole picture, contained in a box as wide as the preview
    near(seen.image.width, seen.container.width, 1, 'the <img> is the preview\'s width');
    assert.ok(seen.image.height <= 192 + 1, `capped at 12rem, got ${seen.image.height}`);
    near(containedRect(seen.image, seen.natural).width / containedRect(seen.image, seen.natural).height, 400 / 300, 0.03, 'the picture keeps its shape');
    // The src/assets file at /images/source.png and the image() value likewise
    for (const field of ['sourceImage', 'cover']) {
      const other = await waitForPreview(preview(field), false);
      assert.equal(other.window, null, field);
      assert.equal(other.style, null, field);
    }
  });

  await check("(b') a gallery field: the cropped upload's thumbnail is clipped and captioned, the other plain, in the field and in the gallery editor", async () => {
    await page.locator(galleryThumb(0)).scrollIntoViewIfNeeded();
    const cropped = await waitForPreview(galleryThumb(0), true, 'img');
    assertCropGeometry(cropped, RIGHT_HALF, 'gallery thumbnail 0');
    assert.ok(cropped.window.width >= cropped.inner.width - 1 && cropped.window.height >= cropped.inner.height - 1, `the window covers the thumbnail: ${JSON.stringify(cropped)}`);
    const centre = edges(innerRect(cropped)).centre;
    const onThumb = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.gallery-field-thumb') !== null, [centre.x, centre.y]);
    assert.ok(onThumb, 'the centre point is on the thumbnail');
    const pixel = await pixelAt(centre.x, centre.y);
    assert.ok(isBlue(pixel), `the cropped thumbnail's centre is ${colour(pixel)}, not blue`);
    assertWhole(await waitForPreview(galleryThumb(1), false, 'img'), 'gallery thumbnail 1');

    await page.locator('.gallery-field[data-field="gallery"] [data-edit-gallery]').click();
    await page.locator(galleryEditorThumb(1)).waitFor();
    const inEditor = await waitForPreview(galleryEditorThumb(0), true, 'img');
    assertCropGeometry(inEditor, RIGHT_HALF, 'gallery editor item 0');
    const editorCentre = edges(innerRect(inEditor)).centre;
    const editorPixel = await pixelAt(editorCentre.x, editorCentre.y);
    assert.ok(isBlue(editorPixel), `the editor's cropped thumbnail centre is ${colour(editorPixel)}, not blue`);
    assertWhole(await waitForPreview(galleryEditorThumb(1), false, 'img'), 'gallery editor item 1');
    await page.locator('#galleryEditorModal [data-cancel]').click();
    await page.locator('#galleryEditorModal').waitFor({ state: 'hidden' });
  });

  await check('(c) a crop dragged in the library crops the field preview on Cancel, and the grid thumbnail at once', async () => {
    await openLibrary('secondImage');
    const rect = await selectInLibrary('/images/plain.png');
    await dragCrop(rect);
    await waitUntil(() => isCropLike(storedCrop('/images/plain.png')), 'the crop was not written');
    const stored = storedCrop('/images/plain.png');
    near(stored.x, DRAGGED.x, 0.5, 'stored x'); near(stored.width, DRAGGED.width, 0.5, 'stored width');
    const thumb = await waitForPreview('.image-library-item[data-url="/images/plain.png"]', true, 'img');
    assertCropGeometry(thumb, stored, 'grid thumbnail after the drag');
    await cancelLibrary();
    const seen = await waitForPreview(preview('secondImage'), true);
    assertCropGeometry(seen, stored, 'secondImage after Cancel');
    assert.equal(await page.locator('[name="secondImage"]').inputValue(), '/images/plain.png', 'the control is untouched');
  });

  await check("(c') Select shows the chosen image's crop, applying the crop view once, to that picker only", async () => {
    await openLibrary('thirdImage');
    await selectInLibrary('/images/plain.png');
    await countCropApplications();
    await modal.locator('[data-select]').click();
    await modal.waitFor({ state: 'hidden' });
    const seen = await waitForPreview(preview('thirdImage'), true);
    await waitUntil(() => isCropLike(storedCrop('/images/plain.png')), 'the file is readable');
    assertCropGeometry(seen, storedCrop('/images/plain.png'), 'thirdImage after Select');
    assert.equal(await page.locator('[name="thirdImage"]').inputValue(), '/images/plain.png');
    await settle(300);
    const applications = await cropApplications();
    assert.deepEqual(applications, { thirdImage: 1 }, `crop view applications since Select: ${JSON.stringify(applications)}`);
  });

  await check('(e) the library grid: the cropped image\'s thumbnail is clipped to the crop, another is not', async () => {
    await openLibrary('heroImage');
    const thumb = await waitForPreview('.image-library-item[data-url="/images/photo.png"]', true, 'img');
    assertCropGeometry(thumb, RIGHT_HALF, 'photo.png thumbnail');
    // Cover-fitted into the square cell: the window fills the cell's width or height
    assert.ok(thumb.window.width >= thumb.inner.width - 1 && thumb.window.height >= thumb.inner.height - 1, `the window covers the cell: ${JSON.stringify(thumb)}`);
    assert.ok(thumb.window.width <= thumb.inner.width + 1 || thumb.window.height <= thumb.inner.height + 1, `and no larger than it need be: ${JSON.stringify(thumb)}`);
    // The modal's body scrolls under the focal panel: bring the cell into
    // view and prove the sampled points land on it before reading pixels.
    const cell = modal.locator('.image-library-item[data-url="/images/photo.png"]');
    await cell.scrollIntoViewIfNeeded();
    const { left, centre, right } = edges(innerRect(await measure('.image-library-item[data-url="/images/photo.png"]', 'img')));
    for (const [name, point] of Object.entries({ left, centre, right })) {
      const onCell = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.image-library-item')?.dataset.url, [point.x, point.y]);
      assert.equal(onCell, '/images/photo.png', `${name} point is on the cell`);
      const pixel = await pixelAt(point.x, point.y);
      assert.ok(isBlue(pixel), `${name} of the cropped thumbnail is ${colour(pixel)}, not blue`);
    }
    const other = await waitForPreview('.image-library-item[data-url="/images/source.png"]', false, 'img');
    assert.equal(other.window, null);
    assert.equal(other.style, null);
    assert.ok(other.imageInContainer);
  });

  await check('(d) Clear crop in the library: the grid thumbnail and the field previews show the whole image again', async () => {
    await selectInLibrary('/images/photo.png');
    await modal.locator('[data-clear-crop]').click();
    await waitUntil(() => storedCrop('/images/photo.png') === undefined, 'the crop was not cleared');
    const thumb = await waitForPreview('.image-library-item[data-url="/images/photo.png"]', false, 'img');
    assert.equal(thumb.window, null);
    assert.ok(thumb.imageInContainer);
    assert.equal(thumb.caption, 'none');
    await cancelLibrary();
    const seen = await waitForPreview(preview('heroImage'), false);
    assertWhole(seen, 'heroImage');
    // Positive control for the pixel readings above: whole, the left is red and the right blue
    const { left, right } = edges(containedRect(seen.image, seen.natural));
    const leftPixel = await pixelAt(left.x, left.y);
    const rightPixel = await pixelAt(right.x, right.y);
    assert.ok(isRed(leftPixel), `the whole image's left is ${colour(leftPixel)}, not red`);
    assert.ok(isBlue(rightPixel), `the whole image's right is ${colour(rightPixel)}, not blue`);
    assert.equal(await page.locator('[name="heroImage"]').inputValue(), '/images/photo.png');
  });

  await check('(f) one metadata request per filename per page load, naming the uploads folder; none for an image() or video value', async () => {
    await settle(300);
    const byFilename = Object.fromEntries([...metadataGets].sort());
    assert.deepEqual(byFilename, { 'flaky.png': 1, 'hero image.png': 1, 'later.png': 1, 'photo.png': 1, 'plain.png': 1, 'source.png': 1 }, `requests by filename: ${JSON.stringify(byFilename)}`);
    assert.deepEqual([...new Set(metadataGetSources)], ['uploads']);
  });

  await check('(g) picking a cropped file whose image never loads into a cropped picker leaves no window, caption or geometry of the old crop', async () => {
    assertCropGeometry(await waitForPreview(preview('thirdImage'), true), storedCrop('/images/plain.png'), 'thirdImage before');
    assert.deepEqual(storedCrop('/images/never.png'), RIGHT_HALF, 'control: the picked file has a crop, which waits for its image');
    await openLibrary('thirdImage');
    await modal.locator('.image-library-item[data-url="/images/never.png"]').click();
    await modal.locator('[data-select]').click();
    await modal.waitFor({ state: 'hidden' });
    await settle(300);
    const seen = await measure(preview('thirdImage'));
    assert.equal(seen.loaded, false, 'the new image has not loaded (control)');
    assert.equal(await page.locator('[name="thirdImage"]').inputValue(), '/images/never.png');
    assertWhole(seen, 'thirdImage holding an unloaded file');
  });

  await check('(h) a crop written to .metadata.json behind the page\'s back is on the field after the library is opened and cancelled', async () => {
    const TOP_LEFT = { x: 0, y: 0, width: 50, height: 50 };
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadataFile(), '/images/photo.png': { crop: TOP_LEFT } }, null, 2));
    assertWhole(await waitForPreview(preview('heroImage'), false), 'heroImage before');
    await openLibrary('heroImage');
    await cancelLibrary();
    assertCropGeometry(await waitForPreview(preview('heroImage'), true), TOP_LEFT, 'heroImage after Cancel');
    const { left } = edges(await measure(preview('heroImage')).then((seen) => seen.window));
    const pixel = await pixelAt(left.x, left.y);
    assert.ok(isRed(pixel), `the top-left crop's left is ${colour(pixel)}, not red`);
  });

  await check('the entry was never rewritten by a preview change; each Select saved its field only', async () => {
    // The last Select's autosave is debounced (1 s) and then written by a
    // server that may be slow on a loaded machine: wait for THAT write (it
    // landed 15 s late once, under parallel builds), then pin the whole text.
    const expected = HOME_TEXT.replace('thirdImage: /images/photo.png', 'thirdImage: /images/never.png');
    await waitUntil(() => homeText().includes('thirdImage: /images/never.png'), () => `the Select of never.png was not saved; the entry reads:\n${homeText()}`, 15000);
    await settle(1200); // past one more debounce: a preview change must queue no further save
    assert.equal(homeText(), expected);
  });

  console.log('\n🧪 a second page load, with metadata GETs held or failed\n' + '='.repeat(40));

  // The page-load GETs for plain.png and photo.png are held until the check
  // lets them go; plain.png's is answered by the server NOW (while its crop
  // is stored), so the answer is stale by the time it lands.
  // (page.route sees every method: the library's PUTs go through untouched.)
  const held = new Map();
  await page.route((url) => /^\/api\/images\/(plain|photo)\.png\/metadata$/.test(url.pathname), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const filename = route.request().url().match(/images\/([^/]+)\/metadata/)[1];
    held.set(filename, { route, response: filename === 'plain.png' ? await route.fetch() : null });
  });
  // flaky.png's and later.png's first GET each is a 500; any later one is the server's
  const failedOnce = new Map();
  await page.route((url) => /^\/api\/images\/(flaky|later)\.png\/metadata$/.test(url.pathname), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const filename = route.request().url().match(/images\/([^/]+)\/metadata/)[1];
    if (failedOnce.has(filename)) return route.continue();
    failedOnce.set(filename, true);
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Failed to get image metadata' }) });
  });
  await openHome();

  await check('(i) a metadata GET that failed (500) is not remembered: the next reader asks again, and a 200 then crops', async () => {
    await waitUntil(() => failedOnce.has('flaky.png'), 'the first GET');
    assertWhole(await waitForPreview(preview('flakyImage'), false), 'flakyImage after the 500');
    await announceDetails('flaky.png');
    assertCropGeometry(await waitForPreview(preview('flakyImage'), true), RIGHT_HALF, 'flakyImage after the 200');
    assert.equal(metadataGets.get('flaky.png'), 2, 'GETs for flaky.png');
  });

  await check("(i') after a failed GET, the library's listing reaches the picker: open and Cancel crops it, with no second GET", async () => {
    await waitUntil(() => failedOnce.has('later.png'), 'the first GET');
    assertWhole(await waitForPreview(preview('laterImage'), false), 'laterImage after the 500');
    await openLibrary('laterImage');
    await cancelLibrary();
    assertCropGeometry(await waitForPreview(preview('laterImage'), true), RIGHT_HALF, 'laterImage after open and Cancel');
    assert.equal(metadataGets.get('later.png'), 1, 'GETs for later.png');
  });

  await check('(j) a page-load GET answered stale, after the library cleared the crop, does not bring the crop back', async () => {
    await waitUntil(() => held.has('plain.png'), 'the page-load GET for plain.png');
    assert.ok(isCropLike(storedCrop('/images/plain.png')), 'control: the crop is stored when the stale answer is taken');
    await openLibrary('secondImage');
    await selectInLibrary('/images/plain.png');
    await modal.locator('[data-clear-crop]').click();
    await waitUntil(() => storedCrop('/images/plain.png') === undefined, 'the crop was not cleared');
    await cancelLibrary();
    assertWhole(await waitForPreview(preview('secondImage'), false), 'secondImage after Clear crop');
    const { route, response } = held.get('plain.png');
    await route.fulfill({ response });
    await settle(300);
    assertWhole(await measure(preview('secondImage')), 'secondImage after the stale answer landed');
  });

  await check('(k) a page-load GET aborted after the library set a crop neither clears the crop nor forgets it', async () => {
    await waitUntil(() => held.has('photo.png'), 'the page-load GET for photo.png');
    await openLibrary('heroImage');
    const rect = await selectInLibrary('/images/photo.png');
    await dragCrop(rect);
    await waitUntil(() => {
      const crop = storedCrop('/images/photo.png');
      return isCropLike(crop) && Math.abs(crop.x - DRAGGED.x) < 0.5;
    }, 'the crop was not written');
    await cancelLibrary();
    const dragged = storedCrop('/images/photo.png');
    assertCropGeometry(await waitForPreview(preview('heroImage'), true), dragged, 'heroImage after Cancel');
    await held.get('photo.png').route.abort();
    await settle(300);
    assertCropGeometry(await measure(preview('heroImage')), dragged, 'heroImage after the abort');
    await announceDetails('photo.png');
    await settle(300);
    assertCropGeometry(await measure(preview('heroImage')), dragged, 'heroImage after the next reader');
    assert.equal(metadataGets.get('photo.png'), 1, 'GETs for photo.png on this page load');
  });

  await check('the entry is still as the first page left it', async () => {
    await settle(1200); // longer than the autosave debounce (1000 ms)
    assert.equal(homeText(), HOME_TEXT.replace('thirdImage: /images/photo.png', 'thirdImage: /images/never.png'));
  });

  await check('no script errors, and no alerts, on the page', () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(dialogs, []);
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
