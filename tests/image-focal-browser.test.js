/**
 * The focal point and crop panel of the image library, in the real dashboard
 * in Chromium (Playwright). #82.
 *
 * A throwaway site with a public upload (`public/images/photo.png`, a real
 * 400x300 PNG), a src/assets image and a video. Selecting the upload shows
 * the "Focal point and crop" panel (`[data-focal-panel]`), whose image box
 * IS the rendered image; the src/assets image and the video show none. A
 * click 30% across and 20% down the box writes `focalPoint {x:30, y:20}` to
 * `public/images/.metadata.json` and draws the marker there; reopening the
 * library draws it again from the listing; Reset clears it. With
 * `/api/config` reporting `imageCrop: true`, a drag from (10%,10%) to
 * (60%,70%) sends `crop {x:10, y:10, width:50, height:60}` and draws the
 * shaded rectangle; Clear sends `crop: null`. With `imageCrop: false` the same
 * drag sends nothing and sets no focal point, while a click still does.
 *
 * `/api/config` is intercepted: `imageCrop` is forced per check (the UI reads
 * only the response), and when the REAL response has no `imageCrop` key (the
 * server side of #82 not yet in) the crop checks assert the PUT request body
 * only, and say so; with the key present they assert the metadata file as
 * written. Every other request reaches the real server.
 *
 *   bun tests/image-focal-browser.test.js     (~3 s; FOCAL_SCREENSHOT=<file> saves the crop state)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { launchChromium } from './chromium-path.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtures = path.join(repoRoot, 'tests/fixtures/video');
const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-image-focal-')));
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
// The crop opt-in of the plan, so the real server (once it reads it) reports
// imageCrop: true and the crop PUT is validated and written for real.
writeProjectFile('astroadmin.config.js', 'export default { images: { crop: true } };\n');
writeProjectFile('src/content.config.ts', `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
    schema: z.object({ title: z.string(), heroImage: z.string().optional(), heroVideo: z.string().optional() }),
  }),
};
`);
writeProjectFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');

// A real PNG with a size: a header-only file renders as nothing, and the
// panel's percentages are measured over the rendered image.
const sharp = (await import('sharp')).default;
const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 140, b: 160 } } }).png().toBuffer();
writeProjectFile('public/images/photo.png', photo);
writeProjectFile('src/assets/images/source.png', photo);
writeProjectFile('public/images/clip.webm', fs.readFileSync(path.join(fixtures, 'clip.webm')));

const METADATA_FILE = path.join(projectRoot, 'public/images/.metadata.json');
/** The upload's metadata entry, under the site-path key (#82) or the legacy bare filename. */
function photoMetadata() {
  if (!fs.existsSync(METADATA_FILE)) return undefined;
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  return metadata['/images/photo.png'] ?? metadata['photo.png'];
}
async function waitForMetadata(predicate, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate(photoMetadata())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what}; the entry is ${JSON.stringify(photoMetadata())}`);
}
/** Poll `predicate` (a request is recorded a moment after the browser sends it). */
async function waitUntil(predicate, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(what);
}
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

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

/** Every metadata PUT the dashboard sends, as its JSON body. */
const metadataPuts = [];
page.on('request', (request) => {
  if (request.method() === 'PUT' && /^\/api\/images\/[^/]+\/metadata$/.test(new URL(request.url()).pathname)) {
    metadataPuts.push(request.postDataJSON());
  }
});

/** What `imageCrop` is forced to on the real /api/config response (null: as the server says). */
let imageCropOverride = null;
await page.route('**/api/config', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (imageCropOverride !== null) body.imageCrop = imageCropOverride;
  await route.fulfill({ response, json: body });
});

const modal = page.locator('#imageLibraryModal');
const panel = modal.locator('[data-focal-panel]');
const box = panel.locator('[data-focal-box]');
const marker = panel.locator('[data-focal-marker]');
const cropRect = panel.locator('[data-crop-rect]');

async function openLibrary(field) {
  // A failed check may leave the library open; it would cover the picker.
  if (await modal.isVisible()) await modal.locator('[data-cancel]').click();
  await page.locator(`.image-picker[data-field="${field}"] [data-browse]`).click();
  await modal.locator('.image-library-item').first().waitFor();
}
async function selectUpload() {
  await modal.locator('.image-library-item[data-url="/images/photo.png"]').click();
  await panel.waitFor({ state: 'visible' });
  // The box is the rendered image: measure only once the image has loaded.
  await page.waitForFunction(() => {
    const image = document.querySelector('#imageLibraryModal [data-focal-image]');
    return image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 100;
  });
  return box.boundingBox();
}
const pointIn = (rect, xPercent, yPercent) => ({ x: rect.x + rect.width * xPercent / 100, y: rect.y + rect.height * yPercent / 100 });
async function dragCrop(rect) {
  const from = pointIn(rect, 10, 10);
  const to = pointIn(rect, 60, 70);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
try {
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForURL(/dashboard/), page.press('#password', 'Enter')]);
  await page.goto(`${base}/dashboard/pages/home`);
  await page.locator('.image-picker[data-field="heroImage"]').waitFor();

  console.log('\n🧪 focal point and crop in the image library\n' + '='.repeat(40));

  await check('selecting the public upload shows the panel, whose box is the rendered image', async () => {
    await openLibrary('heroImage');
    const rect = await selectUpload();
    assert.equal(await panel.locator('[data-focal-image]').getAttribute('src'), '/images/photo.png');
    const imageRect = await panel.locator('[data-focal-image]').boundingBox();
    near(imageRect.x, rect.x, 1, 'image left'); near(imageRect.y, rect.y, 1, 'image top');
    near(imageRect.width, rect.width, 1, 'image width'); near(imageRect.height, rect.height, 1, 'image height');
    near(rect.width / rect.height, 400 / 300, 0.02, 'aspect ratio');
    assert.ok(rect.height <= 221, `bounded height, got ${rect.height}`);
    assert.equal(await modal.locator('[data-alt-field]').isVisible(), true, 'the alt field stays');
    assert.equal(await marker.isVisible(), false, 'no point stored yet');
    assert.equal(await modal.locator('[data-reset-focal]').isVisible(), false);
  });

  await check('the src/assets image shows no panel; the alt field stays', async () => {
    await modal.locator('.image-library-item[data-url="/images/source.png"]').click();
    assert.equal(await modal.locator('[data-selected-info]').textContent().then((text) => text.trim().startsWith('source.png')), true);
    assert.equal(await panel.isVisible(), false);
    assert.equal(await modal.locator('[data-alt-field]').isVisible(), true);
    await modal.locator('.image-library-item[data-url="/images/photo.png"]').click();
    assert.equal(await panel.isVisible(), true, 'positive control: back on the upload the panel returns');
    await modal.locator('[data-cancel]').click();
  });

  await check('a video shows no panel', async () => {
    await openLibrary('heroVideo');
    await modal.locator('.image-library-item[data-url="/images/clip.webm"]').click();
    assert.equal(await modal.locator('[data-selected-info]').textContent().then((text) => text.trim().startsWith('clip.webm')), true);
    assert.equal(await panel.isVisible(), false);
    await modal.locator('[data-cancel]').click();
  });

  await check('a click 30% across and 20% down writes focalPoint {30, 20} and draws the marker there', async () => {
    await openLibrary('heroImage');
    const rect = await selectUpload();
    assert.equal(photoMetadata()?.focalPoint, undefined, 'nothing stored before the click');
    const target = pointIn(rect, 30, 20);
    await page.mouse.click(target.x, target.y);
    await waitForMetadata((entry) => entry?.focalPoint && typeof entry.focalPoint.x === 'number', 'no focal point was written');
    const { focalPoint } = photoMetadata();
    near(focalPoint.x, 30, 0.5, 'focalPoint.x'); near(focalPoint.y, 20, 0.5, 'focalPoint.y');
    assert.equal(metadataPuts.length, 1, `one PUT, got ${JSON.stringify(metadataPuts)}`);
    assert.deepEqual(Object.keys(metadataPuts[0]), ['focalPoint']);
    await marker.waitFor({ state: 'visible' });
    const markerRect = await marker.boundingBox();
    const centre = { x: markerRect.x + markerRect.width / 2, y: markerRect.y + markerRect.height / 2 };
    near(centre.x, target.x, 1.5, 'marker centre x'); near(centre.y, target.y, 1.5, 'marker centre y');
    const under = await page.evaluate(([x, y]) => {
      const element = document.elementFromPoint(x, y);
      return { marker: element?.hasAttribute('data-focal-marker'), inBox: element?.closest('[data-focal-box]') !== null };
    }, [centre.x, centre.y]);
    assert.ok(under.marker || under.inBox, `elementFromPoint at the marker is ${JSON.stringify(under)}`);
    assert.equal(await marker.getAttribute('data-x'), String(focalPoint.x));
    assert.equal(await marker.getAttribute('data-y'), String(focalPoint.y));
    assert.equal(await modal.locator('[data-reset-focal]').isVisible(), true);
    await modal.locator('[data-cancel]').click();
  });

  await check('reopening the library draws the stored point again', async () => {
    await openLibrary('heroImage');
    assert.equal(await marker.isVisible(), false, 'nothing drawn before a selection');
    const rect = await selectUpload();
    await marker.waitFor({ state: 'visible' });
    const markerRect = await marker.boundingBox();
    const expected = pointIn(rect, 30, 20);
    near(markerRect.x + markerRect.width / 2, expected.x, 1.5, 'marker centre x');
    near(markerRect.y + markerRect.height / 2, expected.y, 1.5, 'marker centre y');
    assert.equal(await marker.getAttribute('data-x'), '30');
  });

  await check('Reset focal point clears the stored point and the marker', async () => {
    const putsBefore = metadataPuts.length;
    await modal.locator('[data-reset-focal]').click();
    await waitForMetadata((entry) => !entry || entry.focalPoint === null || entry.focalPoint === undefined, 'the focal point was not cleared');
    assert.deepEqual(metadataPuts.slice(putsBefore), [{ focalPoint: null }]);
    await marker.waitFor({ state: 'hidden' });
    assert.equal(await modal.locator('[data-reset-focal]').isVisible(), false);
    await modal.locator('[data-cancel]').click();
  });

  await check('with imageCrop true, a drag from (10%,10%) to (60%,70%) saves crop {10,10,50,60} and shades it', async () => {
    imageCropOverride = true;
    await openLibrary('heroImage');
    const rect = await selectUpload();
    assert.equal(await panel.getAttribute('data-crop-enabled'), 'true');
    assert.match(await panel.locator('[data-focal-hint]').textContent(), /drag to crop/);
    assert.equal(await cropRect.isVisible(), false, 'no crop stored yet');
    const putsBefore = metadataPuts.length;
    await dragCrop(rect);
    await waitUntil(() => metadataPuts.length > putsBefore, 'no PUT followed the drag');
    const puts = metadataPuts.slice(putsBefore);
    assert.equal(puts.length, 1, `one PUT, got ${JSON.stringify(puts)}`);
    assert.deepEqual(Object.keys(puts[0]), ['crop']);
    const { crop } = puts[0];
    near(crop.x, 10, 0.5, 'crop.x'); near(crop.y, 10, 0.5, 'crop.y');
    near(crop.width, 50, 0.5, 'crop.width'); near(crop.height, 60, 0.5, 'crop.height');
    await waitForMetadata((entry) => entry?.crop && typeof entry.crop.width === 'number', 'no crop was written');
    const stored = photoMetadata().crop;
    near(stored.x, 10, 0.5, 'stored crop.x'); near(stored.width, 50, 0.5, 'stored crop.width');
    await cropRect.waitFor({ state: 'visible' });
    const drawn = await cropRect.boundingBox();
    const expected = { x: rect.x + rect.width * 0.1, y: rect.y + rect.height * 0.1, width: rect.width * 0.5, height: rect.height * 0.6 };
    near(drawn.x, expected.x, 1.5, 'rect left'); near(drawn.y, expected.y, 1.5, 'rect top');
    near(drawn.width, expected.width, 2, 'rect width'); near(drawn.height, expected.height, 2, 'rect height');
    const shade = await cropRect.evaluate((element) => getComputedStyle(element).boxShadow);
    assert.notEqual(shade, 'none', 'the outside of the rectangle is shaded');
    assert.equal(await marker.isVisible(), false, 'a drag sets no focal point');
    assert.equal(await modal.locator('[data-clear-crop]').isVisible(), true);
    if (process.env.FOCAL_SCREENSHOT) await page.screenshot({ path: process.env.FOCAL_SCREENSHOT });
  });

  await check('Clear crop sends crop: null and removes the rectangle', async () => {
    const putsBefore = metadataPuts.length;
    await modal.locator('[data-clear-crop]').click();
    await waitUntil(() => metadataPuts.length > putsBefore, 'no PUT followed Clear crop');
    await page.waitForFunction(() => !document.querySelector('#imageLibraryModal [data-clear-crop]')?.offsetParent);
    assert.deepEqual(metadataPuts.slice(putsBefore), [{ crop: null }]);
    await waitForMetadata((entry) => !entry?.crop, 'the crop was not cleared');
    assert.equal(await cropRect.isVisible(), false);
    await modal.locator('[data-cancel]').click();
  });

  await check('with imageCrop false, the same drag saves nothing and sets no focal point; a click still does', async () => {
    imageCropOverride = false;
    await openLibrary('heroImage');
    const rect = await selectUpload();
    assert.equal(await panel.getAttribute('data-crop-enabled'), 'false');
    assert.doesNotMatch(await panel.locator('[data-focal-hint]').textContent(), /crop/);
    assert.equal(await modal.locator('[data-clear-crop]').isVisible(), false);
    const putsBefore = metadataPuts.length;
    const entryBefore = JSON.stringify(photoMetadata());
    await dragCrop(rect);
    await page.waitForTimeout(400);
    assert.deepEqual(metadataPuts.slice(putsBefore), [], 'no PUT from the drag');
    assert.equal(await cropRect.isVisible(), false);
    assert.equal(await marker.isVisible(), false);
    assert.equal(JSON.stringify(photoMetadata()), entryBefore, 'the file is unchanged');
    // Positive control: a click is still the focal point.
    const target = pointIn(rect, 30, 20);
    await page.mouse.click(target.x, target.y);
    await waitForMetadata((entry) => entry?.focalPoint && typeof entry.focalPoint.x === 'number', 'the click set no focal point');
    near(photoMetadata().focalPoint.x, 30, 0.5, 'focalPoint.x');
    assert.deepEqual(metadataPuts.slice(putsBefore).map((body) => Object.keys(body)), [['focalPoint']]);
    await marker.waitFor({ state: 'visible' });
    await modal.locator('[data-cancel]').click();
  });

  await check('no script errors on the page', () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
